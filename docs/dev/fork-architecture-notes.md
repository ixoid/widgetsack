# Fork architecture notes (stage 0 map)

Written 2026-11-07 against `upstream-base` (commit `31097ee`, after v0.0.71) before any fork code.
Purpose: answer "where does X live and how do I add Y" so the three fork widgets (server check,
camera, calendar) can be added with registration points only. Read [AGENTS.md](../../AGENTS.md)
first; this file does not repeat its conventions.

## 1. Where widget types register

A widget TYPE is two halves:

| Half | File | What it holds |
| --- | --- | --- |
| Meta (framework-agnostic) | `client/src/lib/core/widget.ts` (`WidgetMeta`, `registerMeta`), complex ones in `core/dashboardMetas.ts`, `core/customHtmlMeta.ts`, `core/aiUsageMeta.ts` | `type`, `label`, `category`, `defaultSize`, `defaultConfig`, `configFields` (typed Inspector schema), `sensors(config)` (multi-sensor binding), `binds`, `interactive`, `intrinsic`, `defaultCss` |
| Component (React) | `client/src/lib/widgets/registry.tsx` (`components` map, `registerWidget`) | type → meter component; `paletteItems()` feeds Studio's Add palette |

Two ways to add a type:

1. **Built-in meter**: add meta to `widget.ts`, component to `meters/`, entry in `registry.tsx`.
   Touches core files — upstream merge friction.
2. **Plugin** (`client/src/lib/widgets/plugin.ts` `registerPlugin`): one object bundles
   `widgets[] { meta, component }`, `sources[]` (`SensorSource`), an optional `settings` panel,
   `statusSensor`, `controls`, `actions`. Registered from `widgets/plugins/index.ts` `BUILTINS`
   table (error-isolated, idempotent). Examples: `plugins/rss.ts`, `plugins/agenda.ts`,
   `plugins/home-assistant.ts`.

**Fork decision:** every fork feature is a plugin registered from a single `BUILTINS` entry that
points at `client/src/lib/widgets/fork/<feature>/index.ts`. Core touch = one line per feature.
`npm run gen:docs` must run after each new meta (`check:docs` is a CI gate).

## 2. Telemetry hub, sensors and demand gating

- Rust sources emit `Vec<SensorSample { sensor, ts_ms, value: SensorValue }>` on the single
  `telemetry` event (`sensors.rs` `TELEMETRY_EVENT`). `SensorValue` kinds: scalar, series, text,
  json. TS mirror: `client/src/lib/core/telemetry.ts`.
- `client/src/lib/telemetry/source.ts` listens and feeds the `TelemetryHub` (current readings +
  bounded history). Widgets read via `useSensor(hub, id)` / `useSensorMap` (`WidgetHost.tsx`).
- **Demand gate:** every window reports the sensor ids it has mounted
  (`set_active_sensors` → `ActiveSensors` in `sensors.rs`). Background sources read that set each
  tick and only work when someone wants their ids. `ping.rs` is the cleanest example: it parses
  hosts out of `net.ping.<host>.{ms,up}` ids (`hosts_from_active`) and pings exactly those.
  Studio's `*` wildcard cannot name a host, so an open Studio costs nothing.
- Three source shapes exist:
  - **Polling loop spawned in `main.rs`** (`run_system_sensors`, `run_ping_source`): no config,
    demand-driven from sensor ids.
  - **App-owned integration worker** (`rss.rs`, `agenda.rs`, `weather.rs`, `mqtt.rs`, `ha.rs`):
    `IntegrationTask` (`integration_task.rs`) with serialized ensure/restart/stop, config file in
    `<config>/plugins/<name>.json`, Tauri commands `save_<x>_config` (studio-gated),
    `<x>_config_status`, `<x>_connect { restart }`, `<x>_disconnect`, a `<x>.status` text sensor
    and `prime_window` to replay the last batch to a window that mounts between polls.
  - **On-demand command from a host component** (`service_health.rs` + `ServiceHealthHost.tsx`):
    the widget container polls `invoke("check_service_health")` on its own timer and pauses when
    `document.visibilityState === 'hidden'`. Non-studio callers are checked against the saved
    layout (`layout_grants.rs`).
- Frontend-side `SensorSource` (`core/plugin.ts`) objects only `start()` the backend worker and
  publish the catalog for the Inspector dropdown (`rss-source.ts` is 20 lines).

## 3. Rust ↔ frontend bridge

- Commands: `#[tauri::command]` fns listed in `main.rs` `invoke_handler![...]`; the wire name is
  the fn name; the TS side keeps every name in `client/src/lib/bridge/contract.ts` `COMMANDS` and
  wraps each in a typed adapter (`plugins/<x>-commands.ts`).
- Events: `emit`/`listen`; names also in `contract.ts`.
- Structs cross with serde `camelCase` and a mirrored TS type in `plugins/<x>-types.ts`. Change
  both sides in one commit.
- Studio-only commands check the window label; overlay-callable ones use `layout_grants`.
- Window capabilities: `widgetsack/capabilities/overlay.json` (`main`, `overlay-*`, `studio`).

## 4. Config and secrets

| What | Where | Notes |
| --- | --- | --- |
| Layout (widgets, config, css, tokens) | `<config>/widgets.json` | Frontend-owned schema (`core/layout*.ts`), backend merges + atomic write, file watcher emits `layout_changed` |
| Themes / sacks / wallpapers | `<config>/themes/*.css`, `sacks/*.sack.json`, `wallpapers/` | |
| App prefs (edit hotkey, update check, window layer) | `<config>/prefs.json` (`update.rs` `AppPrefs`) | |
| Integration configs | `<config>/plugins/<name>.json` | `rss.json` plaintext (public feeds); `agenda.json`, `ha.json`, `mqtt.json`, `llm.json` via `secure_config.rs` |
| Secrets | `secure_config.rs` | Whole JSON encrypted with user DPAPI, prefix `widgetsack-dpapi-v1:`; legacy plaintext migrated on read; status structs carry only the host, never the URL/token; UI fields are write-only (blank = keep) |
| Third-party packages | `<config>/plugins/<id>/plugin.json` | Sandboxed JS source, HTTPS GET only to approved hosts, no IP literals/ports — not usable for LAN targets (matches the brief) |

`<config>` = `%APPDATA%\io.github.gyng\` (Tauri `app_config_dir`), or its `multi\` subfolder when
run with `--multi` / `WIDGETSACK_MULTI=1` (`file_io.rs` `config_root`).

Validation: each integration validates in its `save_*_config` command (URL scheme, clamps such as
`agenda.rs` `MIN_INTERVAL`/`MAX_INTERVAL`), returns `Err(String)` with a human message.

## 5. Presets, templates, sacks

- `core/dashboardSacks.ts` — built-in dashboard presets (uses `ping` and `agenda` units).
- Layout format v2 (`docs/dev/layout-format.md`): row/col/grid tree + floating list per monitor;
  groups reference reusable library defs with params.
- Packages (`docs/dev/plugin-packages.md`) add templates/themes/sandboxed sources — not for us.
- Share: sacks pack layout + defs + theme (`core/sack.ts`) — the "export my layout" item of stage 4.

## 6. What already exists for each fork feature

### Hardware sensors (H-1, built 2026-11-07)

`widgetsack/src/fork/hwinfo/` + `client/src/lib/widgets/fork/hwinfo/` — the first fork plugin and the
template for the next ones. Shape: `model.rs` (pure `Reading` → slugs, catalog, `hw.cpu.*` label
heuristics), two readers behind one `probe_with` seam (`shared_mem.rs` parses the SDK layout from a
byte copy; `registry.rs` parses HWiNFO's `HKCU\Software\HWiNFO64\VSB` mirror), `mod.rs` = the
stocks.rs integration shape (IntegrationTask + SampleCache + `prime_window`, `plugins/hwinfo.json`,
demand gate on the `hw.` prefix). Client: `hwinfo-types.ts` ↔ serde, `hwinfo-commands.ts` (typed
`invoke`s, tested against the command names), `hwinfo-source.ts` (catalog = well-known ids + enabled
readings), `hwinfoCatalog.ts` (pure pane logic), `HwinfoSettings.tsx` (container), `index.ts`
(`registerPlugin`). Core touches: `main.rs` (`.manage` + 4 commands), `sensors.rs` (1 prime line),
`plugins/index.ts` (1 BUILTINS row), `contract.ts` (4 names), `Cargo.toml` (`Win32_System_Memory`).
Decision record: `docs/decisions/003-hwinfo-sensor-source.md`.

### Server check (stage 1)

- `ping` widget: Rust ICMP via `IcmpSendEcho` (no admin, no raw socket), 3 s interval, 1 s
  timeout, demand-gated per host; meter shows dot + ms, `slowMs` threshold; pure `core/ping.ts`.
- `servicehealth` widget: HEAD→GET headers only, latency, TLS expiry days, 10 s timeout, no
  redirects; overlay calls allowed only for URLs in the saved layout.
- `alerts` widget: threshold rules over any sensor (`sensor|above/below|threshold|message`),
  snooze, meeting reminders. Could consume `net.ping.<host>.up below 1`.
- Missing: TCP connect check, per-target history/sparkline, "last down at", one card with N
  targets, Windows toast (no notification plugin; `tauri-plugin-notification` would be new).

### Camera (stage 2)

- No video widget. `iframe` loads only `https:` (CSP `frame-src 'self' https:
  http://customhtml.localhost`), `customhtml` runs under `connect-src 'none'`.
- Webview CSP (`tauri.conf.json`): `connect-src 'self' ipc: http://ipc.localhost`,
  `media-src 'self' asset: … blob: data:`. WebRTC signalling (fetch/WebSocket to go2rtc) and MSE
  (fetch + blob) need `connect-src` to include `http://127.0.0.1:1984 ws://127.0.0.1:1984`;
  `media-src blob:` is already there. Needs an ADR.
- Interactive widgets exist: meta `interactive: true` + per-widget rects in `clickthrough.rs`.
- Child processes: `studio_agent.rs` already owns external processes with job objects and
  timeouts — the pattern for an optional go2rtc supervisor. No shell plugin needed.
- `reqwest` client is available for a "go2rtc alive" probe (`GET /api`).

### Calendar / agenda (stage 3)

- `agenda` plugin: Studio → Plugins → Agenda, ICS URL (https/webcal) stored via DPAPI, 16 MiB
  limit, backend trims private fields, frontend worker expands RRULE/EXDATE/timezones with ICAL.js
  (366-day horizon, 2,048 events). Widgets: `agenda` list, `alerts` meeting reminders.
- Missing vs brief: CalDAV (basic auth), "today / tomorrow / week" grouping, countdown to next
  event. Google/Yandex/Outlook private ICS links are plain https → work as-is.

## 7. Build, gates, run

- Client: `npm ci`, `npm run check`, `npm run lint` (zero warnings), `npm run test:coverage`
  (100% in included scope), `npm run build`, `npm run check:docs`.
- Rust (after a client build or the CI placeholder `client/build/index.html`): `cargo fmt --check`,
  `cargo test`, `cargo clippy --all-targets -- -D warnings`.
- Dev run: `npx --yes @tauri-apps/cli@2.12.4 dev` (Vite on 1420, `beforeDevCommand`). Second
  instance beside an installed release: `cargo run -- --multi`.
- Machine facts (2026-11-07): Rust stable 1.97 MSVC in `~/.cargo/bin` (not in the agent PATH),
  VS Build Tools 2022 17.14 with C++ and Win SDK 22621/26100, Node 24.15, npm 11.12, WebView2
  156. First `cargo build`: 5m33s, `target/` 2 GB.

## 8. Fork layout (agreed shape, to be confirmed by the owner)

```
client/src/lib/widgets/fork/
  server-check/   index.ts (registerPlugin) · meta.ts · ServerCheckHost.tsx · ServerCheck.tsx · commands.ts · types.ts · *.test.*
  camera/         index.ts · meta.ts · CameraHost.tsx · Camera.tsx (video element + go2rtc transport) · commands.ts
  calendar/       index.ts · (only if the stock agenda is insufficient)
client/src/lib/core/fork/   pure helpers with tests (status classification, sparkline windows, agenda grouping)
widgetsack/src/fork/
  mod.rs          pub mod server_check; pub mod camera; …
  server_check.rs config + IntegrationTask poller (icmp/tcp/http) + commands
  camera.rs       go2rtc probe (+ optional supervisor) + commands
```

Core touch points: `main.rs` (`mod fork;`, `.manage()`, handler entries, one `spawn`),
`plugins/index.ts` (one `BUILTINS` row per feature), `bridge/contract.ts` (command names),
`tauri.conf.json` CSP (camera only), `docs/widgets.md` via `gen:docs`.
