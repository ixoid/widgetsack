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
**Priority:** Phase 1 · **Status:** ✅ done 2026-11-07, merged into `main` (a2f9c3c; lane 1, bus `H-1-20261107-2106`; live-overlay check still owed by the owner). Scope note: the owner's HWiNFO has Shared Memory Support OFF and gadget/VSB reporting ON, so the source reads both — shared memory when present, else the registry mirror (ADR-003). · **Depends on:** none · **Est. size/mode:** L · DATA — native memory mapping, new settings pane

## Vector S — Server check (brief stage 1)

### [S-1]: Server check widget
```
/feature Server check (brief stage 1): a Rust fork source widgetsack/src/fork/server_check.rs (IntegrationTask pattern like agenda.rs) with targets configured in Plugins → Server check (name, host, kind icmp|tcp|http, port/url, expected status or keyword, interval default 30 s, timeout), checks via the existing ICMP helper (share it with ping.rs), tokio TcpStream connect with timeout, and the service_health client for http; emits srv.<id>.up|ms|status|lastDown and srv.status; a `servercheck` fork widget renders one card with N rows (dot, name, latency, 20-sample sparkline, "down since"). Optional Windows toast on up→down behind a toggle (new tauri-plugin-notification; ADR). Done when 3 targets show status and latency on the overlay and a pulled target flips within one interval. See docs/dev/fork-stage0-plan.md § Stage 1 for open choices.
```
**Priority:** Phase 1 · **Status:** ✅ done 2026-11-07, merged into `main` (f53c9f5; lane run S-1-20261107-2105, ADR-002; toast deferred; live-overlay check with three real targets still owed by the owner) · **Depends on:** none · **Est. size/mode:** M · DATA

## Vector C — Cameras (brief stage 2)

### [C-1]: Camera widget via go2rtc
```
/feature Camera widget (brief stage 2): `camera` fork widget = <video muted autoplay playsinline> with a small transport module (WebRTC via go2rtc WHEP first, MSE fallback), reconnect with backoff, "no signal" state, pause when hidden/unmounted; config plugins/camera.json via secure_config (go2rtc base URL default http://127.0.0.1:1984, stream list); Rust camera_probe (GET /api) and an optional supervisor that starts a configured go2rtc.exe as a child (job object, studio_agent.rs pattern) behind a toggle; CSP connect-src extended ONLY for the configured loopback origin (ADR + security review); example go2rtc.yaml without credentials. Done when one camera shows live video ≤ ~1 s latency and recovers after the camera goes away. See docs/dev/fork-stage0-plan.md § Stage 2.
```
**Priority:** Phase 1 (owner request 2026-11-07: "мне надо сделать просмотр видео с камеры") · **Depends on:** none · **Est. size/mode:** L · DATA — CSP change is a security boundary
**Owner facts (no secrets here):** one IP camera on the LAN, RTSP on a non-default port (8554), stream path `ch2`, basic-auth credentials in the URL. The full URL with credentials is held by the owner locally (`work/camera.local.md`, gitignored) and must only ever land in the local `go2rtc.yaml`; the committed `go2rtc.example.yaml` uses placeholders.

## Vector K — Calendar (brief stage 3)

### [K-1]: Agenda grouping and countdown
```
/feature Calendar polish (brief stage 3, ICS path is confirmed working with the owner's Google private feed): an `agendaplus` fork widget reusing agenda.list with today / tomorrow / this week groups and a countdown to the next event; pure helpers in client/src/lib/core/fork/agendaGroups.ts with tests; register via a fork plugin; gen:docs. CalDAV is out of scope unless the owner asks.
```
**Priority:** Phase 2 · **Depends on:** none · **Est. size/mode:** S · SPEC · **Status:** ✅ done 2026-11-07, merged into `main` (73a4247; lane 3; `agendaplus` is on the dev overlay)

## Vector P — Packaging (brief stage 4)

### [P-1]: Release packaging and autostart
```
/feature Stage 4: release installer verified on a clean Windows VM, autostart via the existing Launch at login toggle, config.example.json for the fork plugins, README-fork.md (what was added, setup, upstream merge procedure, known limits), export the owner's layout as a sack preset.
```
**Priority:** Phase 3 · **Depends on:** S-1, C-1, K-1 · **Est. size/mode:** S · INFRA

---

## Recommended execution order
1. W-1 — done, in `main`.
2. S-1 and H-1 — done, in `main`.
3. W-2, K-1 and the LOW backlog items — done, in `main`.
3a. T-1 — done, in `main` (2026-11-08).
4. C-1 — after S-1; needs the owner at the keyboard (CSP decision, real camera, go2rtc).
5. W-3, then P-1.
