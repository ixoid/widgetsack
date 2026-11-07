# ADR-001: met.no as a second weather provider

- **Status:** Accepted (provider switch). Day-grouping and partial-day-0 rules: **decided by the owner 2026-11-07** (see "Open rules").
- **Date:** 2026-11-07
- **Deciders:** owner (provider choice, 2026-11-07); architect (shape); owner (open rules, decided 2026-11-07)

## Context
The upstream Weather plugin (`widgetsack/src/weather.rs`) talks only to Open-Meteo. From the owner's
network `api.open-meteo.com` (Hetzner, 157.90.83.168) times out at TCP connect (15 s), so every
`weather.*` widget is blank. `api.met.no` answers the Locationforecast 2.0 `compact` request with
HTTP 200 in 1.2 s (measured 2026-11-07). Constraints: no new crate, Open-Meteo behaviour unchanged
(upstream parity), new code under `widgetsack/src/fork/`, the frontend `weather.*` contract unchanged.

## Options considered
1. **Keep Open-Meteo only** - zero code; the widget stays dead on this network.
2. **Proxy Open-Meteo through the owner's VPS** - no mapper work; adds an operated service and a
   single point of failure outside this repo.
3. **A keyed provider (OpenWeatherMap, WeatherAPI)** - richer data; needs an API key in
   `secure_config`, signup, quotas.
4. **met.no Locationforecast 2.0 `compact`** - keyless, reachable, free, well documented; metric only,
   no feels-like / UV / sunrise / air quality in this product, series starts at "now", hourly for ~2.5
   days then 6-hourly.

## Decision
Option 4, behind a user-selectable `provider` field, Open-Meteo stays the default.
- `WeatherConfig.provider: String` with `#[serde(default = "default_provider")]` = `"open-meteo"`.
  A String, not an enum: a hand-edited unknown value must not fail the whole `plugins/weather.json`
  parse (an enum would make `load_weather_config` return Err). `normalize_provider` maps anything
  but `"met-no"` to `"open-meteo"`.
- New module `widgetsack/src/fork/weather_metno.rs` (URL builder, client with User-Agent, fetch with
  Expires, pure `metno_to_samples`, symbol to WMO table). `weather.rs` gets only the field, the
  normalisation and one provider branch in `run_weather_client`.
- met.no output is mapped onto the SAME `weather.*` sensor ids, so no meter changes.

### met.no Terms of Service obligations (api.met.no/doc/TermsOfService)
- **Identifying User-Agent** on every request: compile-time constant
  `widgetsack-fork/<CARGO_PKG_VERSION> github.com/ixoid/widgetsack`. met.no answers 403 to a missing
  or generic UA, so this is functional, not cosmetic. The shared `http_client()` sets no UA and is
  left untouched; met.no gets its own client. If the GitHub repo is private the URL is not a usable
  contact; the owner can swap in another public contact (never an address committed by accident).
- **At most 4 decimals in coordinates** (`{:.4}`, about 11 m). More precision is redirected and
  defeats their cache.
- **Honour `Expires`**: after a successful met.no fetch the next poll waits
  `max(poll interval, Expires - Date)`, capped at 6 h. Both headers come from the server, so local
  clock skew does not matter. `If-Modified-Since` is not used: Expires-gating already prevents
  requests before new data exists; IMS would only save the ~60-100 KB body.
- **Rate**: one request per poll, poll floor 300 s, demand-gated - far below the 20 req/s cap.
- **Attribution**: met.no data is CC BY 4.0 / NLOD; the settings pane credits "MET Norway".

### Data not available from met.no (omitted, never fabricated)
`weather.apparent` (no feels-like in compact; a derived wind-chill/Steadman value would break the
mapper rule "missing fields are skipped, not fabricated"), `weather.uv` (only clear-sky UV exists),
`weather.sun.rise/set` (Sunrise 3.0 is a second endpoint; deferred), `weather.air.*` (air quality is
an Open-Meteo-only endpoint; the air request is skipped for met.no and the Air Quality widget shows
unavailable). The settings pane says so in one line.

### Symbol mapping
met.no `symbol_code` minus `_day|_night|_polartwilight` is mapped to the WMO codes the client's
`weatherInfo` already handles. Lossy by design (sleet lands on 66/67 "Freezing rain"; WMO has no
sleet-shower code). Unknown symbol omits `weather.code` (neutral placeholder).

## Open rules (decided by the owner 2026-11-07, priced in the architecture decision)
1. **Day boundary.** Group hourly entries into days by UTC date (zero OS code) or by the PC's local
   UTC offset (`GetTimeZoneInformation` via the `Win32_System_Time` feature of the existing `windows`
   crate, or the `ActiveTimeBias` registry value via the existing `winreg` crate). For the owner
   (UTC+3) UTC grouping puts 00:00-02:59 local into the previous day and, for those 3 hours each
   night, shifts the whole forecast strip by one day against the client's weekday labels.
   **Decision: the PC's time zone** via Win32 `GetTimeZoneInformation` (feature `Win32_System_Time`
   of the existing `windows` crate; no new crate, `Cargo.lock` unchanged). The offset is read once
   per poll and passed into the pure mapper, so tests run at fixed offsets; off-Windows it is 0.
2. **Partial day 0.** The met.no series starts at the current hour, so "today's" high/low only cover
   the hours left (Open-Meteo returns the full day). **Decision: accept for v1** and show the settings hint "met.no: today's high/low cover the
   remaining hours". Tracking the day's extremes across polls is a named follow-up (BACKLOG, LOW).

Note: Open-Meteo groups by the LOCATION's time zone (`timezone=auto`); any local-offset variant here
uses the PC's zone. They coincide while the configured location is in the PC's zone.

## Consequences
- **Positive:** the Weather widget works on the owner's network; no new crate; no change to the
  Open-Meteo path; `plugins/weather.json` stays backward compatible; met.no requests are
  ToS-compliant.
- **Negative / trade-offs:** in met.no mode there is no feels-like, UV, sunrise/sunset or air
  quality; days 3-6 are aggregated from four 6-hourly instants — the compact body carries no daily
  min/max, so those highs/lows understate the real extremes (fixture: daily low off by +0.4 C,
  high by -0.2 C); a new third-party host (`api.met.no`) receives the location rounded to ~11 m, as
  Open-Meteo already does. After a provider switch, Open-Meteo-only samples already in the client
  hub may linger until the hub drops them.
- **Follow-ups:** Sunrise 3.0 for `weather.sun.*`; If-Modified-Since; air quality from another
  source; revisit the day-boundary rule if the owner configures a location in another time zone.

## Rejected alternatives
Sunrise 3.0 second request (needs a date + offset met.no does not give; deferred), derived
feels-like (fabrication), automatic provider failover (hides the network problem, doubles code
paths), changing `fetch_forecast` to return headers (would touch the Open-Meteo path; the fork
module carries its own 10-line fetch with the same timeout, 8 MiB cap and URL-stripping errors).
