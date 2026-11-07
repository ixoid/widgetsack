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

## In progress
- `feat/weather-metno` awaits the owner's merge decision. Next roadmap item: **H-1 HWiNFO shared-memory sensors** (CPU temperature + effective clocks), then S-1 server check. The stage-0 decisions (server-check target source, camera CSP policy, calendar provider) are still open — see `docs/dev/fork-stage0-plan.md`.

## Known constraints
- Windows-only build; ICMP from the agent sandbox is blind (use the overlay itself or TCP probes).
- `iframe`/`customhtml` cannot reach `http://127.0.0.1:1984` (CSP) — camera needs a built-in widget + targeted CSP change (ADR).
- Agenda supports ICS (https/webcal) only, no CalDAV.
- Upstream gates: zero-warning lint, 100% unit coverage in the included scope, `check:docs`, clippy `-D warnings`.
- Owner rules: Russian to the owner, English in code; project boundary; no secrets in git; features through the pipeline, one branch per stage.
