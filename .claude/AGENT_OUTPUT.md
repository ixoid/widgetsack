# Agent Output Log

> Append-only log of completed pipeline runs, fixes, and reviews. Newest at the top. Used by /sprint and the sprint-planner to know what's recently shipped.

<!-- Entry format:
## [date] — <what ran: /feature X, /bug Y, /cto-review, ...>
- Summary: ...
- Files changed: ...
- Tests: ...
-->

## 2026-11-09 — /feature W-3 forecast widget (run W-3-20261109-0657, branch feat/W-3-weather-forecast)
- Summary: `weatherforecast` fork widget reproducing the owner's Rainmeter ASTROWeather panel — 42 px current temperature with the detail column on the right, 12-hour strip with the current hour in the accent and the moon for clear/fair/partly-cloudy nights, 1–7 localised day rows («Сегодня Пн 9 ноя», «Вт 10 ноя») with separate МАКС/МИН columns; new sensors `weather.hour.N.{time,temp,code,is_day}` from both providers (ADR-007), stock `weather` widget untouched. Owner approved the HTML mock-up first (two comment rounds), route DATA, merged CONFIRM gate found that met.no has no sunrise/sunset → `is_day` sensor added; architect priced the night-moon rule (0 moons on the Moscow fixture) → owner chose moon for codes 0–2.
- Files changed: widgetsack/src/fork/{weather_hourly.rs (new), weather_metno.rs, mod.rs}, widgetsack/src/weather.rs (URL + pick_samples); client/src/lib/core/fork/weatherForecast.ts(+test); client/src/lib/widgets/fork/weather/{WeatherForecast.tsx, WeatherForecastParts.tsx, WeatherForecast.css, weather-forecast-plugin.ts}(+tests); client/src/lib/widgets/plugins/index.ts; docs/widgets.md; docs/decisions/007-weather-hourly-sensors.md; examples/layouts/own-desktop.widgets.json; docs/{BACKLOG,PRODUCT_ROADMAP,PIPELINE_LEDGER}.md; .claude/AGENT_CONTEXT.md.
- Tests: cargo 736 passed / 9 ignored; client 5081 passed, coverage 100 % on all four metrics; fmt, clippy, lint, check, build, check:docs green at c85304a.
- Reviews: combined security+QA (opus) APPROVED — 0 CRITICAL/HIGH/MEDIUM, 9 LOW (1 fixed, 3 to BACKLOG, 2 ADR wording, 1 owner note); test-writer full scope +11 cases; runtime-eval APPROVED (real Chromium probe with a NO-proof + live `--multi` overlay frame with met.no data). Merge pending owner's word.

## 2026-11-08 — /feature N-1 notification feed widget (run N-1-20261108-1637, branch feat/N-1-notifyfeed)
- Summary: `notifyfeed` fork widget — scrollable newest-first feed of Windows toasts (app, title, body, time; grouped by app; unread until «Mark all seen» OR the toast disappears from Action Center — auto-seen added by owner decision; badge = TOTAL items, owner override). Source A1: unpackaged WinRT `UserNotificationListener`, demand-gated 3 s poll; live probe GO on build 26200 (allowed without prompt, grant survives process restart; probe persisted as `#[ignore] test probe_live_listener` = the ADR recovery command). B (SQLite) documented fallback, not built; A2 (sparse package) documented only. 5 commands + `layout_grants`-style overlay gate; plain `plugins/notify.json`; privacy held (kind-only errors, ingest caps, exclusions at ingest + retro-purge).
- Files changed: widgetsack/src/fork/notifyfeed/{mod,ring,config,winrt_listener,gate,commands}.rs (new); Cargo.toml/main.rs/sensors.rs/fork mod (registration lines); client/src/lib/widgets/fork/notifyfeed/ (16 files); client contract.ts + plugins/index.ts; docs: ADR 006, widgets.md, README-fork, DEPLOYMENT, PIPELINE_LEDGER, PRODUCT_ROADMAP, BACKLOG.
- Tests: cargo 714 passed / 9 ignored; client 5030 passed, coverage 100 % on all four metrics; fmt, clippy, lint, check, build, check:docs green (full post-game gate run at 5df5982).
- Reviews: security ×2 APPROVED (0 CRITICAL/HIGH); QA #1 NEEDS_FIXES (HIGH worker-never-starts — no SensorSource; MEDIUM broken-config kills worker) → fix 0bd37b8 → QA #2 APPROVED; test-writer AUDITED-CLEAN; runtime-eval APPROVED live on `--multi` (4 scenarios incl. pixel-proven auto-seen and exact-count purge). Runtime constraint held throughout: the release instance was never touched; dev stand always `--multi`; quiet phase (no builds/tests) while the owner gamed.

## 2026-11-08 — /feature T-1 cbr-binance ticker provider (run T-1-20261108-1046, branch feat/T-1-cbr-binance-tickers)
- Summary: second `stocks` provider for the owner's network (Yahoo times out): CBR daily JSON for `<CODE>RUB` pairs (cached ≤ 30 min by Date, 5-min retry floor), Binance 24hr + 5m klines for `<COIN>-USD`; same `stocks.<SYMBOL>.*` ids keyed by the demanded string so the live layout lit up without edits; provider select in Plugins → Stocks; studio tool enum. Route DATA, gates 1–3 as one CONFIRM agent, architect skipped by owner choice, security+QA combined (opus). Live acceptance on the dev overlay by the coordinator (screenshots in work/).
- Files changed: widgetsack/src/fork/{mod.rs,stocks_cbr.rs}, widgetsack/src/stocks.rs; client/src/lib/widgets/plugins/{StocksSettings.tsx(+test),stocks-provider.ts(+test),stocks-types.ts}, client/src/lib/llm/studioIntegrationTools.ts(+test); docs/decisions/004-stocks-provider-cbr-binance.md, docs/{BACKLOG,PRODUCT_ROADMAP,PIPELINE_LEDGER}.md, CLAUDE.md (Gotchas), .claude/AGENT_CONTEXT.md.
- Tests: cargo 566 passed / 8 ignored; client 4786 passed, coverage 100 % on all four metrics; fmt, clippy, check, lint, build green.
- Reviews: combined security+QA APPROVED (0 CRITICAL/HIGH, 1 MEDIUM, 10 LOW) → fix agent closed the MEDIUM + 6 LOW → test-writer +4 Rust / +1 client. Incident: test-writer truncated the untracked `stocks_cbr.rs` and rebuilt it from transcripts; coordinator re-read the file and re-ran all gates — new Gotchas rule (WIP-commit new files between steps).

## 2026-11-07 — /feature W-1 met.no weather provider (run weather-metno-20261107-1858)
- Summary: provider switch Open-Meteo | met.no; fork module with a pure mapper (symbol→WMO, local-day aggregation via the Win32 time zone, unit conversion, Expires-aware wait), provider select in Weather settings; two priced rules decided by the owner (Win32 tz; partial day-0 accepted with a hint).
- Files changed: widgetsack/src/fork/mod.rs, fork/weather_metno.rs, weather.rs, main.rs, Cargo.toml, test-data/metno-compact.json; client plugins/WeatherSettings.tsx (+test), weather-types.ts, weather-commands.ts, llm/studioIntegrationTools.ts (+test), meters/Weather.test.tsx, SunMoon.test.tsx; docs/decisions/001, BACKLOG, PIPELINE_LEDGER, PRODUCT_ROADMAP.
- Tests: cargo 485 passed / 6 ignored; client 4683 passed (+2 known locale failures excluded); clippy, fmt, check, lint, check:docs green.
- Reviews: security #1 APPROVED (1 MEDIUM, 1 LOW fixed), QA #1 NEEDS_FIXES → fix → QA #2 APPROVED, security #2 APPROVED (2 LOW logged), runtime-eval APPROVED (live met.no).

