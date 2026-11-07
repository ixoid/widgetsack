# Stage 0 — answers and proposed plan (awaiting owner decision)

Date: 2026-11-07. Base: `upstream-base` = `31097ee`. Companion: [fork-architecture-notes.md](fork-architecture-notes.md).

## Environment and baseline

| Check | Result |
| --- | --- |
| Rust | stable 1.97 MSVC (`~/.cargo/bin`, not in the agent PATH) — crate needs ≥ 1.95 ✅ |
| MSVC | VS Build Tools 2022 17.14, C++ tools, Win SDK 22621 + 26100 ✅ |
| Node / npm | 24.15 / 11.12; lockfile is `package-lock.json` → npm, not pnpm ✅ |
| WebView2 | runtime 156.0.4314.58 ✅ |
| `npm ci` | ok, 0 vulnerabilities |
| `npm run check` / `npm run lint` | ok / ok (0 warnings) |
| `npm run test:coverage` | 4696 passed, **2 failed** — both `AiUsage*.test.tsx`, cause: Russian machine locale formats `1.25M` as «1,25 млн». Not a code regression; logged in `docs/BACKLOG.md` (LOW), CI is on an English locale. |
| `npm run build` | ok |
| `cargo fmt --check` / `cargo test` / `cargo clippy -D warnings` | ok / 451 passed, 6 ignored / ok |
| First `cargo build` | 5m33s, `target/` 2 GB |
| `tauri dev` overlay | started 17:44 (`work/tauri-dev.ps1`, log `work/tauri-dev.log`): Vite on 1420, `widgetsack` process up, `overlay_diag` reports the `main` window 5120×2160 on DISPLAY1, visible, 2 monitors ok, saved layout missing (fresh config) ✅ |

## Answers to the brief's five questions

1. **Config storage.** One app config dir `%APPDATA%\io.github.gyng\` (or `multi\` under it for a dev
   instance). Layout = `widgets.json` (frontend-owned schema, backend merges + atomic write + file
   watcher). App prefs = `prefs.json`. Each integration = `plugins/<name>.json` with its own serde
   struct and validation in the `save_<name>_config` command (studio-gated). **Secrets:** the existing
   `secure_config.rs` encrypts the whole JSON with the user's DPAPI key; status structs return only
   the host, UI fields are write-only. That is where camera passwords and private feed URLs go — no
   new mechanism, no Credential Manager needed. Studio Plugins panel is the UI.
2. **Tauri plugins.** Present: `autostart` (plus a hardened HKCU preference in `autostart.rs`),
   `single-instance`, `global-shortcut`, `window-state`. **Absent:** notification and shell. For a
   Windows toast on up→down we would add `tauri-plugin-notification` (ADR). For go2rtc as a child
   process no shell plugin is needed — `studio_agent.rs` already spawns and owns external
   processes with job objects, timeouts and no shell; reuse that pattern.
3. **Ping.** Built-in and on Rust (`ping.rs`): `IcmpSendEcho` via the IP Helper API — **no admin
   rights, no raw socket**, so the brief's ICMP fallback worry does not apply. Demand-gated per
   host, 3 s interval, 1 s timeout, emits `net.ping.<host>.{ms,up}`. HTTP checks exist too
   (`servicehealth`: HEAD/GET headers, latency, TLS expiry, 10 s timeout). The ping source can be
   extended to a "server check" source: add `tcp` and `http` kinds, per-target interval/timeout,
   rolling history and last-down timestamp, one multi-target card. The existing `ping` widget stays
   untouched (upstream-mergeable).
4. **Calendar / agenda.** The `agenda` plugin fetches an **ICS over https/webcal** on the backend
   (URL encrypted, 16 MiB cap, private fields stripped), the frontend worker expands RRULE/EXDATE/
   timezones (ICAL.js, 366-day horizon, 2,048 events). Widgets: `agenda` list, `alerts` meeting
   reminders. **No CalDAV.** If your calendar offers a private ICS link (Google, Yandex, Outlook all
   do), stage 3 is configuration plus optional UI polish (today/tomorrow/week grouping, countdown).
   CalDAV would be a new Rust source — only if you need it.
5. **Interactive widgets.** Yes: meta `interactive: true` makes a widget catch clicks on the passive
   overlay (`clickthrough.rs` keeps per-widget interactive rects); `iframe`, `button`, `command`,
   `audioswitch` use it. A camera widget can be click-through by default with an `interact`
   toggle (open large / mute), same as `iframe`.

## Proposed implementation plan

### Stage 1 — Server check (`feat/server-check`) · complexity **M**

Rust `widgetsack/src/fork/server_check.rs` as an `IntegrationTask` source (pattern: `agenda.rs`):
config `plugins/server-check.json` (targets: name, host, kind `icmp|tcp|http`, port/url, expected
status or keyword, interval, timeout; no secrets → plaintext like `rss.json`), checks via the
existing ICMP helper (shared with `ping.rs` by moving `icmp_ping` into a small common module),
`tokio::net::TcpStream::connect` with timeout, the `service_health` client for http. Emits
`srv.<id>.up|ms|status|lastDown` plus `srv.status`. Frontend plugin
`widgets/fork/server-check/`: Settings panel (targets table), `servercheck` widget = one card with
N rows (dot, name, latency, 20-sample sparkline from hub history, "down since"), tokens only.
Optional: `alerts` rules auto-suggested; toast via `tauri-plugin-notification` behind a toggle (ADR).
Done when: 3 targets configured → statuses on the overlay, a pulled target flips within one interval.
Open choices: **(a)** targets in Studio Plugins panel (consistent with the app) vs a hand-edited
JSON file; **(b)** toast plugin now or stage 4.

### Stage 2 — Camera via go2rtc (`feat/camera`) · complexity **L**

The hard part is policy, not code: the webview CSP must allow `connect-src http://127.0.0.1:1984
ws://127.0.0.1:1984` (configurable origin, loopback only by default) — ADR + security review.
Frontend `widgets/fork/camera/`: `camera` widget = `<video muted autoplay playsinline>` with a
small transport module (WebRTC first via go2rtc's WHEP endpoint `/api/webrtc`, fallback MSE via
`/api/ws`), reconnect with backoff, "no signal" state, pause when the window is hidden or the
widget is unmounted. `video-rtc.js` from go2rtc is MIT — vendoring is possible, but a ~150-line
own transport is easier to test and to keep prop-driven; decide at implementation. Config:
`plugins/camera.json` via `secure_config` (go2rtc base URL, stream list; credentials never leave
the backend — go2rtc holds the RTSP creds in its own yaml outside the repo). Rust
`widgetsack/src/fork/camera.rs`: `camera_probe` (GET `/api`), optional supervisor that starts a
configured `go2rtc.exe` as a child (job object, like `studio_agent.rs`) — behind an explicit toggle.
Grid 2×2 = four widgets in a grid container (existing layout solver), no special widget.
Done when: one camera in `go2rtc.yaml` → live video on the overlay ≤ ~1 s latency, camera off →
"no signal", auto-reconnect.
Open choices: **(a)** CSP origin fixed loopback vs configurable; **(b)** supervise go2rtc from the
app or require the user to run it; **(c)** interaction: none / click opens large.

### Stage 3 — Calendar (`feat/calendar`) · complexity **S** (ICS) or **M** (CalDAV)

Audit first with your real feed: paste the private ICS link in Studio → Plugins → Agenda and look at
the `agenda` widget. If good: UI additions only — `agendaplus` widget in `widgets/fork/calendar/`
reusing `agenda.list` with today/tomorrow/week groups and a countdown to the next event (pure
helpers in `core/fork/agendaGroups.ts`, fully testable). If CalDAV is required: a Rust source with
basic auth via `secure_config`, REPORT query, ICS payloads fed into the same `agenda.calendar`
pipeline.
Open choice: which calendar provider and whether a private ICS link is acceptable.

### Stage 4 — Packaging

`npx @tauri-apps/cli@2.12.4 build --bundles nsis`, autostart toggle (already exists in Settings),
`config.example.json` for the three plugins, `README-fork.md`, export the layout as a sack.

## Decisions requested from the owner

1. Stage-1 target source of truth: Studio Plugins panel (recommended) or a JSON file you edit by hand.
2. Camera: fixed loopback CSP origin (recommended) or configurable host; app-supervised go2rtc or external.
3. Calendar provider and whether an ICS private link is fine (recommended: try ICS first).
4. Windows toast on down: now (stage 1, new dependency) or later.
5. Commit policy: the brief asks for a commit per step; upstream's AGENTS.md says commit only when
   asked. Proposal: commit freely on `feat/*` branches, never push without your word.
