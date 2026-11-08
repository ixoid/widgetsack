# Agent Output Log

> Append-only log of completed pipeline runs, fixes, and reviews. Newest at the top. Used by /sprint and the sprint-planner to know what's recently shipped.

<!-- Entry format:
## [date] — <what ran: /feature X, /bug Y, /cto-review, ...>
- Summary: ...
- Files changed: ...
- Tests: ...
-->

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

