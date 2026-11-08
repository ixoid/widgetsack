# Agent Context — widgetsack fork

> Shared, always-read context for the pipeline agents. Keep it current — agents trust this over their own assumptions. The `/feature` pipeline updates the "Done" / "In progress" sections at the end of each run.

## Stack (one-liner)
Tauri 2 (Rust 2024, crate `widgetsack/`) + React 19/TS/Vite (`client/`), Windows-only overlay + Studio editor; telemetry over a `telemetry` event as `SensorSample` batches; frontend-owned layout JSON; DPAPI-encrypted integration configs. Fork of `gyng/widgetsack` at tag `upstream-base` (commit 31097ee, after v0.0.71).

## Key files
- `AGENTS.md` — upstream conventions (authoritative for code); §9 — fork layer pointer
- `CLAUDE.md` — fork rules, gotchas, verification
- `WIDGETSACK_FORK_BRIEF.md` — owner's brief with stages 0–4 and open questions
- `docs/dev/fork-architecture-notes.md` — the stage-0 map (write it before any feature code)
- `widgetsack/src/main.rs` — registration of states, commands and background sources
- `widgetsack/src/{ping,service_health,agenda,secure_config,layout_grants,integration_task}.rs` — patterns to reuse
- `client/src/lib/core/widget.ts`, `client/src/lib/widgets/registry.tsx`, `client/src/lib/widgets/plugins/index.ts` — widget/plugin registration
- `widgetsack/tauri.conf.json` — CSP and windows; `widgetsack/capabilities/overlay.json` — permissions
- Fork code lives in `client/src/lib/widgets/fork/*` and `widgetsack/src/fork/*`

## Done
- 2026-11-07: fork created (`ixoid/widgetsack`), upstream fetched into `D:\VSC proj\own pc`, tag `upstream-base`; pipeline scaffold restored (`.claude/`, `.zcode/`, `scripts/hooks/secret-guard.mjs`, `docs/{BACKLOG,DEPLOYMENT,PRODUCT_ROADMAP}.md`); environment verified (Rust 1.97 MSVC, VS Build Tools 2022, Node 24, npm 11, WebView2 156); `npm ci` green.

- 2026-11-07: stage 0 complete — all upstream gates green (client check/lint/build; `cargo fmt`/`test` 451 ok/`clippy -D warnings`), `npm run test:coverage` 4696 ok + 2 locale-only failures (BACKLOG LOW); dev overlay launched via `npx @tauri-apps/cli@2.12.4 dev` (main window 5120×2160 visible, 2 monitors ok, fresh empty layout); `docs/dev/fork-architecture-notes.md` and `docs/dev/fork-stage0-plan.md` written.

- 2026-11-07: **W-1 met.no weather provider** built on `feat/weather-metno` (pipeline run `weather-metno-20261107-1858`): `widgetsack/src/fork/{mod,weather_metno}.rs`, provider branch in `weather.rs`, `Win32_System_Time` feature for the local day offset, provider select in Plugins → Weather; ADR `docs/decisions/001-weather-provider-metno.md`; 485 Rust / 4683 client tests; security ×2, QA ×2 and runtime-eval approved. Open by owner choice: stale Open-Meteo sensors after a provider switch (BACKLOG MEDIUM), 6-hourly extremes for days 3–6 (LOW).
- 2026-11-07: the owner's desktop layout `examples/layouts/own-desktop.widgets.json` (second monitor key `CRXED00-UID516`, 2560×720) is deployed to the app config; calendar (Google ICS) and weather (met.no) configured from the Rainmeter skins.
- 2026-11-07: pipeline route tuned for the fork (`scripts/pipeline/route.mjs`): `touchesTrustSurface`, `uiIsExistingPaneField`, `mergeGate` — see `docs/PIPELINE_LEDGER.md`.

- 2026-11-07: **H-1 HWiNFO hardware sensors** built on `feat/H-1-hwinfo` (lane 1 of 2, bus `H-1-20261107-2106`): `widgetsack/src/fork/hwinfo/{mod,model,shared_mem,registry}.rs` — demand-gated `hw.*` source reading HWiNFO's shared memory when it is on, else the gadget/VSB registry mirror (what the owner's machine actually exposes: `EnableVSB=1`, shared memory off); well-known `hw.cpu.temp` / `hw.cpu.clock.max` / `hw.cpu.clock.core.N` / `hw.cpu.power` from HWiNFO labels, `hw.<slug>` for ticked readings; client plugin `client/src/lib/widgets/fork/hwinfo/` (Plugins → Hardware (HWiNFO): status, reading picker, poll interval); ADR `docs/decisions/003-hwinfo-sensor-source.md`; `Win32_System_Memory` feature. Core touches: one `.manage` + four command lines in `main.rs`, one `prime_window` line in `sensors.rs`, one `BUILTINS` entry, four `contract.ts` names.

- 2026-11-08: **T-1 cbr-binance ticker provider** built on `feat/T-1-cbr-binance-tickers` (run `T-1-20261108-1046`, route DATA, owner skipped the architect step): `widgetsack/src/fork/stocks_cbr.rs` — symbol routing (`<CODE>RUB[=X]` → CBR daily JSON, `<COIN>-USD|USDT` → Binance 24hr + 5m klines), pure mappers onto the SAME `stocks.<SYMBOL>.*` ids keyed by the demanded string, CBR body cached ≤ 30 min by `Date` with a 5-min retry floor, redirect allowlist (https + 3 hosts, ≤ 2 hops), 10 s timeout, body caps; `stocks.rs` hunks: `normalize_provider` (save/status/start), provider branch, `build_status`; client: provider select in Plugins → Stocks (`stocks-provider.ts` holds copy + normalisation), studio tool enum; ADR `docs/decisions/004-stocks-provider-cbr-binance.md`. Security+QA (opus, combined) APPROVED: 0 CRITICAL/HIGH, 1 MEDIUM + 6 LOW fixed, 2 LOW in BACKLOG. 566 Rust / 4786 client tests, coverage 100 %. Live: the three overlay tickers show price + coloured arrow (USD/RUB, EUR/RUB from CBR; BTC/USD with sparkline from Binance).

## In progress
- **C-1 camera** on `feat/C-1-camera` (run `C-1-20261108-1134`, ADR-005: native RTSP via `retina` → Tauri `Channel` → WebCodecs, no go2rtc, CSP untouched). Phase 1 spike **GO** 2026-11-08 15:30 against the owner's Aqara lock (`avc1.4D0033` 1280×960 ≈18 fps, GOP 2.0 s, first keyframe 468 ms, ≥19 min continuous, drop recovery, Aqara/HomeKit coexistence, glass latency ≈0.5 s). Owner's cost-gate choice: black/«connecting» while waiting for a keyframe, no dimmed last frame, no GOP cache. Batches R1, F1, R2, F2 reviewed and committed (WIP commits up to 1ec9e60). Phase 2 done 15:53: R3 (backoff ladder, subscriber registry + fan-out + 2 s grace, `camera_ack` flow control + CONFIG/keyframe cache, layout gate for the overlay, stall status events; reviewed, fixes 66e1d74) and F3 (camera-model states/copy/watchdogs, acks, decode-queue drop, superseded/dropped split, final Camera meter; reviewed, fixes c32914e); T25 docs 7cf7fba; T26 gates green (client 4974 tests / 100 %, cargo 676, fmt, clippy, check:docs). Overlay path seen live 16:05 only as «No signal, retrying»: the owner's full-tunnel VPN hides the LAN camera and stays on by the owner's choice — designed state, not a bug (worker retries with backoff, no crash). Security+QA (opus) APPROVED WITH FIXES; the HIGH (overlay could sit on «No signal» for ever: RTCP kept a hung stream alive, and a silently dropped subscriber never resubscribed) and the MEDIUM (no subscriber cap) are fixed (bd5eb3c, 9a5b330); final gates green on f8d0eb4 (client 4984 tests / 100 %, cargo 681). Branch is merge-ready; waiting for the owner's word.
- T-1 merged into `main` (e17ba5f, 2026-11-08) and pushed. The live `plugins/stocks.json` says `provider: cbr-binance` (owner approved the write 2026-11-08).

## State at the end of 2026-11-07
- In `main`: W-1 met.no, S-1 server check (ADR-002), H-1 HWiNFO (ADR-003), W-2 daily extremes, K-1 agendaplus, the three LOW backlog fixes. Full `npm run test:coverage` is green on the owner's ru-RU machine (no AiUsage exclusions any more); `cargo test` 536.
- The overlay on the owner's screen is the DEV build (`work/tauri-dev.ps1` → `tauri dev` without `--multi`, Vite on 1420, auto-rebuilt on Rust edits); its config is the release config dir. The owner will NOT install the NSIS release until development is finished — verify on dev. Screenshot of the overlay monitor: PowerShell `CopyFromScreen(1406, 2160, …, 2560×720)`.
- Live layout snapshot rule is in force (`scripts/snapshot-layout.ps1`, CLAUDE.md § Plan management). Live layout 22:04: CPU card on `hw.cpu.clock.max`/`hw.cpu.temp` (verified live), Servers card (`plugins/server-check.json`: router icmp, 1.1.1.1 tcp 443, cloudflare trace http — placeholders the owner will replace with the VPS), three tickers USD/RUB, EUR/RUB, BTC/USD in a row next to the clock — LIVE since 2026-11-08 via the `cbr-binance` provider (T-1; Yahoo Finance times out from the owner's network).
- Lane worktrees `.claude/worktrees/agent-*` are left in place (clean, branches merged); safe to `git worktree remove`.
- Next (owner's word needed): C-1 camera (owner at the keyboard: CSP decision, real camera, local go2rtc.yaml), then W-3, P-1.
- Process rule added 2026-11-08 (CLAUDE.md Gotchas): WIP-commit new files on the branch after every pipeline step that creates them, before the next agent runs — the T-1 test-writer truncated the untracked `stocks_cbr.rs` and had to rebuild it from transcripts. The `/feature` pipeline run inside a fork lane has no subagents — run a separate security+QA review before merging (CLAUDE.md § Gotchas).

## Known constraints
- Windows-only build; ICMP from the agent sandbox is blind (use the overlay itself or TCP probes).
- `iframe`/`customhtml` cannot reach `http://127.0.0.1:1984` (CSP) — camera needs a built-in widget + targeted CSP change (ADR).
- Agenda supports ICS (https/webcal) only, no CalDAV.
- Upstream gates: zero-warning lint, 100% unit coverage in the included scope, `check:docs`, clippy `-D warnings`.
- Owner rules: Russian to the owner, English in code; project boundary; no secrets in git; features through the pipeline, one branch per stage.
