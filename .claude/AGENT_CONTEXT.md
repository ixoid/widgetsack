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

## In progress
- **Waiting for the owner's decisions** listed in `docs/dev/fork-stage0-plan.md` § "Decisions requested" before stage 1 (`feat/server-check`). No feature code yet.

## Known constraints
- Windows-only build; ICMP from the agent sandbox is blind (use the overlay itself or TCP probes).
- `iframe`/`customhtml` cannot reach `http://127.0.0.1:1984` (CSP) — camera needs a built-in widget + targeted CSP change (ADR).
- Agenda supports ICS (https/webcal) only, no CalDAV.
- Upstream gates: zero-warning lint, 100% unit coverage in the included scope, `check:docs`, clippy `-D warnings`.
- Owner rules: Russian to the owner, English in code; project boundary; no secrets in git; features through the pipeline, one branch per stage.
