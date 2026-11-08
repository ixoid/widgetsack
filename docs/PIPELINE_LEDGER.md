# Pipeline ledger

> Append-only. One row per pipeline step per run, from the agents' actual verdicts. A step that ran and found nothing is a full row; a skipped step gets a row with the triage reason. Never write summary counts here — derive them by grepping when asked. Each row carries: the model the step ran on (and the evidence if it was escalated), the find-rate of any mutation probe round, and whether a `## Цена правила` section appeared at STEP 4 and what the owner answered.

Row format: `| run | step | agent · model | verdict | findings / evidence | notes |`

## weather-metno-20261107-1858 — W-1 met.no weather provider (branch feat/weather-metno)

| run | step | agent · model | verdict | findings / evidence | notes |
| --- | --- | --- | --- | --- | --- |
| weather-metno | 0.5 triage | coordinator | DATA, confident | 10 signals measured (see $BUS/triage.md); owner accepted the route | repro/breakdown/devops off |
| weather-metno | 1 clarifier | requirements-clarifier · sonnet | CLEAR | 0 questions; defaults: omit sun/apparent/UV on met.no, meters already tolerate missing fields | 28k tokens |
| weather-metno | 2 CPO | cpo-reviewer · sonnet | APPROVED | 2 questions for CTO (UTC day boundary, UA on shared client) → answered in cto-cpo-sync.md | 18k tokens |
| weather-metno | 3 CTO | cto-reviewer · sonnet | APPROVED | interface contract; flagged 2 priced rules | 46k tokens |
| weather-metno | 4 architect | architect · opus | READY after owner decisions | **Цена правила: yes** — (a) UTC vs local day grouping: owner chose Win32 time zone (feature flag, no new crate); (b) partial day-0 high/low: owner accepted with a settings hint | ADR 001 written; 114k tokens |
| weather-metno | 4.6 breakdown | — | skipped | L-size, single pass | — |
| weather-metno | 5 backend | backend-dev · sonnet (table) | DONE | fork/weather_metno.rs + provider branch; 477 Rust tests; 4 documented deviations from the spec; side effect: CRLF rewrite of 3 files (caught by security + QA, fixed by coordinator f7374ee) | 90k tokens |
| weather-metno | 6 ui spec | ui-consultant · sonnet | READY | native select, provider-dependent hints, test plan | 46k tokens |
| weather-metno | 7 frontend | frontend-dev · sonnet (table) | DONE | select + 8 tests; 4704 client tests pass (+2 known locale failures) | 43k tokens |
| weather-metno | 8 security #1 | security-reviewer · opus | APPROVED | 1 MEDIUM (HTTP-date year overflow → panic in debug), 1 LOW (redirects to any host); CRLF noted | 59k tokens |
| weather-metno | 9 QA #1 | qa-reviewer · sonnet | NEEDS_FIXES | 2 HIGH (integration tool drops provider; CRLF), 1 MEDIUM (stale sensors after switch — owner call), 3 LOW; fixture highs/lows recomputed independently and matched | 91k tokens |
| weather-metno | fix | pipeline-worker · sonnet | DONE | 4 findings fixed (babc534): date parser, redirect policy, provider kept on partial save (+ tool field), next_wait seam; 481 Rust tests; BACKLOG entries closed with Check output | 84k tokens |
| weather-metno | 9 QA #2 | qa-reviewer · sonnet | APPROVED | all raised findings verified fixed in code + by command; 481 Rust / 4678 client tests; coverage 99.11/97.85/98.99/99.06 (only excluded AiUsage files below 100%); open by owner choice: stale-sensor reset (MEDIUM), 6-hourly extremes (LOW) | 30k tokens |
| weather-metno | 8 security #2 | security-reviewer · opus | APPROVED | 4/4 prior findings verified fixed; fresh adversarial pass clean (tz change, JSON NaN/inf/1e308, unsorted timeseries, symbol variants, provider in logs); 2 new LOW: hop-count comment overstates by one; studio tool unit values C/F vs backend celsius/fahrenheit (pre-existing upstream) | 82k tokens |
| weather-metno | 10 tests | test-writer · sonnet (full scope) | DONE | baseline confirmed, no adaptations needed; +4 Rust (unsorted/dup timestamps, 1e308 filtered, odd symbol suffix, corrupt stored config), +5 client (meter with is_day absent, temp+code only, Sun&Moon without rise/set); 485 Rust / 4683 client; coverage unchanged | 51k tokens; commit 0441f39 |
| weather-metno | 10.5 runtime-eval | runtime-evaluator · sonnet | APPROVED | browser (dev mock): select, hint, payload `provider: met-no` + `weather_connect {restart:true}` observed; live api.met.no 200 with UA, mapper on the live body: temp 0.0 °C, humidity 84.9, wind 10.44, code 3, 7 days hi/lo, no apparent/uv/sun/air ids; legacy weather.json → open-meteo; no mutations attempted (find-rate n/a) | 40k tokens; dev contour, not a prod build |
| weather-metno | 11 devops | — | skipped | re-measured: no dependency/env/build change | — |
| weather-metno | route tuning | coordinator | owner decision | 2026-11-07 owner: «шей» — scripts/pipeline/route.mjs: securityIterations 2 only on touchesTrustSurface (DATA alone → 1); uiSpec/runtimeEval off for uiIsExistingPaneField; mergeGate (one CONFIRM agent for gates 1–3 when specIsDecided and not a defect). Re-routing this run under the new rule drops uiSpec, runtimeEval, security #2 and merges gates 1–3, ≈ −175k tokens, no found defect lost (security #2 found 2 LOW only) | pinned by route.test.ts (21 tests) |

## T-1-20261108-1046 — T-1 cbr-binance ticker provider (branch feat/T-1-cbr-binance-tickers)

| run | step | agent · model | verdict | findings / evidence | notes |
| --- | --- | --- | --- | --- | --- |
| T-1 | 0.5 triage | coordinator | DATA, confident | 12/12 signals measured by code ($BUS/triage.md); touchesTrustSurface false (no CSP/IPC/secure_config), uiIsExistingPaneField true; owner answered «Сократить: без архитектора» | repro/breakdown/uiSpec/runtimeEval/devops off; architect off by owner |
| T-1 | 1+2+3 CONFIRM gate | pipeline-worker · sonnet | CLEAR / APPROVED / APPROVED | no scope drift; CTO section carried the full interface contract (routing table, caps, cache, redirect allowlist, client contract, tests, ADR) in place of the architect | 84k tokens |
| T-1 | 4 architect | — | skipped | owner decision at triage: provider pattern exists (ADR-001); ADR written by backend-dev | **Цена правила: no section** (no architect) |
| T-1 | 4.6 breakdown | — | skipped | M-size, single pass | — |
| T-1 | 5 backend | backend-dev · sonnet (table) | DONE | fork/stocks_cbr.rs (22 tests) + 4 minimal stocks.rs hunks + ADR 004; 555 Rust tests; no deviations | 76k tokens; ran in parallel with step 7 (disjoint dirs) |
| T-1 | 6 ui spec | — | skipped | existing-pane field; WeatherSettings select copied | — |
| T-1 | 7 frontend | frontend-dev · sonnet (table) | DONE | select + stocks-provider.ts + studio enum; 4785 client tests, coverage 100 % | 56k tokens |
| T-1 | 8+9 security+QA | pipeline-worker · opus (combined, table) | APPROVED | 0 CRITICAL/HIGH; MEDIUM Q-M1 (CBR refetched every tick per symbol during an outage); 10 LOW (3 security: raw key in log, uncapped series, non-finite change; 7 QA: CRLF in 4 new files, dateless Date cache, status seam untested, Yahoo help lost `<code>`, missing adversarial tests, timing span, —); adversarial redirect/injection/caps checks all passed | 109k tokens |
| T-1 | fix | pipeline-worker · sonnet (table) | DONE | Q-M1 + S-L1..3 + Q-L1..3 fixed with tests; 562 Rust; LF restored on the 4 new files | 68k tokens |
| T-1 | 10 tests | test-writer · sonnet (full scope) | DONE | +4 Rust (redirect spoofing table, routing pairs, CBR 503 names symbol not host, demanded-key normalisation), +1 client (hint toggles); 566 Rust / 4786 client, coverage 100 %. **Incident:** a Python write truncated the untracked stocks_cbr.rs; rebuilt from transcripts; coordinator re-read the file and re-ran all gates → new Gotchas rule (WIP-commit new files between steps) | 73k tokens |
| T-1 | 10.5 runtime-eval | coordinator (live dev overlay) | APPROVED | `plugins/stocks.json` → cbr-binance (owner-approved write); overlay: USD/RUB 82.14 ▲ +0.42 %, BTC/USD $75,925.09 ▼ −0.26 % + sparkline, EUR/RUB 92.19 ▲ +0.04 % (work/shot-2026-11-08-T1-tickers.png; re-shot after the rebuilt file: BTC 75,890.96, live); no mutation probe (find-rate n/a) | before: work/shot-2026-11-08-start.png (`—`) |
| T-1 | 11 devops | — | skipped | re-measured: `git diff main` on Cargo.*, tauri.conf.json, capabilities, package.json, .github is empty | — |
