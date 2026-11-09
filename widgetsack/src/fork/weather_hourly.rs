//! Hourly weather sensors (`weather.hour.N.*`, ADR-007) for the forecast widget. Pure seams only:
//! the Open-Meteo mapper lives here, the met.no one next to its parser in `weather_metno.rs`, and
//! both write ids through `push_hour` so the id format exists in exactly one place.
//!
//! N = 0 is the current local hour at poll time, at most `MAX_HOURS` hours, no past hours.

use serde_json::Value;

use crate::sensors::SensorSample;

/// Most hours ever emitted: a longer (misbehaving or proxied) response must not mint unbounded ids.
pub(crate) const MAX_HOURS: usize = 24;

/// Emit one hour: `time` (text) first, then each finite scalar. A missing or non-finite value is
/// skipped rather than zero-filled, so the client can tell "unknown" from "0".
pub(crate) fn push_hour(
    out: &mut Vec<SensorSample>,
    n: usize,
    ts_ms: u64,
    time: &str,
    temp: Option<f64>,
    code: Option<f64>,
    is_day: Option<f64>,
) {
    out.push(SensorSample::text(
        format!("weather.hour.{n}.time"),
        ts_ms,
        time,
    ));
    for (field, v) in [("temp", temp), ("code", code), ("is_day", is_day)] {
        if let Some(v) = v.filter(|v| v.is_finite()) {
            out.push(SensorSample::scalar(
                format!("weather.hour.{n}.{field}"),
                ts_ms,
                v,
            ));
        }
    }
}

/// True for ASCII `YYYY-MM-DDTHH:MM` (digits checked, ranges not).
pub(crate) fn is_local_minute(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 16
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 => *c == b':',
            _ => c.is_ascii_digit(),
        })
}

/// `YYYY-MM-DDTHH:00` for a valid local-minute string: the hour the string falls in.
pub(crate) fn hour_key(s: &str) -> Option<String> {
    is_local_minute(s).then(|| format!("{}:00", &s[..13]))
}

/// Civil `YYYY-MM-DDTHH:MM` from epoch seconds that are ALREADY shifted by the zone offset
/// (Hinnant's `civil_from_days`, the inverse of `days_from_civil` in `weather_metno.rs`).
pub(crate) fn local_minute_text(local_secs: i64) -> String {
    let days = local_secs.div_euclid(86_400);
    let rem = local_secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}",
        rem / 3600,
        rem % 3600 / 60
    )
}

/// Map the Open-Meteo `hourly` block to `weather.hour.N.*`. Slices from the first hour at or after
/// `current.time` truncated to the hour (both are in the location's zone, so a lexicographic compare
/// is a time compare). No usable `current.time` yields nothing; a malformed `time` ends the run.
pub(crate) fn open_meteo_hours(body: &Value, ts_ms: u64) -> Vec<SensorSample> {
    let mut out = Vec::new();
    let Some(start) = body["current"]["time"].as_str().and_then(hour_key) else {
        return out;
    };
    let hourly = &body["hourly"];
    let at = |i: usize| hourly["time"][i].as_str().filter(|t| is_local_minute(t));
    let Some(i0) = (0..)
        .map_while(|i| hourly["time"].get(i).map(|_| i))
        .find(|&i| at(i).is_some_and(|t| t >= start.as_str()))
    else {
        return out;
    };
    for k in 0..MAX_HOURS {
        let i = i0 + k;
        let Some(time) = at(i) else { break };
        let field = |name: &str| hourly[name][i].as_f64();
        push_hour(
            &mut out,
            k,
            ts_ms,
            time,
            field("temperature_2m"),
            field("weather_code"),
            field("is_day"),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn find<'a>(s: &'a [SensorSample], id: &str) -> Option<&'a SensorSample> {
        s.iter().find(|x| x.sensor == id)
    }
    fn val(s: &[SensorSample], id: &str) -> Option<Value> {
        find(s, id).map(|x| serde_json::to_value(x).unwrap()["value"]["value"].clone())
    }

    /// `n` hourly entries from 2026-06-14T00:00, hour h has temp h, code h, is_day 1.
    fn hourly(n: usize) -> Value {
        let time: Vec<String> = (0..n)
            .map(|h| format!("2026-06-{:02}T{:02}:00", 14 + h / 24, h % 24))
            .collect();
        let nums: Vec<usize> = (0..n).collect();
        json!({
            "time": time,
            "temperature_2m": nums,
            "weather_code": nums,
            "is_day": vec![1; n]
        })
    }
    fn body(current: Value, hourly: Value) -> Value {
        json!({ "current": current, "hourly": hourly })
    }

    #[test]
    fn slices_from_the_current_hour_and_spans_midnight() {
        let b = body(json!({ "time": "2026-06-14T07:45" }), hourly(48));
        let s = open_meteo_hours(&b, 9);
        assert_eq!(val(&s, "weather.hour.0.time").unwrap(), "2026-06-14T07:00");
        assert_eq!(val(&s, "weather.hour.0.temp").unwrap(), 7.0);
        assert_eq!(val(&s, "weather.hour.0.is_day").unwrap(), 1.0);
        assert_eq!(val(&s, "weather.hour.23.time").unwrap(), "2026-06-15T06:00");
    }

    #[test]
    fn output_is_capped_at_24_hours() {
        let b = body(json!({ "time": "2026-06-14T00:00" }), hourly(48));
        let s = open_meteo_hours(&b, 1);
        assert!(find(&s, "weather.hour.23.time").is_some());
        assert!(find(&s, "weather.hour.24.time").is_none());
        assert_eq!(
            s.iter().filter(|x| x.sensor.ends_with(".time")).count(),
            MAX_HOURS
        );
    }

    #[test]
    fn short_array_gives_fewer_hours() {
        let b = body(json!({ "time": "2026-06-14T00:00" }), hourly(3));
        let s = open_meteo_hours(&b, 1);
        assert!(find(&s, "weather.hour.2.time").is_some());
        assert!(find(&s, "weather.hour.3.time").is_none());
    }

    #[test]
    fn missing_or_bad_current_time_gives_nothing() {
        assert!(open_meteo_hours(&body(json!({}), hourly(5)), 1).is_empty());
        assert!(open_meteo_hours(&body(json!({ "time": "soon" }), hourly(5)), 1).is_empty());
        assert!(
            open_meteo_hours(&json!({ "current": { "time": "2026-06-14T07:00" } }), 1).is_empty()
        );
    }

    #[test]
    fn current_time_past_the_whole_array_gives_nothing() {
        let b = body(json!({ "time": "2026-06-20T00:00" }), hourly(5));
        assert!(open_meteo_hours(&b, 1).is_empty());
    }

    #[test]
    fn malformed_time_ends_the_run() {
        let mut h = hourly(24);
        h["time"][5] = json!("2026-06-14 05:00");
        let s = open_meteo_hours(&body(json!({ "time": "2026-06-14T00:00" }), h), 1);
        assert!(find(&s, "weather.hour.4.time").is_some());
        assert!(find(&s, "weather.hour.5.time").is_none());
        assert!(find(&s, "weather.hour.6.time").is_none());
    }

    #[test]
    fn missing_null_and_nan_fields_drop_only_that_id() {
        let mut h = hourly(3);
        h["weather_code"] = json!([0, null]); // index 2 missing, index 1 null
        h["temperature_2m"][0] = json!(null);
        h["is_day"] = json!("x");
        let s = open_meteo_hours(&body(json!({ "time": "2026-06-14T00:00" }), h), 1);
        assert!(find(&s, "weather.hour.0.time").is_some());
        assert!(find(&s, "weather.hour.0.temp").is_none());
        assert_eq!(val(&s, "weather.hour.0.code").unwrap(), 0.0);
        assert!(find(&s, "weather.hour.1.code").is_none());
        assert_eq!(val(&s, "weather.hour.1.temp").unwrap(), 1.0);
        assert!(find(&s, "weather.hour.2.code").is_none());
        assert!(find(&s, "weather.hour.2.is_day").is_none());
    }

    #[test]
    fn time_longer_than_the_value_arrays_emits_time_without_temp() {
        let mut h = hourly(4);
        h["temperature_2m"] = json!([0, 1]); // shorter than `time`
        let s = open_meteo_hours(&body(json!({ "time": "2026-06-14T00:00" }), h), 1);
        assert_eq!(val(&s, "weather.hour.3.time").unwrap(), "2026-06-14T03:00");
        assert!(find(&s, "weather.hour.2.temp").is_none());
        assert!(find(&s, "weather.hour.3.temp").is_none());
        assert_eq!(val(&s, "weather.hour.1.temp").unwrap(), 1.0);
    }

    #[test]
    fn non_array_hourly_emits_nothing() {
        let current = json!({ "time": "2026-06-14T00:00" });
        for hourly in [
            json!("x"),
            json!(null),
            json!([1, 2]),
            json!({ "time": "x" }),
        ] {
            assert!(open_meteo_hours(&body(current.clone(), hourly), 1).is_empty());
        }
    }

    #[test]
    fn push_hour_skips_non_finite_values_and_orders_time_first() {
        let mut out = Vec::new();
        push_hour(
            &mut out,
            3,
            5,
            "t",
            Some(f64::NAN),
            Some(2.0),
            Some(f64::INFINITY),
        );
        let ids: Vec<&str> = out.iter().map(|s| s.sensor.as_str()).collect();
        assert_eq!(ids, ["weather.hour.3.time", "weather.hour.3.code"]);
    }

    #[test]
    fn minute_shape_and_hour_key() {
        assert!(is_local_minute("2026-06-14T07:45"));
        assert!(!is_local_minute("2026-06-14T07:45:00"));
        assert!(!is_local_minute("2026-06-14 07:45"));
        assert!(!is_local_minute("2026-06-1xT07:45"));
        assert!(!is_local_minute("2026-06-14T07:4é"));
        assert_eq!(
            hour_key("2026-06-14T07:45").as_deref(),
            Some("2026-06-14T07:00")
        );
        assert_eq!(hour_key("nope"), None);
    }

    #[test]
    fn local_minute_text_cases() {
        assert_eq!(local_minute_text(0), "1970-01-01T00:00");
        // 2028-02-29T23:00 (leap day).
        assert_eq!(
            local_minute_text(21_243 * 86_400 + 23 * 3600),
            "2028-02-29T23:00"
        );
        // Year rollover: 2026-12-31T23:30 + 30 min.
        let ny = 20_819 * 86_400; // 2027-01-01T00:00
        assert_eq!(local_minute_text(ny), "2027-01-01T00:00");
        assert_eq!(local_minute_text(ny - 1800), "2026-12-31T23:30");
        // Negative offset crossing midnight: 2026-11-08T02:00Z at UTC-5 is 2026-11-07T21:00.
        let utc = 20_765 * 86_400 + 2 * 3600; // 2026-11-08T02:00Z
        assert_eq!(local_minute_text(utc - 5 * 3600), "2026-11-07T21:00");
        // Before the epoch.
        assert_eq!(local_minute_text(-1), "1969-12-31T23:59");
    }
}
