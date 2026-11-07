//! met.no (MET Norway Locationforecast 2.0) provider for the Weather plugin — fork-only.
//!
//! Keyless like Open-Meteo, but met.no REQUIRES an identifying User-Agent (403 otherwise), asks for
//! coordinates rounded to 4 decimals, and publishes an `Expires` header that polling must respect.
//! The compact body is an instant-values timeseries (hourly, then 6-hourly), so the daily high/low
//! and the day symbol are aggregated here. Everything that decides something is a pure seam
//! (`metno_url`, `metno_to_samples`, `aggregate_days`, `symbol_to_wmo`, the date parsers) and is
//! tested against `test-data/metno-compact.json` without network. Output uses the same `weather.*`
//! ids as Open-Meteo, minus the ones met.no cannot supply (apparent, uv, sun.*, air.*): no fabrication.
//! See docs/decisions/001-weather-provider-metno.md.

use std::time::Duration;

use serde_json::Value;

use crate::sensors::SensorSample;

/// met.no rejects a missing/generic User-Agent. Compile-time constant, no user data.
pub const USER_AGENT: &str = concat!(
    "widgetsack-fork/",
    env!("CARGO_PKG_VERSION"),
    " github.com/ixoid/widgetsack"
);

/// Most timeseries entries read from a body (a compact response has ~90).
const MAX_ENTRIES: usize = 400;
/// Most `weather.day.N.*` ids ever emitted (day 0 = today).
const MAX_DAYS: usize = 7;
/// Largest body accepted (same cap as the Open-Meteo path; the real one is ~100 KB).
const MAX_BODY: usize = 8 * 1024 * 1024;

/// The compact-forecast URL. Coordinates are clamped, non-finite becomes 0.0, and they are printed
/// with exactly 4 decimals (met.no redirects/rejects over-precise ones). Never prints "-0.0000".
pub fn metno_url(lat: f64, lon: f64) -> String {
    format!(
        "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={}&lon={}",
        coord(lat, 90.0),
        coord(lon, 180.0)
    )
}

fn coord(v: f64, limit: f64) -> String {
    let v = if v.is_finite() { v } else { 0.0 };
    let s = format!("{:.4}", v.clamp(-limit, limit));
    if s == "-0.0000" {
        "0.0000".to_string()
    } else {
        s
    }
}

/// A client that identifies itself (met.no ToS) with a 10 s timeout.
pub fn metno_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())
}

/// GET `url`, returning the JSON body plus how long met.no says it stays fresh (`Expires` - `Date`).
/// Same status check, 8 MiB cap and URL-stripping error text as the Open-Meteo fetch.
pub async fn fetch(
    client: &reqwest::Client,
    url: &str,
) -> Result<(Value, Option<Duration>), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(crate::http_response::request_error)?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let header = |name: &str| {
        resp.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let fresh = fresh_for(header("expires").as_deref(), header("date").as_deref());
    let body = crate::http_response::read_json(resp, MAX_BODY).await?;
    Ok((body, fresh))
}

// ---- time ----

/// Days since 1970-01-01 of a proleptic Gregorian civil date (Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

fn num(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn epoch_from_parts(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> Option<i64> {
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo) || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s)
}

/// `YYYY-MM-DDTHH:MM:SSZ` -> epoch seconds. Anything else (offsets, fractions, garbage) -> None.
fn parse_rfc3339_utc(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if !s.is_ascii()
        || b.len() != 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'Z'
    {
        return None;
    }
    epoch_from_parts(
        num(&s[0..4])?,
        num(&s[5..7])?,
        num(&s[8..10])?,
        num(&s[11..13])?,
        num(&s[14..16])?,
        num(&s[17..19])?,
    )
}

/// IMF-fixdate `Sat, 07 Nov 2026 16:23:45 GMT` -> epoch seconds.
fn parse_http_date(s: &str) -> Option<i64> {
    if !s.is_ascii() {
        return None;
    }
    let (_, rest) = s.split_once(", ")?;
    let mut it = rest.split(' ');
    let day = num(it.next()?)?;
    let name = it.next()?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|m| *m == name)? as i64
        + 1;
    let year = num(it.next()?)?;
    let time = it.next()?;
    if it.next()? != "GMT" || it.next().is_some() {
        return None;
    }
    let mut t = time.split(':');
    let (h, mi, sec) = (num(t.next()?)?, num(t.next()?)?, num(t.next()?)?);
    if t.next().is_some() {
        return None;
    }
    epoch_from_parts(year, month, day, h, mi, sec)
}

/// How long the response stays fresh: `Expires` minus `Date`. None if either is missing,
/// unparseable, or the difference is not positive.
fn fresh_for(expires: Option<&str>, date: Option<&str>) -> Option<Duration> {
    let diff = parse_http_date(expires?)? - parse_http_date(date?)?;
    u64::try_from(diff)
        .ok()
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
}

/// UTC offset (seconds east) from Win32 `TIME_ZONE_INFORMATION` fields: biases are minutes WEST of
/// UTC. `id`: 0 unknown / 1 standard / 2 daylight / anything else (invalid) -> 0.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn offset_from_tz(id: u32, bias: i32, standard_bias: i32, daylight_bias: i32) -> i64 {
    let extra = match id {
        1 => standard_bias,
        2 => daylight_bias,
        0 => 0,
        _ => return 0,
    };
    -(i64::from(bias) + i64::from(extra)) * 60
}

/// The PC's current UTC offset in seconds (DST included). 0 on failure.
#[cfg(target_os = "windows")]
pub fn local_utc_offset_secs() -> i64 {
    use windows::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
    let mut tzi = TIME_ZONE_INFORMATION::default();
    // SAFETY: `tzi` is a valid owned struct the call fills in.
    let id = unsafe { GetTimeZoneInformation(&mut tzi) };
    offset_from_tz(id, tzi.Bias, tzi.StandardBias, tzi.DaylightBias)
}

/// Off-Windows there is no Win32 call; day grouping falls back to UTC.
#[cfg(not(target_os = "windows"))]
pub fn local_utc_offset_secs() -> i64 {
    0
}

// ---- symbols ----

/// met.no `symbol_code` -> the WMO code the client's `weatherInfo` handles. `_day|_night|
/// _polartwilight` is stripped first. Lossy by design: WMO has no sleet-showers code, so those map to
/// 66/67 like plain sleet. met.no really spells two families with a double s (`lightssleetandthunder`,
/// `lightssnowandthunder`, and their showers variants), so both spellings are listed.
pub(crate) fn symbol_to_wmo(symbol: &str) -> Option<u8> {
    Some(match base_symbol(symbol) {
        "clearsky" => 0,
        "fair" => 1,
        "partlycloudy" => 2,
        "cloudy" => 3,
        "fog" => 45,
        "lightrain" => 61,
        "rain" => 63,
        "heavyrain" => 65,
        "lightrainshowers" => 80,
        "rainshowers" => 81,
        "heavyrainshowers" => 82,
        "lightsleet" | "lightsleetshowers" | "lightssleetshowers" => 66,
        "sleet" | "heavysleet" | "sleetshowers" | "heavysleetshowers" => 67,
        "lightsnow" => 71,
        "snow" => 73,
        "heavysnow" => 75,
        "lightsnowshowers" | "snowshowers" => 85,
        "heavysnowshowers" => 86,
        "lightrainandthunder"
        | "rainandthunder"
        | "lightrainshowersandthunder"
        | "rainshowersandthunder"
        | "lightsleetandthunder"
        | "lightssleetandthunder"
        | "sleetandthunder"
        | "lightsleetshowersandthunder"
        | "lightssleetshowersandthunder"
        | "sleetshowersandthunder"
        | "lightsnowandthunder"
        | "lightssnowandthunder"
        | "snowandthunder"
        | "lightsnowshowersandthunder"
        | "lightssnowshowersandthunder"
        | "snowshowersandthunder" => 95,
        "heavyrainandthunder"
        | "heavyrainshowersandthunder"
        | "heavysleetandthunder"
        | "heavysleetshowersandthunder"
        | "heavysnowandthunder"
        | "heavysnowshowersandthunder" => 96,
        _ => return None,
    })
}

fn base_symbol(symbol: &str) -> &str {
    for suffix in ["_day", "_night", "_polartwilight"] {
        if let Some(b) = symbol.strip_suffix(suffix) {
            return b;
        }
    }
    symbol
}

/// 1 for `_day`, 0 for `_night`/`_polartwilight`, None when unsuffixed.
fn day_flag(symbol: &str) -> Option<f64> {
    if symbol.ends_with("_day") {
        Some(1.0)
    } else if symbol.ends_with("_night") || symbol.ends_with("_polartwilight") {
        Some(0.0)
    } else {
        None
    }
}

// ---- aggregation ----

/// One timeseries entry that has a parseable time.
struct Entry<'a> {
    secs: i64,
    details: &'a Value,
    sym1: Option<&'a str>,
    sym6: Option<&'a str>,
    sym12: Option<&'a str>,
}

impl Entry<'_> {
    fn temp(&self) -> Option<f64> {
        self.details["air_temperature"]
            .as_f64()
            .filter(|t| t.is_finite())
    }
    /// The symbol that describes "now" for the first entry.
    fn current_symbol(&self) -> Option<&str> {
        self.sym1.or(self.sym6)
    }
    /// Any symbol this entry carries, for the is_day neighbour lookup.
    fn any_symbol(&self) -> Option<&str> {
        self.sym1.or(self.sym6).or(self.sym12)
    }
}

/// One forecast day (Celsius), `index` 0 = the day containing "now" in the chosen offset.
#[derive(Debug, PartialEq)]
struct Day {
    index: usize,
    high: Option<f64>,
    low: Option<f64>,
    code: Option<u8>,
}

fn parse_entries(body: &Value) -> Vec<Entry<'_>> {
    let Some(series) = body["properties"]["timeseries"].as_array() else {
        return Vec::new();
    };
    series
        .iter()
        .take(MAX_ENTRIES)
        .filter_map(|e| {
            let secs = parse_rfc3339_utc(e["time"].as_str()?)?;
            let data = &e["data"];
            let sym = |k: &str| data[k]["summary"]["symbol_code"].as_str();
            Some(Entry {
                secs,
                details: &data["instant"]["details"],
                sym1: sym("next_1_hours"),
                sym6: sym("next_6_hours"),
                sym12: sym("next_12_hours"),
            })
        })
        .collect()
}

fn local_day(secs: i64, offset: i64) -> i64 {
    (secs + offset).div_euclid(86_400)
}

/// Group entries into at most 7 local days. Day index = local day of the entry minus the local day of
/// `now_secs`; earlier days are dropped (a body fetched before midnight, mapped after it). High/low
/// come from the instant temperatures; the code from the entry nearest local 12:00 that has a known
/// symbol (prefers `next_6_hours`, then `next_1_hours`, then `next_12_hours`); the earlier entry wins
/// a tie.
fn aggregate_days(entries: &[Entry<'_>], utc_offset_secs: i64, now_secs: i64) -> Vec<Day> {
    let today = local_day(now_secs, utc_offset_secs);
    let mut days: Vec<(Day, i64)> = Vec::new(); // (day, best distance to noon)
    for e in entries {
        let Ok(index) = usize::try_from(local_day(e.secs, utc_offset_secs) - today) else {
            continue;
        };
        if index >= MAX_DAYS {
            continue;
        }
        let pos = match days.iter().position(|(d, _)| d.index == index) {
            Some(p) => p,
            None => {
                days.push((
                    Day {
                        index,
                        high: None,
                        low: None,
                        code: None,
                    },
                    i64::MAX,
                ));
                days.len() - 1
            }
        };
        let (day, best) = &mut days[pos];
        if let Some(t) = e.temp() {
            day.high = Some(day.high.map_or(t, |h| h.max(t)));
            day.low = Some(day.low.map_or(t, |l| l.min(t)));
        }
        let secs_of_day = (e.secs + utc_offset_secs).rem_euclid(86_400);
        let dist = (secs_of_day - 12 * 3600).abs();
        if dist < *best {
            let code = e.sym6.or(e.sym1).or(e.sym12).and_then(symbol_to_wmo);
            if code.is_some() {
                day.code = code;
                *best = dist;
            }
        }
    }
    let mut out: Vec<Day> = days.into_iter().map(|(d, _)| d).collect();
    out.sort_by_key(|d| d.index);
    out
}

/// Longest gap to a suffixed neighbour that still tells us whether it is day now. Unsuffixed symbols
/// (cloudy, rain, fog...) come in long runs, so the next `_day`/`_night` entry may lie past a
/// sunrise/sunset; beyond this window we omit `weather.is_day` rather than guess wrong.
const IS_DAY_NEIGHBOUR_SECS: i64 = 3 * 3600;

/// `weather.is_day` for the first entry: its own symbol suffix, else the nearest suffixed entry
/// ahead within `IS_DAY_NEIGHBOUR_SECS` (the series only runs forward, nothing is behind the first).
fn is_day_for(entries: &[Entry<'_>]) -> Option<f64> {
    let first = entries.first()?;
    first.current_symbol().and_then(day_flag).or_else(|| {
        entries[1..]
            .iter()
            .take_while(|e| e.secs - first.secs <= IS_DAY_NEIGHBOUR_SECS)
            .find_map(|e| e.any_symbol().and_then(day_flag))
    })
}

/// Map a met.no compact body to `weather.*` samples. Pure. `unit_letter` is "C" or "F"; `ts_ms` is
/// the poll time (also anchors "today"); `utc_offset_secs` is the zone used to cut days. A malformed
/// body yields an empty Vec; a missing/non-finite field is skipped, never zero-filled.
pub fn metno_to_samples(
    body: &Value,
    unit_letter: &str,
    ts_ms: u64,
    utc_offset_secs: i64,
) -> Vec<SensorSample> {
    let entries = parse_entries(body);
    let Some(first) = entries.first() else {
        return Vec::new();
    };
    if !first.details.is_object() {
        return Vec::new();
    }
    let fahrenheit = unit_letter == "F";
    let temp = |c: f64| if fahrenheit { c * 9.0 / 5.0 + 32.0 } else { c };
    let wind_factor = if fahrenheit { 2.23694 } else { 3.6 };

    let mut out = vec![SensorSample::text("weather.unit", ts_ms, unit_letter)];
    let mut scalar = |id: &str, v: Option<f64>| {
        if let Some(n) = v.filter(|n| n.is_finite()) {
            out.push(SensorSample::scalar(id.to_string(), ts_ms, n));
        }
    };
    let d = first.details;
    scalar("weather.temp", d["air_temperature"].as_f64().map(temp));
    scalar("weather.humidity", d["relative_humidity"].as_f64());
    scalar(
        "weather.wind",
        d["wind_speed"].as_f64().map(|w| w * wind_factor),
    );
    scalar(
        "weather.code",
        first
            .current_symbol()
            .and_then(symbol_to_wmo)
            .map(f64::from),
    );
    scalar("weather.is_day", is_day_for(&entries));

    let days = aggregate_days(&entries, utc_offset_secs, (ts_ms / 1000) as i64);
    if let Some(today) = days.iter().find(|d| d.index == 0) {
        scalar("weather.high", today.high.map(temp));
        scalar("weather.low", today.low.map(temp));
    }
    for day in &days {
        let i = day.index;
        scalar(&format!("weather.day.{i}.high"), day.high.map(temp));
        scalar(&format!("weather.day.{i}.low"), day.low.map(temp));
        scalar(&format!("weather.day.{i}.code"), day.code.map(f64::from));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE: &str = include_str!("../../test-data/metno-compact.json");
    /// The fixture's first entry, 2026-11-07T15:00:00Z (= 18:00 MSK), is the poll time in tests.
    const POLL_MS: u64 = 1_794_063_600_000;
    const MSK: i64 = 10_800;

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }
    fn val(s: &[SensorSample], id: &str) -> Option<Value> {
        s.iter()
            .find(|x| x.sensor == id)
            .map(|x| serde_json::to_value(x).unwrap()["value"]["value"].clone())
    }
    fn num_of(s: &[SensorSample], id: &str) -> f64 {
        val(s, id)
            .unwrap_or_else(|| panic!("missing {id}"))
            .as_f64()
            .unwrap()
    }
    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "{a} != {b}");
    }

    #[test]
    fn poll_constant_matches_first_fixture_entry() {
        let b = fixture();
        let t = parse_rfc3339_utc(b["properties"]["timeseries"][0]["time"].as_str().unwrap());
        assert_eq!(t, Some((POLL_MS / 1000) as i64));
    }

    #[test]
    fn url_rounds_to_four_decimals_and_clamps() {
        assert_eq!(
            metno_url(51.50735, -0.12776),
            "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=51.5074&lon=-0.1278"
        );
        assert!(metno_url(-33.8688, 151.2093).ends_with("lat=-33.8688&lon=151.2093"));
        assert!(metno_url(f64::NAN, f64::INFINITY).ends_with("lat=0.0000&lon=0.0000"));
        assert!(metno_url(123.0, -400.0).ends_with("lat=90.0000&lon=-180.0000"));
        assert!(metno_url(-0.00001, -0.0).ends_with("lat=0.0000&lon=0.0000"));
    }

    #[test]
    fn user_agent_identifies_the_fork_and_client_builds() {
        assert!(USER_AGENT.starts_with("widgetsack-fork/"));
        assert!(USER_AGENT.contains("github.com/ixoid/widgetsack"));
        assert!(metno_client().is_ok());
    }

    #[test]
    fn fixture_celsius_current_conditions() {
        let s = metno_to_samples(&fixture(), "C", POLL_MS, 0);
        assert_eq!(val(&s, "weather.unit").unwrap(), "C");
        close(num_of(&s, "weather.temp"), -0.1);
        close(num_of(&s, "weather.humidity"), 83.6);
        close(num_of(&s, "weather.wind"), 2.9 * 3.6);
        assert_eq!(num_of(&s, "weather.code"), 3.0); // cloudy
        // Unsuffixed "cloudy" with no suffixed entry within 3 h: omitted, not guessed.
        assert!(val(&s, "weather.is_day").is_none());
        // high/low are day 0.
        close(num_of(&s, "weather.high"), num_of(&s, "weather.day.0.high"));
        close(num_of(&s, "weather.low"), num_of(&s, "weather.day.0.low"));
        close(num_of(&s, "weather.high"), 0.6);
        assert!(num_of(&s, "weather.day.6.high").is_finite());
        assert!(val(&s, "weather.day.7.high").is_none());
    }

    #[test]
    fn fixture_never_emits_openmeteo_only_ids() {
        let s = metno_to_samples(&fixture(), "C", POLL_MS, MSK);
        for x in &s {
            let id = x.sensor.as_str();
            assert!(
                !(id == "weather.apparent"
                    || id == "weather.uv"
                    || id.starts_with("weather.sun.")
                    || id.starts_with("weather.air.")),
                "unexpected {id}"
            );
        }
    }

    #[test]
    fn fixture_fahrenheit_converts_temps_and_wind() {
        let c = metno_to_samples(&fixture(), "C", POLL_MS, MSK);
        let f = metno_to_samples(&fixture(), "F", POLL_MS, MSK);
        assert_eq!(val(&f, "weather.unit").unwrap(), "F");
        for id in [
            "weather.temp",
            "weather.high",
            "weather.low",
            "weather.day.1.high",
            "weather.day.3.low",
        ] {
            close(num_of(&f, id), num_of(&c, id) * 9.0 / 5.0 + 32.0);
        }
        close(num_of(&f, "weather.wind"), 2.9 * 2.23694);
        close(
            num_of(&f, "weather.humidity"),
            num_of(&c, "weather.humidity"),
        );
        assert_eq!(
            num_of(&f, "weather.day.1.code"),
            num_of(&c, "weather.day.1.code")
        );
    }

    #[test]
    fn day_cut_follows_the_offset_seam() {
        let utc = metno_to_samples(&fixture(), "C", POLL_MS, 0);
        let msk = metno_to_samples(&fixture(), "C", POLL_MS, MSK);
        // Measured numbers from the architecture decision (Nov 8 = day 1).
        close(num_of(&utc, "weather.day.1.high"), 4.2);
        close(num_of(&utc, "weather.day.1.low"), 0.8);
        close(num_of(&msk, "weather.day.1.high"), 4.0);
        close(num_of(&msk, "weather.day.1.low"), 0.4);
        close(num_of(&utc, "weather.high"), 0.6);
        close(num_of(&msk, "weather.high"), 0.3);
        close(num_of(&msk, "weather.low"), -0.1);
    }

    #[test]
    fn fixture_day_codes_are_known_wmo_codes() {
        let s = metno_to_samples(&fixture(), "C", POLL_MS, MSK);
        for i in 0..7 {
            let c = num_of(&s, &format!("weather.day.{i}.code"));
            assert!(symbol_set().contains(&(c as u8)), "day {i} code {c}");
        }
    }

    fn symbol_set() -> [u8; 28] {
        [
            0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82,
            85, 86, 95, 96, 99,
        ]
    }

    /// Entries at the given UTC hours of 2026-11-07 (+ day offsets via hours >= 24), each with a
    /// temperature and a `next_1_hours` symbol.
    fn body_at(points: &[(i64, f64, &str)]) -> Value {
        let base = days_from_civil(2026, 11, 7) * 86_400;
        let series: Vec<Value> = points
            .iter()
            .map(|(h, t, sym)| {
                let secs = base + h * 3600;
                let day = secs.div_euclid(86_400) - days_from_civil(2026, 11, 1);
                let hh = secs.rem_euclid(86_400) / 3600;
                json!({
                    "time": format!("2026-11-{:02}T{:02}:00:00Z", day + 1, hh),
                    "data": {
                        "instant": { "details": { "air_temperature": t } },
                        "next_1_hours": { "summary": { "symbol_code": sym } }
                    }
                })
            })
            .collect();
        json!({ "properties": { "timeseries": series } })
    }

    fn days_of(body: &Value, offset: i64, now: i64) -> Vec<Day> {
        aggregate_days(&parse_entries(body), offset, now)
    }

    #[test]
    fn partial_last_day_gives_fewer_days_and_extra_days_are_capped() {
        let now = days_from_civil(2026, 11, 7) * 86_400 + 12 * 3600;
        let b = body_at(&[(12, 1.0, "cloudy"), (30, 2.0, "cloudy")]);
        assert_eq!(days_of(&b, 0, now).len(), 2);
        let many: Vec<(i64, f64, &str)> =
            (0..10).map(|d| (12 + d * 24, d as f64, "fair")).collect();
        let days = days_of(&body_at(&many), 0, now);
        assert_eq!(days.len(), 7);
        assert_eq!(days.last().unwrap().index, 6);
    }

    #[test]
    fn day_index_is_relative_to_now_and_drops_yesterday() {
        // Body starts 22:00 on Nov 7 (UTC); "now" is 23:30 on Nov 7 -> day 0 = Nov 7.
        let b = body_at(&[
            (22, 1.0, "cloudy"),
            (23, 2.0, "cloudy"),
            (24, 3.0, "cloudy"),
        ]);
        let before = days_from_civil(2026, 11, 7) * 86_400 + 23 * 3600 + 1800;
        let d = days_of(&b, 0, before);
        assert_eq!((d[0].index, d[0].high), (0, Some(2.0)));
        assert_eq!((d[1].index, d[1].high), (1, Some(3.0)));
        // The same body mapped after midnight: Nov 7 entries are yesterday, dropped.
        let after = before + 3600;
        let d = days_of(&b, 0, after);
        assert_eq!(d.len(), 1);
        assert_eq!((d[0].index, d[0].high), (0, Some(3.0)));
    }

    #[test]
    fn negative_offset_floors_days_correctly() {
        // 02:00Z at UTC-5 is 21:00 the previous local day.
        let now = days_from_civil(2026, 11, 7) * 86_400;
        let b = body_at(&[(2, 5.0, "fair"), (20, 9.0, "fair")]);
        let d = days_of(&b, -5 * 3600, now);
        // now = Nov 6 19:00 local; the 02:00Z entry is Nov 6 21:00 local (day 0), 20:00Z is Nov 7 (day 1).
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].index, d[0].high), (0, Some(5.0)));
        assert_eq!((d[1].index, d[1].high), (1, Some(9.0)));
    }

    #[test]
    fn day_code_prefers_the_entry_nearest_noon() {
        let now = days_from_civil(2026, 11, 7) * 86_400;
        let b = body_at(&[(6, 1.0, "rain"), (11, 1.0, "fair_day"), (20, 1.0, "snow")]);
        assert_eq!(days_of(&b, 0, now)[0].code, Some(1));
    }

    #[test]
    fn is_day_suffix_cases() {
        let one = |sym: &str| {
            let b = body_at(&[(10, 1.0, sym), (11, 1.0, "cloudy")]);
            let s = metno_to_samples(
                &b,
                "C",
                (days_from_civil(2026, 11, 7) * 86_400 + 36_000) as u64 * 1000,
                0,
            );
            val(&s, "weather.is_day").map(|v| v.as_f64().unwrap())
        };
        assert_eq!(one("fair_day"), Some(1.0));
        assert_eq!(one("fair_night"), Some(0.0));
        assert_eq!(one("fair_polartwilight"), Some(0.0));
        // Unsuffixed first symbol and no suffixed neighbour -> omitted.
        assert_eq!(one("cloudy"), None);
        // Unsuffixed first symbol borrows the next suffixed entry.
        let b = body_at(&[(10, 1.0, "cloudy"), (11, 1.0, "fair_day")]);
        let s = metno_to_samples(&b, "C", 0, 0);
        assert_eq!(num_of(&s, "weather.is_day"), 1.0);
    }

    #[test]
    fn malformed_bodies_yield_nothing_and_do_not_panic() {
        for b in [
            json!({}),
            json!({ "properties": {} }),
            json!({ "properties": { "timeseries": [] } }),
            json!({ "properties": { "timeseries": "x" } }),
            json!({ "properties": { "timeseries": [ { "time": "2026-11-07T15:00:00Z", "data": {} } ] } }),
            json!({ "properties": { "timeseries": [ { "time": "garbage", "data": {} } ] } }),
            json!([1, 2, 3]),
        ] {
            assert!(metno_to_samples(&b, "C", POLL_MS, 0).is_empty(), "{b}");
        }
        // String where a number is expected: skipped, no zero fill; unit still rides along.
        let b = json!({ "properties": { "timeseries": [ { "time": "2026-11-07T15:00:00Z",
            "data": { "instant": { "details": { "air_temperature": "warm", "wind_speed": null } } } } ] } });
        let s = metno_to_samples(&b, "C", POLL_MS, 0);
        assert_eq!(s.len(), 1);
        assert_eq!(val(&s, "weather.unit").unwrap(), "C");
    }

    #[test]
    fn entries_are_capped() {
        let series: Vec<Value> = (0..1000)
            .map(|i| {
                json!({ "time": format!("2026-11-07T{:02}:00:00Z", i % 24),
                    "data": { "instant": { "details": {} } } })
            })
            .collect();
        let b = json!({ "properties": { "timeseries": series } });
        assert_eq!(parse_entries(&b).len(), MAX_ENTRIES);
    }

    #[test]
    fn symbol_table_spot_checks() {
        // Spot checks, including the spellings and families the legend really uses.
        for (s, c) in [
            ("clearsky_day", 0),
            ("fair_night", 1),
            ("partlycloudy_polartwilight", 2),
            ("cloudy", 3),
            ("fog", 45),
            ("lightrain", 61),
            ("rain", 63),
            ("heavyrain", 65),
            ("lightrainshowers_day", 80),
            ("rainshowers_night", 81),
            ("heavyrainshowers_day", 82),
            ("lightsleet", 66),
            ("sleet", 67),
            ("heavysleet", 67),
            ("lightsleetshowers_day", 66),
            ("sleetshowers_night", 67),
            ("lightsnow", 71),
            ("snow", 73),
            ("heavysnow", 75),
            ("lightsnowshowers_day", 85),
            ("snowshowers_night", 85),
            ("heavysnowshowers_day", 86),
            ("rainandthunder", 95),
            ("heavyrainandthunder", 96),
            ("lightrainshowersandthunder_day", 95),
            ("heavyrainshowersandthunder_night", 96),
            ("lightssleetandthunder", 95),
            ("lightssnowandthunder", 95),
            ("lightssleetshowersandthunder_day", 95),
            ("lightssnowshowersandthunder_night", 95),
            ("heavysleetandthunder", 96),
            ("heavysnowshowersandthunder_day", 96),
        ] {
            assert_eq!(symbol_to_wmo(s), Some(c), "{s}");
        }
        assert_eq!(symbol_to_wmo("banana"), None);
        assert_eq!(symbol_to_wmo(""), None);
    }

    #[test]
    fn every_legend_symbol_is_mapped() {
        // The full met.no legend (bases), including the two double-s families. All must map.
        let legend = "clearsky fair partlycloudy cloudy fog lightrain rain heavyrain \
            lightrainshowers rainshowers heavyrainshowers lightrainandthunder rainandthunder \
            heavyrainandthunder lightrainshowersandthunder rainshowersandthunder \
            heavyrainshowersandthunder lightsleet sleet heavysleet lightsleetshowers sleetshowers \
            heavysleetshowers lightssleetandthunder sleetandthunder heavysleetandthunder \
            lightssleetshowersandthunder sleetshowersandthunder heavysleetshowersandthunder \
            lightsnow snow heavysnow lightsnowshowers snowshowers heavysnowshowers \
            lightssnowandthunder snowandthunder heavysnowandthunder lightssnowshowersandthunder \
            snowshowersandthunder heavysnowshowersandthunder";
        for b in legend.split_whitespace() {
            let c = symbol_to_wmo(b).unwrap_or_else(|| panic!("{b} unmapped"));
            assert!(symbol_set().contains(&c), "{b} -> {c}");
        }
    }

    #[test]
    fn fixture_symbols_all_map() {
        for s in [
            "cloudy",
            "clearsky_night",
            "partlycloudy_night",
            "rain",
            "fair_night",
            "lightrain",
            "partlycloudy_day",
            "lightsleet",
        ] {
            assert!(symbol_to_wmo(s).is_some(), "{s}");
        }
    }

    #[test]
    fn rfc3339_parser() {
        assert_eq!(parse_rfc3339_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_utc("2026-11-07T15:00:00Z"),
            Some(1_794_063_600)
        );
        assert_eq!(
            parse_rfc3339_utc("2024-02-29T12:00:00Z"),
            Some(1_709_208_000)
        );
        assert_eq!(parse_rfc3339_utc("2026-02-29T12:00:00Z"), None);
        assert_eq!(parse_rfc3339_utc("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_rfc3339_utc("2026-11-07T24:00:00Z"), None);
        assert_eq!(parse_rfc3339_utc("2026-11-07T15:00:00+03:00"), None);
        assert_eq!(parse_rfc3339_utc("2026-11-07 15:00:00Z"), None);
        assert_eq!(parse_rfc3339_utc("2026-11-07T15:00:0éZ"), None);
        assert_eq!(parse_rfc3339_utc(""), None);
        assert_eq!(parse_rfc3339_utc("garbage"), None);
    }

    #[test]
    fn http_date_parser_and_freshness() {
        assert_eq!(
            parse_http_date("Sat, 07 Nov 2026 15:00:00 GMT"),
            Some(1_794_063_600)
        );
        assert_eq!(parse_http_date("Sat, 07 Foo 2026 15:00:00 GMT"), None);
        assert_eq!(parse_http_date("Sat, 07 Nov 2026 15:00:00 UTC"), None);
        assert_eq!(parse_http_date("Sat, 31 Feb 2026 15:00:00 GMT"), None);
        assert_eq!(parse_http_date("garbage"), None);
        assert_eq!(parse_http_date(""), None);

        let d = "Sat, 07 Nov 2026 16:23:45 GMT";
        assert_eq!(
            fresh_for(Some("Sat, 07 Nov 2026 16:33:45 GMT"), Some(d)),
            Some(Duration::from_secs(600))
        );
        assert_eq!(fresh_for(Some(d), Some(d)), None);
        assert_eq!(
            fresh_for(Some("Sat, 07 Nov 2026 16:00:00 GMT"), Some(d)),
            None
        );
        assert_eq!(fresh_for(None, Some(d)), None);
        assert_eq!(fresh_for(Some(d), None), None);
        assert_eq!(fresh_for(Some("nope"), Some(d)), None);
    }

    #[test]
    fn tz_offset_math() {
        assert_eq!(offset_from_tz(0, -180, 0, -60), 10_800); // MSK, no DST
        assert_eq!(offset_from_tz(1, 300, 0, -60), -18_000); // US east, standard
        assert_eq!(offset_from_tz(2, 300, 0, -60), -14_400); // US east, daylight
        assert_eq!(offset_from_tz(0xFFFF_FFFF, -180, 0, -60), 0);
    }

    #[test]
    fn local_offset_is_a_sane_zone() {
        assert!(local_utc_offset_secs().abs() <= 14 * 3600);
    }
}
