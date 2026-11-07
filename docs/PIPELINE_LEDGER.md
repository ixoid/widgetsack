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
