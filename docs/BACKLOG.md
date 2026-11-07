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

## MEDIUM

### [owner] Tickers: EUR→RUB, USD→RUB, BTC→USD with a red/green 24h arrow
- **Severity:** MEDIUM
- **File:** `examples/layouts/own-desktop.widgets.json` (ticker `ticker-3hpjgi`), `widgetsack/src/stocks.rs:350`, `client/src/lib/widgets/meters/Ticker.tsx:96`
- **Found by:** owner (2026-11-07, mid-session request)
- **Feature:** ticker widgets
- **Date:** 2026-11-07
- **Status:** open
- **Description:** the owner wants three tickers on the overlay — rubles per euro, rubles per dollar, bitcoin in USD — each with an arrow showing the day's change, red for down and green for up. The stock `ticker` meter already draws a colour-coded arrow + % change vs Yahoo's previous close, so most of this is configuration. Two gaps: (1) the one ticker in the live layout is configured with symbol `BTC/USD`, which is not a Yahoo symbol (Yahoo wants `BTC-USD`), so it most likely shows nothing; (2) the arrow is "vs previous close" — for FX the previous trading day (flat over weekends), for BTC the previous UTC midnight; the owner confirmed that is the intended meaning.
- **Fix:** step 1 (config only, after `scripts/snapshot-layout.ps1`): three `ticker` widgets with symbols `EURRUB=X`, `USDRUB=X`, `BTC-USD`, labels «€ → ₽», «$ → ₽», «BTC», `decimals` 2 / 2 / 0; confirm `=` survives `yahoo_chart_url` (only `^` is escaped today — `=` is legal in a URL path) and that Yahoo returns `chartPreviousClose` for `=X` pairs. Owner decision 2026-11-07: change vs previous close is exactly what is wanted — no rolling-24h work.
- **Check:** overlay shows three tickers with a price and a coloured arrow for each symbol; `grep -c '"symbol": "BTC/USD"' examples/layouts/own-desktop.widgets.json → 0` after the layout is fixed and re-snapshotted.

## LOW / Cosmetic

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

### [qa] Studio integration tool weather `unit` enum ['C','F'] does not match stored 'celsius'/'fahrenheit'
- **Severity:** LOW
- **File:** `client/src/lib/llm/studioIntegrationTools.ts:82`
- **Found by:** security-reviewer (pre-existing upstream, not security)
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** open
- **Description:** the settings pane stores `unit: "celsius"`, so any tool edit that omits `unit` re-validates `"celsius"` against `['C','F']` and throws `Invalid setting: unit.`; an explicit `"F"` is saved but `unit_letter("F")` → C and the Open-Meteo URL asks for Celsius. The test status mock uses `unit: 'C'`, which hides it.
- **Fix:** change the enum to `['celsius','fahrenheit']` and the test mock to `unit: 'celsius'` (or map C/F to celsius/fahrenheit in the tool before save).
- **Check:** `cd client && npx vitest run src/lib/llm/studioIntegrationTools.test.ts` → passes with a case where status `unit: 'celsius'` and settings `{ latitude: 2 }` calls `save_weather_config` with `unit: 'celsius'` (positive control: the same case with `settings: { unit: 'kelvin' }` still throws `Invalid setting: unit.`).

## Closed
<!-- fixed / wont-fix / stale items moved here with date + reason -->

### [qa] Stale Open-Meteo values stay in mounted windows after switching to met.no
- **Severity:** MEDIUM
- **File:** `widgetsack/src/weather.rs:319`
- **Found by:** qa-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** closed 2026-11-07 — wont-fix: the owner does not plan to switch weather providers, so the only trigger (provider change at runtime) does not occur on this install; reopen if a provider switch is ever done. No code changed.
- **Description:** only the backend prime cache is cleared; mounted hubs keep weather.apparent/uv/sun.*/air.* so feels, sun times and AQI go stale until reload.
- **Fix:** emit a clear/reset for weather.* on restart or have the hub drop weather.* on status 'connecting'.
- **Check:** none - owner picks the reset mechanism; then add a hub test.

### [qa] Line endings of weather.rs, main.rs, Cargo.toml flipped LF to CRLF
- **Severity:** HIGH
- **File:** `widgetsack/src/weather.rs:1`
- **Found by:** qa-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** closed 2026-11-07 — `git ls-files --eol widgetsack/src/main.rs widgetsack/Cargo.toml widgetsack/src/weather.rs widgetsack/src/fork/weather_metno.rs docs/decisions/001-weather-provider-metno.md` → every file `i/lf w/lf` (commit f7374ee; `.gitattributes` now pins `eol=lf`); `git diff --stat d86711f -- widgetsack/src/main.rs` → `1 +`
- **Description:** commit dce28c7 rewrote three upstream files (and added CRLF fork files) in a repo that is LF; whole-file diffs (1392/1471/290 lines) will conflict with every upstream merge.
- **Fix:** convert the five files to LF (sed -i 's/\r$//'), recommit.
- **Check:** `git ls-files --eol widgetsack/src/weather.rs widgetsack/src/main.rs widgetsack/Cargo.toml widgetsack/src/fork/weather_metno.rs docs/decisions/001-weather-provider-metno.md` -> all i/lf (control: widgetsack/src/ha.rs i/lf); `git diff d86711f..HEAD --stat -- widgetsack/src/main.rs` -> 1 line.

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

### [security] met.no redirect policy doc says "at most 3" hops, code follows at most 2
- **Severity:** LOW
- **File:** `widgetsack/src/fork/weather_metno.rs:52`
- **Found by:** security-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** closed 2026-11-07 — comment rewritten in `widgetsack/src/fork/weather_metno.rs` (follow_redirect): states that `hops` counts the original request so `hops < 3` = at most 2 redirects, with a warning not to loosen it; `grep -n "at most 2 redirects" widgetsack/src/fork/weather_metno.rs` → 1 match (commit 0441f39)
- **Description:** reqwest 0.13.5 pushes the original request URL into `previous()` before calling the policy (`redirect.rs:308-318`), so `hops < 3` follows at most 2 redirects; the doc comment (and the test's 0/2/3 labels) claim 3. Stricter than documented (no exposure), but a later "fix" guided by the comment could loosen the control unnoticed.
- **Fix:** reword the doc to "at most 2 redirects (`previous()` includes the original request)" or change to `hops <= 3` if 3 is intended; add a one-line comment in `redirect_policy_follows_only_https_api_met_no` stating the `previous().len()` semantics.
- **Check:** `grep -n "at most 3" widgetsack/src/fork/weather_metno.rs` → 0 matches (positive control: `grep -n "fn follow_redirect" widgetsack/src/fork/weather_metno.rs` → 1 match); `cd widgetsack && cargo test fork::weather_metno::tests::redirect_policy` → passes.
