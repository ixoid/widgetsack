# Product Roadmap — widgetsack fork (ixoid)

> /sprint and /multi-sprint read this file. Each feature MUST have a `### [ID]:` heading and a fenced ` ```/feature ...``` ` block so the planner can extract it verbatim. Group by vector/phase and list a recommended execution order at the bottom. Stage numbers refer to `WIDGETSACK_FORK_BRIEF.md`.

## Vector W — Weather (Rainmeter parity, added 2026-11-07)

### [W-1]: met.no weather provider
```
/feature Weather provider switch with met.no as an alternative to Open-Meteo (see .claude/agent-bus/weather-metno-20261107-1858/feature-request.md for the full scope).
```
**Priority:** Phase 1 · **Status:** in pipeline (branch `feat/weather-metno`, 2026-11-07)
**Depends on:** none
**Est. size/mode:** L · DATA — persisted config field + new outbound host

### [W-2]: Remember today's high/low across polls
```
/feature For the met.no provider, keep the day's observed high/low in the worker between polls (reset at local midnight) so the "today" reading does not shrink to the remaining hours in the evening. Pure seam with tests; remove the "remaining hours" hint when active. See docs/decisions/001-weather-provider-metno.md (owner accepted the partial day for v1).
```
**Priority:** Phase 2 · **Depends on:** W-1 · **Est. size/mode:** S · SPEC

### [W-3]: Hourly forecast strip
```
/feature A compact hourly forecast row (next 12 hours: hour, icon, temperature) as a new fork widget `weatherhourly` in client/src/lib/widgets/fork/weather/, fed by new `weather.hour.N.*` sensors emitted by the provider mappers (met.no gives hourly data; Open-Meteo would need the `hourly=` query). Matches the Rainmeter ASTROWeather strip the owner had. Register via a fork plugin, gen:docs, tests.
```
**Priority:** Phase 2 · **Depends on:** W-1 · **Est. size/mode:** M · SPEC

## Vector H — Hardware sensors (owner request 2026-11-07)

### [H-1]: HWiNFO shared-memory sensor source (CPU temperature, effective clocks, package power)
```
/feature Add a demand-gated Rust sensor source widgetsack/src/fork/hwinfo.rs that reads the HWiNFO64 shared memory segment (Global\HWiNFO_SENS_SM2, the layout HWiNFO's SDK and the Rainmeter HWiNFO plugin use) and emits `hw.cpu.temp` (Tctl/Tdie or package temperature in °C), `hw.cpu.clock.max` (max effective per-core clock in MHz), `hw.cpu.clock.core.N`, `hw.cpu.power` (W), plus a catalog of every HWiNFO sensor the user enables (`hw.<sensor-slug>`), with a Plugins → Hardware (HWiNFO) settings pane (status: HWiNFO running / shared memory off / not found) and a sensor picker. Owner facts: HWiNFO64 is already running on the machine for Rainmeter; the CPU is a Ryzen 9 9950X3D, where CallNtPowerInformation (today's `cpu.freq.current`) reports a nominal clock that never moves, and sysinfo has no CPU temperature on Windows. Known limits to document: HWiNFO must have "Shared Memory Support" enabled; the free edition limits shared memory to 12 hours per launch (the Pro edition lifts it); if HWiNFO is absent the sensors are simply unavailable (widgets show "—"). Then update examples/layouts/own-desktop.widgets.json: CPU card gets a Temp gauge bound to hw.cpu.temp and the MHz gauge switches to hw.cpu.clock.max. Security: read-only mapping of a local shared-memory segment, no network; validate the header/version before trusting offsets.
```
**Priority:** Phase 1 · **Depends on:** none · **Est. size/mode:** L · DATA — native memory mapping, new settings pane

## Vector S — Server check (brief stage 1)

### [S-1]: Server check widget
```
/feature Server check (brief stage 1): a Rust fork source widgetsack/src/fork/server_check.rs (IntegrationTask pattern like agenda.rs) with targets configured in Plugins → Server check (name, host, kind icmp|tcp|http, port/url, expected status or keyword, interval default 30 s, timeout), checks via the existing ICMP helper (share it with ping.rs), tokio TcpStream connect with timeout, and the service_health client for http; emits srv.<id>.up|ms|status|lastDown and srv.status; a `servercheck` fork widget renders one card with N rows (dot, name, latency, 20-sample sparkline, "down since"). Optional Windows toast on up→down behind a toggle (new tauri-plugin-notification; ADR). Done when 3 targets show status and latency on the overlay and a pulled target flips within one interval. See docs/dev/fork-stage0-plan.md § Stage 1 for open choices.
```
**Priority:** Phase 1 · **Depends on:** none · **Est. size/mode:** M · DATA

## Vector C — Cameras (brief stage 2)

### [C-1]: Camera widget via go2rtc
```
/feature Camera widget (brief stage 2): `camera` fork widget = <video muted autoplay playsinline> with a small transport module (WebRTC via go2rtc WHEP first, MSE fallback), reconnect with backoff, "no signal" state, pause when hidden/unmounted; config plugins/camera.json via secure_config (go2rtc base URL default http://127.0.0.1:1984, stream list); Rust camera_probe (GET /api) and an optional supervisor that starts a configured go2rtc.exe as a child (job object, studio_agent.rs pattern) behind a toggle; CSP connect-src extended ONLY for the configured loopback origin (ADR + security review); example go2rtc.yaml without credentials. Done when one camera shows live video ≤ ~1 s latency and recovers after the camera goes away. See docs/dev/fork-stage0-plan.md § Stage 2.
```
**Priority:** Phase 2 · **Depends on:** none · **Est. size/mode:** L · DATA — CSP change is a security boundary

## Vector K — Calendar (brief stage 3)

### [K-1]: Agenda grouping and countdown
```
/feature Calendar polish (brief stage 3, ICS path is confirmed working with the owner's Google private feed): an `agendaplus` fork widget reusing agenda.list with today / tomorrow / this week groups and a countdown to the next event; pure helpers in client/src/lib/core/fork/agendaGroups.ts with tests; register via a fork plugin; gen:docs. CalDAV is out of scope unless the owner asks.
```
**Priority:** Phase 2 · **Depends on:** none · **Est. size/mode:** S · SPEC

## Vector P — Packaging (brief stage 4)

### [P-1]: Release packaging and autostart
```
/feature Stage 4: release installer verified on a clean Windows VM, autostart via the existing Launch at login toggle, config.example.json for the fork plugins, README-fork.md (what was added, setup, upstream merge procedure, known limits), export the owner's layout as a sack preset.
```
**Priority:** Phase 3 · **Depends on:** S-1, C-1, K-1 · **Est. size/mode:** S · INFRA

---

## Recommended execution order
1. W-1 — in flight; the weather card is empty without it.
2. H-1 — CPU temperature and real clocks; the owner's most visible gap vs Rainmeter after weather.
3. S-1 — brief stage 1.
4. W-2, K-1 — small follow-ups.
5. C-1 — biggest, needs the CSP decision.
6. W-3, then P-1.
