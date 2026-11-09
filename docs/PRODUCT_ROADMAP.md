# Product Roadmap — widgetsack fork (ixoid)

> /sprint and /multi-sprint read this file. Each feature MUST have a `### [ID]:` heading and a fenced ` ```/feature ...``` ` block so the planner can extract it verbatim. Group by vector/phase and list a recommended execution order at the bottom. Stage numbers refer to `WIDGETSACK_FORK_BRIEF.md`.

## Vector W — Weather (Rainmeter parity, added 2026-11-07)

### [W-1]: met.no weather provider
```
/feature Weather provider switch with met.no as an alternative to Open-Meteo (see .claude/agent-bus/weather-metno-20261107-1858/feature-request.md for the full scope).
```
**Priority:** Phase 1 · **Status:** ✅ done 2026-11-07, merged into `main` (pipeline run weather-metno-20261107-1858; owner confirmed 2026-11-07)
**Depends on:** none
**Est. size/mode:** L · DATA — persisted config field + new outbound host

### [W-2]: Remember today's high/low across polls
```
/feature For the met.no provider, keep the day's observed high/low in the worker between polls (reset at local midnight) so the "today" reading does not shrink to the remaining hours in the evening. Pure seam with tests; remove the "remaining hours" hint when active. See docs/decisions/001-weather-provider-metno.md (owner accepted the partial day for v1).
```
**Priority:** Phase 2 · **Depends on:** W-1 · **Est. size/mode:** S · SPEC · **Status:** ✅ done 2026-11-07, merged into `main` (f979bfb; lane 3)

### [W-3]: Forecast widget — hourly strip + localised day rows
```
/feature A fork widget `weatherforecast` in client/src/lib/widgets/fork/weather/ that reproduces the owner's Rainmeter ASTROWeather panel: (a) day rows — one row per day (today + N), each with a localised day name and date (ru: «Сегодня», «Вс 8 ноя»; locale config like the clock widget), condition icon, HIGH and LOW as separate values (the stock `weather` meter only has English TODAY/SUN labels and no date); (b) an hourly strip — next 12 hours: hour, icon, temperature, fed by new `weather.hour.N.{time,temp,code}` sensors emitted by the provider mappers (met.no gives hourly data in the same response; Open-Meteo needs the `hourly=` query, bounded to 24 entries). Props-only meter, config: days, hours, locale, showCurrent; pure helpers with tests (hour bucketing, label formatting); register via a fork plugin; gen:docs. Interim: the stock weather widget is restyled into day rows via layout CSS (examples/layouts/own-desktop.widgets.json, 2026-11-07).
```
**Priority:** Phase 2 · **Depends on:** W-1 · **Est. size/mode:** M · SPEC

## Vector T — Tickers (owner request 2026-11-07)

### [T-1]: Ticker provider reachable from Russia — CBR for RUB rates, Binance for BTC
```
/feature Add a second `stocks` provider `cbr-binance` (fork module widgetsack/src/fork/stocks_cbr.rs, selected in Plugins → Stocks like the weather provider switch) because Yahoo Finance does not answer from the owner's network (curl: timeout 10 s on every request, 2026-11-07). RUB pairs (`USDRUB`, `EURRUB`, any CBR code) come from the Bank of Russia daily feed — https://www.cbr-xml-daily.ru/daily_json.js (mirror of cbr.ru XML_daily; fields Value and Previous give "change vs previous close" exactly as the owner wants), polled at most every 30 min and cached by the Date field; crypto pairs (`BTCUSDT`, …) from Binance https://api.binance.com/api/v3/ticker/24hr (lastPrice, prevClosePrice, priceChangePercent; add a tiny intraday series from /api/v3/klines 5m so the sparkline works). Emit the same `stocks.<SYMBOL>.{price,change,changeAbs,prevClose,series}` ids so the stock Ticker meter needs no change; map the owner's three tickers: `USDRUB=X`→CBR USD, `EURRUB=X`→CBR EUR, `BTC-USD`→Binance BTCUSDT (accept both spellings). Timeouts 10 s, body caps, no keys, no secrets; pure mappers with fixture tests; ADR. Done when the three tickers on the overlay show a price and a coloured arrow.
```
**Priority:** Phase 1 · **Status:** ✅ done 2026-11-08, merged into `main` (e17ba5f; run T-1-20261108-1046, ADR-004; owner skipped the architect step; live check on the dev overlay: three tickers show price + coloured arrow) · **Depends on:** none · **Est. size/mode:** M · DATA — new outbound hosts (cbr-xml-daily.ru, api.binance.com)
**Reachability probe 2026-11-07 (curl from the owner's machine):** cbr.ru 200 / 0.49 s, cbr-xml-daily.ru 200 / 0.26 s, api.binance.com 200 / 0.35 s, api.bybit.com 200, okx.com 200, api.coingecko.com 200; query1.finance.yahoo.com — timeout.

## Vector H — Hardware sensors (owner request 2026-11-07)

### [H-1]: HWiNFO shared-memory sensor source (CPU temperature, effective clocks, package power)
```
/feature Add a demand-gated Rust sensor source widgetsack/src/fork/hwinfo.rs that reads the HWiNFO64 shared memory segment (Global\HWiNFO_SENS_SM2, the layout HWiNFO's SDK and the Rainmeter HWiNFO plugin use) and emits `hw.cpu.temp` (Tctl/Tdie or package temperature in °C), `hw.cpu.clock.max` (max effective per-core clock in MHz), `hw.cpu.clock.core.N`, `hw.cpu.power` (W), plus a catalog of every HWiNFO sensor the user enables (`hw.<sensor-slug>`), with a Plugins → Hardware (HWiNFO) settings pane (status: HWiNFO running / shared memory off / not found) and a sensor picker. Owner facts: HWiNFO64 is already running on the machine for Rainmeter; the CPU is a Ryzen 9 9950X3D, where CallNtPowerInformation (today's `cpu.freq.current`) reports a nominal clock that never moves, and sysinfo has no CPU temperature on Windows. Known limits to document: HWiNFO must have "Shared Memory Support" enabled; the free edition limits shared memory to 12 hours per launch (the Pro edition lifts it); if HWiNFO is absent the sensors are simply unavailable (widgets show "—"). Then update examples/layouts/own-desktop.widgets.json: CPU card gets a Temp gauge bound to hw.cpu.temp and the MHz gauge switches to hw.cpu.clock.max. Security: read-only mapping of a local shared-memory segment, no network; validate the header/version before trusting offsets.
```
**Priority:** Phase 1 · **Status:** ✅ done 2026-11-07, merged into `main` (a2f9c3c; lane 1, bus `H-1-20261107-2106`; live-overlay check done 2026-11-07 22:04 — CPU card reads `hw.cpu.temp` / `hw.cpu.clock.max`). Scope note: the owner's HWiNFO has Shared Memory Support OFF and gadget/VSB reporting ON, so the source reads both — shared memory when present, else the registry mirror (ADR-003). · **Depends on:** none · **Est. size/mode:** L · DATA — native memory mapping, new settings pane

## Vector S — Server check (brief stage 1)

### [S-1]: Server check widget
```
/feature Server check (brief stage 1): a Rust fork source widgetsack/src/fork/server_check.rs (IntegrationTask pattern like agenda.rs) with targets configured in Plugins → Server check (name, host, kind icmp|tcp|http, port/url, expected status or keyword, interval default 30 s, timeout), checks via the existing ICMP helper (share it with ping.rs), tokio TcpStream connect with timeout, and the service_health client for http; emits srv.<id>.up|ms|status|lastDown and srv.status; a `servercheck` fork widget renders one card with N rows (dot, name, latency, 20-sample sparkline, "down since"). Optional Windows toast on up→down behind a toggle (new tauri-plugin-notification; ADR). Done when 3 targets show status and latency on the overlay and a pulled target flips within one interval. See docs/dev/fork-stage0-plan.md § Stage 1 for open choices.
```
**Priority:** Phase 1 · **Status:** ✅ done 2026-11-07, merged into `main` (f53c9f5; lane run S-1-20261107-2105, ADR-002; toast deferred; live-overlay check with three real targets still owed by the owner) · **Depends on:** none · **Est. size/mode:** M · DATA

## Vector C — Cameras (brief stage 2)

### [C-1]: Camera widget — native RTSP in-process (retina → Tauri Channel → WebCodecs)
```
/feature Camera widget (brief stage 2), transport decided by the owner 2026-11-08 and recorded in docs/decisions/005-camera-native-rtsp-transport.md: a `camera` fork widget that plays one LAN camera over RTSP/TCP inside the app process. Rust (widgetsack/src/fork/camera/): the `retina` client (pinned =0.4.21) pulls H.264 access units and sends them over a per-subscriber Tauri `Channel` (media as Raw bytes, status as Json); the webview decodes them with WebCodecs `VideoDecoder` and draws onto a `<canvas>` (client/src/lib/widgets/fork/camera/). No go2rtc, no child process, no listening port, no CSP or capabilities change. Credentials: address, login and password are entered only in Studio → Plugins → Camera, stored in plugins/camera.json through secure_config (DPAPI), write-only in the pane, never returned to the webview, never in logs or errors (errors cross as an enum). One shared RTSP session fans out to N camera widgets; it starts on the first subscriber and is torn down 2 s after the last one leaves (the lock has few RTSP slots). Overlay gate: an overlay window may subscribe or probe only if the SAVED layout contains a Camera widget (studio bypasses). Resilience: reconnect backoff 1, 2, 4, 8, 16, 30 s (reset after 10 s live), 401/403 is terminal with a 60 s lockout until the config is saved, 8 s stall detection, 24-frame in-flight backpressure with client acks, wait-for-keyframe after every (re)connect. Widget states: connecting, live, no signal, auth failed (names the Aqara "RTSP LAN Preview" cause), unsupported codec, not configured, credentials missing, decoder unavailable, decode error, refused (layout not saved). Out of scope: H.265, audio, PTZ, multi-camera config or grid, ONVIF, recording, GOP cache and dimmed last frame (owner's choice 2026-11-08: black "connecting" while waiting for a keyframe), Rust-side occlusion detection. Done when the owner's camera shows live video at about 1 s or less glass-to-glass on the overlay, recovers after unplug/replug without an app restart, and the acceptance criteria below hold.
```
**Priority:** Phase 1 (owner request 2026-11-07: "мне надо сделать просмотр видео с камеры") · **Status:** ✅ done 2026-11-08, merged into `main` (6f29604; run C-1-20261108-1134, ADR-005; spike GO in Studio; security+QA (opus) approved after fixes; on the overlay seen only as «No signal, retrying» because the owner's VPN hides the LAN camera — designed state) · **Depends on:** none · **Est. size/mode:** XL · DATA — new network dependency (`retina`), secure_config, new IPC commands (trust surface)
**Spike result:** GO 2026-11-08 (owner at the keyboard, dev overlay, Aqara lock `ch2`): codec `avc1.4D0033` (H.264 Main 5.1), 1280×960, ≈18 fps, 1.1–1.6 Mbit/s, GOP 2.0 s, first keyframe 468 ms cold, `isConfigSupported` true, ≥19 min continuous, forced drop recovered, Aqara Home / HomeKit coexist and 10 subscribe cycles do not wedge the camera, glass latency ≈0.5 s. S6, S7 and S9 skipped by the owner. Numbers in ADR-005.
**Acceptance criteria (as they stand after the spike):**
1. Live video on the dev overlay, confirmed by the owner; automated: the Vitest state machine reaches `live` on a fake channel and fake decoder, and the Rust session pipeline runs against a fake RTSP server on `127.0.0.1:0`.
2. Latency about 1 s or less (measured ≈0.5 s); hard fail above 3 s.
3. No signal within 10 s of the stream stalling (client watchdog, fake-clock test); after a stall the stage goes black with the text, no stale frame.
4. Reconnect with the backoff ladder above; a 401/403 does not retry in a loop (60 s lockout, cleared by a save); video resumes after replug without restarting the app.
5. Credentials never leave the backend: sentinel leak test over status, probe, save result, events, `Debug` and every error `Display`; DPAPI file holds no plaintext; no argv, no generated file, no local API; `git diff --cached | grep -iE "rtsp://[^ ]*:[^ ]*@|token="` prints nothing.
6. Demand gate: no camera widget mounted means no RTSP socket; two widgets share one session; the last unsubscribe releases it after the 2 s grace; window destroy and app exit release everything.
7. Input validation in Rust: `rtsp` scheme only, no whitespace in host, port 1–65535, path length cap, userinfo split off and never stored in the URL, connect/describe/play timeouts, access-unit size cap.
8. `tauri.conf.json`, `capabilities/*`, `layout_grants.rs`, `secure_config.rs` untouched; overlay subscribe and probe refused unless the saved layout contains a Camera widget.
9. All gates green (`npm run check; lint; test:coverage; build; check:docs`, `cargo fmt --check; test; clippy -D warnings`); layout snapshot taken first.
**Owner facts (no secrets here):** one IP camera on the LAN (Aqara door lock), RTSP on a non-default port (8554), stream path `ch2`, basic auth. The credentials are held by the owner locally (`work/camera.local.md`, gitignored) and are typed only into the Studio pane; no agent reads that file.

## Vector K — Calendar (brief stage 3)

### [K-1]: Agenda grouping and countdown
```
/feature Calendar polish (brief stage 3, ICS path is confirmed working with the owner's Google private feed): an `agendaplus` fork widget reusing agenda.list with today / tomorrow / this week groups and a countdown to the next event; pure helpers in client/src/lib/core/fork/agendaGroups.ts with tests; register via a fork plugin; gen:docs. CalDAV is out of scope unless the owner asks.
```
**Priority:** Phase 2 · **Depends on:** none · **Est. size/mode:** S · SPEC · **Status:** ✅ done 2026-11-07, merged into `main` (73a4247; lane 3; `agendaplus` is on the dev overlay)

## Vector N — Notifications feed (owner request 2026-11-08)

### [N-1]: Notification feed widget — what arrived while you were away
```
/feature A fork widget `notifyfeed` that shows a scrollable feed of recent Windows toast notifications (app name/icon, title, body, time, grouped by app, newest first, configurable depth e.g. last 50 / last 24 h, "mark all seen" via a Studio toggle or a timer) so notifications that arrived during a full-screen game can be read later on the overlay. Research step first (the source is an open choice): (a) WinRT `Windows.UI.Notifications.Management.UserNotificationListener` — the official listener, needs the user to grant "notification access" in Settings → Privacy and normally package identity (sparse package / MSIX identity for the unpackaged Tauri exe — check feasibility and the NSIS installer impact); (b) read-only polling of the Action Center store `%LOCALAPPDATA%MicrosoftWindowsNotificationswpndatabase.db` (SQLite; what Action Center itself shows, works unpackaged, needs a SQLite crate and a schema that Microsoft may change); (c) anything better found. Rust fork source `widgetsack/src/fork/notifyfeed.rs` with a demand gate, emits `notify.list` (JSON text sample, like `agenda.list`) + `notify.count`; pure mappers with fixture tests; privacy: notification bodies never leave the machine and are not persisted by us beyond the in-memory ring (owner toggle for per-app exclusion, e.g. banking/messengers). Done when a toast fired during a game shows up in the widget with app, title, body and time, and the list survives the game session.
```
**Priority:** Phase 2 (owner: «часто прилетают пока в игре — а посмотреть потом негде») · **Status:** ✅ done 2026-11-08 on `feat/N-1-notifyfeed` (run N-1-20261108-1637, ADR-006: A1 unpackaged WinRT listener — live probe GO on build 26200; owner added auto-seen on Action Center disappearance + chose count=TOTAL; QA HIGH/MEDIUM fixed; security ×2 + QA + runtime-eval APPROVED; merged 3942970; owner's real-game check confirmed 2026-11-09: «лента работает») · **Depends on:** none · **Est. size/mode:** M–L · DATA — new local data source (WinRT listener or SQLite read), privacy-sensitive content, possibly package identity
**Owner facts:** Windows 11; the overlay is a click-through dev build; notifications of interest arrive while a full-screen game is in the foreground.

---

## Recommended execution order
1. W-1 — done, in `main`.
2. S-1 and H-1 — done, in `main`.
3. W-2, K-1 and the LOW backlog items — done, in `main`.
3a. T-1 — done, in `main` (2026-11-08).
4. C-1 — done, in `main` (2026-11-08; native RTSP, no go2rtc, no CSP change).
5. W-3 — the last open roadmap item. (Vector P / the clean-VM installer check was dropped by the owner 2026-11-08: «это вообще не нужно»; the packaging itself shipped with the stage-4 installer and release script.)
6. N-1 — done 2026-11-08 on `feat/N-1-notifyfeed` (ADR-006, live probe GO, runtime-eval APPROVED; merge pending owner's word; real-game confirmation after the next release install).
