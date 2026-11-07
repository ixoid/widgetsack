# Backlog — <TODO: Project Name>

> Open bugs and findings. The security-reviewer and qa-reviewer agents APPEND here (HIGH/MEDIUM/LOW). /backlog triages, auto-fixes the simple ones, and prioritizes the rest.
>
> **An entry is closed by a run, not by a reading.** Every entry carries a `Check:` — a command
> plus the outcome that proves the finding is gone — and only that command's observed output
> closes it. "The code looks fixed" is an arrangement; `<command> → <outcome>` is a result.

Entry format:

```markdown
### [security|qa] Short title
- **Severity:** HIGH | MEDIUM | LOW
- **File:** `path:line`
- **Found by:** [agent]
- **Feature:** [feature name]
- **Date:** [YYYY-MM-DD]
- **Status:** open
- **Description:** [one line]
- **Fix:** [concrete approach]
- **Check:** [command → expected outcome; `none — <why>` if only the owner can close it]
```

Status lines carry evidence, not summaries:
`closed <date> — <command> → <observed outcome>` · `open — checked <date>, reproduces: <command> → <observed outcome>`.
A check asserting absence needs a positive control: the same probe must hit something somewhere,
or it is blind.

## HIGH

### [qa] Line endings of weather.rs, main.rs, Cargo.toml flipped LF to CRLF
- **Severity:** HIGH
- **File:** `widgetsack/src/weather.rs:1`
- **Found by:** qa-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** open
- **Description:** commit dce28c7 rewrote three upstream files (and added CRLF fork files) in a repo that is LF; whole-file diffs (1392/1471/290 lines) will conflict with every upstream merge.
- **Fix:** convert the five files to LF (sed -i 's/\r$//'), recommit.
- **Check:** `git ls-files --eol widgetsack/src/weather.rs widgetsack/src/main.rs widgetsack/Cargo.toml widgetsack/src/fork/weather_metno.rs docs/decisions/001-weather-provider-metno.md` -> all i/lf (control: widgetsack/src/ha.rs i/lf); `git diff d86711f..HEAD --stat -- widgetsack/src/main.rs` -> 1 line.


## MEDIUM

### [qa] Stale Open-Meteo values stay in mounted windows after switching to met.no
- **Severity:** MEDIUM
- **File:** `widgetsack/src/weather.rs:319`
- **Found by:** qa-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** open
- **Description:** only the backend prime cache is cleared; mounted hubs keep weather.apparent/uv/sun.*/air.* so feels, sun times and AQI go stale until reload.
- **Fix:** emit a clear/reset for weather.* on restart or have the hub drop weather.* on status 'connecting'.
- **Check:** none - owner picks the reset mechanism; then add a hub test.



### [qa] met.no day highs/lows for days 3-6 use 6-hourly instants
- **Severity:** LOW
- **File:** `widgetsack/src/fork/weather_metno.rs:381`
- **Found by:** qa-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** open
- **Description:** 4 samples/day understate real extremes; compact has no daily min/max.
- **Fix:** note in ADR Consequences.
- **Check:** none - documentation wording.


### [qa] Upstream AiUsage tests depend on the machine locale
- **Severity:** LOW
- **File:** `client/src/lib/widgets/meters/AiUsage.test.tsx:218`, `client/src/lib/widgets/meters/AiUsage.compact.test.tsx:294`
- **Found by:** coordinator (stage 0 baseline)
- **Feature:** fork stage 0
- **Date:** 2026-11-07
- **Status:** open — checked 2026-11-07, reproduces: `npx vitest run src/lib/widgets/meters/AiUsage.test.tsx` → `Unable to find an element with the text: 1.2K tokens` (renders «1,2 тыс. tokens» under ru-RU)
- **Description:** `AiUsage.tsx:45` formats with `Intl.NumberFormat(undefined, { notation: 'compact' })`; the two tests assert English output, so they fail on any non-English Windows locale. Not a product bug (user-locale formatting is intended); a test-portability bug worth upstreaming.
- **Fix:** in the two tests, stub the formatter or assert via a locale-independent matcher (e.g. `screen.getByText((t) => /1[.,]25/.test(t))`), or pin `Intl.NumberFormat` default locale in `client/src/test-setup.ts` for the suite. Prefer the test-side fix and offer it upstream as a PR.
- **Check:** `cd client && npx vitest run src/lib/widgets/meters/AiUsage.test.tsx src/lib/widgets/meters/AiUsage.compact.test.tsx` on a ru-RU machine → `Tests 19 passed (19)`; positive control: the same two assertions still fail if the formatter is forced to `ru-RU`.

## Closed
<!-- fixed / wont-fix / stale items moved here with date + reason -->
### [qa] Studio integration tool save resets weather provider to open-meteo
- **Severity:** HIGH
- **File:** `client/src/lib/llm/studioIntegrationTools.ts:80`
- **Found by:** qa-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** closed 2026-11-07 — `cd widgetsack && cargo test weather::tests::save_keeps_provider_when_absent` → `test weather::tests::save_keeps_provider_when_absent ... ok` (1 passed; 0 failed); `cd client && npx vitest run src/lib/llm/studioIntegrationTools.test.ts` → `Test Files  1 passed (1)`, `Tests  14 passed (14)` (includes the case forwarding provider `met-no`)
- **Description:** the weather tool fields omit provider, so an MCP/sidebar save sends none and save_weather_config normalises None to open-meteo, silently undoing met-no.
- **Fix:** keep the stored provider when the arg is None (backend helper resolve_provider) and add provider to the tool fields.
- **Check:** `cd widgetsack && cargo test weather::tests::save_keeps_provider_when_absent` passes; `cd client && npx vitest run src/lib/llm/studioIntegrationTools.test.ts` has a case forwarding provider 'met-no' and passes.

### [security] met.no HTTP-date parser overflows i64 on an unbounded year (panics in debug builds)
- **Severity:** MEDIUM
- **File:** `widgetsack/src/fork/weather_metno.rs:160` (year via `num`, unbounded digits) → overflow at `:118` (`days_from_civil(..) * 86_400`) and `:176` (subtraction)
- **Found by:** security-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** closed 2026-11-07 — `cd widgetsack && cargo test fork::weather_metno::tests::http_date` → `test fork::weather_metno::tests::http_date_huge_year_is_rejected_not_overflowed ... ok`, `test fork::weather_metno::tests::http_date_parser_and_freshness ... ok`, `test result: ok. 2 passed; 0 failed` (huge-year pair gives None, 2026 pair gives Some(1800 s))
- **Description:** `parse_http_date` accepts any all-digit year; a response header like `Expires: Sat, 07 Nov 999999999999 16:53:45 GMT` makes `epoch_from_parts` multiply past i64::MAX. Scratch probe (functions copied verbatim, `-C overflow-checks=on`): `attempt to multiply with overflow` panic; release build wraps (result capped later at MAX_INTERVAL). A panic kills the weather poll task until the next `weather_connect`. Needs a hostile/compromised api.met.no response (TLS), hence MEDIUM.
- **Fix:** in `parse_http_date` require the year to be exactly 4 digits (`year_str.len() == 4`) or `(1970..=9999).contains(&year)` — same bound `parse_rfc3339_utc` already gets from its fixed width; and use `checked_sub` in `fresh_for`. Add a unit test for the huge-year header.
- **Check:** `cd widgetsack && cargo test fork::weather_metno::tests::http_date` → a new case `fresh_for(Some("Sat, 07 Nov 999999999999 16:53:45 GMT"), Some("Sat, 07 Nov 2026 16:23:45 GMT")) == None` passes in the (overflow-checked) test profile; positive control in the same test: the 2026 pair still yields `Some(1800s)`.

### [security] Weather HTTP clients follow redirects with reqwest's default policy (any scheme/host, 10 hops)
- **Severity:** LOW
- **File:** `widgetsack/src/fork/weather_metno.rs:53` (also pre-existing `widgetsack/src/weather.rs:294`)
- **Found by:** security-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** closed 2026-11-07 — `cd widgetsack && cargo test fork::weather_metno` → `test fork::weather_metno::tests::redirect_policy_follows_only_https_api_met_no ... ok`, `test result: ok. 25 passed; 0 failed` (stops http:// and foreign hosts, follows https://api.met.no; Open-Meteo client left as upstream)
- **Description:** a redirect from api.met.no could send the request (URL carries the user's coordinates) to another host or downgrade to http; body cap and timeout still hold, so impact is location privacy only.
- **Fix:** `.redirect(reqwest::redirect::Policy::custom(|a| if a.url().scheme() == "https" && a.url().host_str() == Some("api.met.no") && a.previous().len() < 3 { a.follow() } else { a.stop() }))` in `metno_client`; same idea for the Open-Meteo client if upstream agrees.
- **Check:** `cd widgetsack && cargo test fork::weather_metno` → a new unit test asserting the policy closure stops an `http://` / foreign-host hop passes; positive control: same test follows an `https://api.met.no/...` hop.

### [qa] Expires wait floor is inline and untested
- **Severity:** LOW
- **File:** `widgetsack/src/weather.rs:406`
- **Found by:** qa-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** closed 2026-11-07 — `cd widgetsack && cargo test next_wait` → `test fork::weather_metno::tests::next_wait_floors_at_interval_and_caps ... ok`, `test result: ok. 1 passed; 0 failed` (helper lives in the fork module as `fork::weather_metno::next_wait`)
- **Description:** wait.max(fresh_for).min(MAX_INTERVAL) lives in the async loop; only fresh_for is unit-tested.
- **Fix:** extract next_wait(base, fresh) and test floor/cap.
- **Check:** `cd widgetsack && cargo test weather::tests::next_wait` passes with cases 900s+1800s->1800s, None->900s, 1e6s->MAX_INTERVAL.

### [qa] WeatherSettings header comment line exceeds 100 columns
- **Severity:** LOW
- **File:** `client/src/lib/widgets/plugins/WeatherSettings.tsx:4`
- **Found by:** qa-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** closed 2026-11-07 — `awk 'length>100 && /^\/\//' client/src/lib/widgets/plugins/WeatherSettings.tsx` → no output (positive control: `awk 'length>100'` on the same file still prints the long ternary line)
- **Description:** edited comment line is ~140 chars.
- **Fix:** re-wrap the comment.
- **Check:** `awk 'length>100 && /^\/\//' client/src/lib/widgets/plugins/WeatherSettings.tsx` -> no output (positive control: the same awk without the `^//` filter prints the long ternary line).

