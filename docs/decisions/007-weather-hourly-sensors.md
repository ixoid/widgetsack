# ADR-007: Hourly weather sensors (`weather.hour.N.*`)

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** owner (forecast widget mock-up, W-3, 2026-11-09); CTO + coordinator (`is_day` amendment); architect (shape)

## Context
The fork's `weatherforecast` widget (W-3) needs the next 12-24 hours: label, temperature, condition,
day/night. Both providers already return hourly data in the body we fetch; no sensor carries it.
Constraints: no new endpoint or crate, `SensorSample` unchanged, demand gate unchanged (`weather.`
prefix), stock `weather` widget untouched, met.no (the owner's only reachable provider) must reach
parity, including night glyphs, although it emits no `weather.sun.*` (ADR-001).

## Options considered
1. **Epoch-ms `time` scalar** - machine-independent instant; the client needs the location's zone to
   print "07", which neither provider-agnostic path has. Rejected.
2. **Location-local wall-clock text** - the format `weather.sun.rise/set` already use; the client
   slices the hour and date from the string, no `Date` math, no machine-zone dependence. Chosen.
3. **Night from sunrise/sunset only** - works on Open-Meteo, never fires on met.no. Rejected.
4. **Per-hour `is_day` from each provider** - Open-Meteo has `hourly=is_day`; met.no encodes it in
   the `_day`/`_night` symbol suffix. Chosen.

## Decision
For N = 0..23 (N = 0 is the current local hour at poll time; no past hours; at most 24):

| id | kind | value |
|---|---|---|
| `weather.hour.N.time` | text | `YYYY-MM-DDTHH:MM`, location-local, no offset (MM is `00` for whole-hour zones) |
| `weather.hour.N.temp` | scalar | configured unit, like `weather.temp` |
| `weather.hour.N.code` | scalar | WMO code |
| `weather.hour.N.is_day` | scalar | 1 / 0; omitted when unknown |

Sourcing:
- **Open-Meteo** (`fork/weather_hourly.rs`, called from `weather::pick_samples`): the URL adds
  `hourly=temperature_2m,weather_code,is_day&forecast_hours=24`. The mapper still slices: first
  `hourly.time` >= `current.time` truncated to the hour (lexicographic compare, same zone). No
  `current.time` -> no hour ids. A malformed `time` ends the run; a missing field is skipped.
- **met.no** (`fork/weather_metno.rs`): entries from `parse_entries`; N = (entry secs - poll hour
  floor) / 3600 for whole-hour steps 0..23, first entry wins a duplicate. Time text = civil time of
  `secs + local_utc_offset_secs()` (the ADR-001 offset seam). Code = `symbol_to_wmo(next_1_hours)`,
  never the 6 h symbol. `is_day` = `day_flag(next_1_hours)`, else the nearest suffixed `next_1_hours`
  within `IS_DAY_NEIGHBOUR_SECS` (3 h) either side, else omitted.
- Not emitted in v1: hourly wind, humidity, precipitation, feels-like.

Client rule: hours are read as the longest prefix with valid, strictly increasing `time`, then hours
before the PC's current local hour are dropped. This also discards hour ids left over in the hub or
`SampleCache` from an earlier poll (ids are never retracted). Night glyph: `hour.N.is_day`, else
compare HH:MM with `weather.sun.rise/set` (Open-Meteo only), else the day glyph. Owner decision
2026-11-09: at night codes 0, 1 and 2 (clear, mainly clear, partly cloudy) show the moon; code 2 is
the fork's one deviation from the stock `weatherInfo` table, applied in the client helper only.

## Consequences
- **Positive:** both providers feed the strip from the body already fetched; 96 extra samples per
  poll (~6 KB); no trust-surface change.
- **Negative / trade-offs:** the past-hour drop and the met.no time text assume the weather location
  shares the PC's zone (same assumption as ADR-001 day cutting). At a DST fall-back Open-Meteo
  repeats one local string (`02:00`, `02:00`); the client's strictly-increasing rule then cuts the
  strip at the repeat for the polls that span it, i.e. fewer hours for up to a day, never wrong
  ones (Moscow has no DST). In half-hour zones the met.no `hour.0` slot (`…T04:30` at 05:10 local)
  is dropped by the past-hour rule, so the strip starts at the next slot; accepted, not the owner's
  zone. met.no only suffixes clear / fair /
  partly-cloudy / showers symbols, so overcast, rain, fog and snow hours usually have no `is_day`;
  with the stock `weatherInfo` glyphs that changes nothing (only codes 0-2 have a night glyph).
- **Follow-ups:** met.no Sunrise 3.0 (ADR-001) would let both providers emit `weather.sun.*`.
