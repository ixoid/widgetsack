# ADR-002: Server check — probe source, config storage and widget data shape

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** owner (brief stage 1), pipeline lane S-1

## Context
Brief stage 1 asks for a card that shows whether the owner's VPS and LAN hosts are reachable, with
latency, a short history and "down since". The app already has three relevant pieces: `ping.rs`
(ICMP via `IcmpSendEcho`, demand-gated), `service_health.rs` (bounded HTTP HEAD/GET, studio/overlay
grants) and the poll-source pattern (`rss.rs` / `agenda.rs`: `IntegrationTask` + `SampleCache` +
telemetry batches). The owner was not available during the run, so the open choices from
`docs/dev/fork-stage0-plan.md` § Stage 1 are decided here with the plan's defaults.

## Options considered
1. **Per-target ping widgets (stock `ping` type) + a Service Health widget per URL.** No new code,
   but no TCP probes, no down-since, no shared card, and every widget polls on the fixed 3 s cadence.
2. **A new fork source `fork/server_check.rs` emitting per-target scalars only**, with the card
   reading `srv.<id>.*` through a config-driven `sensors` map. Clean, but the card would need the
   target list in its own config (duplicating the plugin config) and the hub's history ring is keyed
   per window, so a late-mounting window shows an empty sparkline.
3. **A new fork source emitting per-target scalars AND one `srv.list` JSON sample** that carries each
   target's latest result plus its last 20 latencies (history kept server-side). The card is
   self-sourcing (binds `none`, like the RSS widget); Text/Gauge/Sparkline can still bind the scalars.

## Decision
Option 3.
- **Storage:** `plugins/server-check.json`, plain JSON like `rss.json`. The config holds hosts, ports
  and URLs; `validate_target` rejects URLs with embedded credentials, so there is no secret to protect
  and `secure_config` (DPAPI) would only hide LAN host names from the owner's own disk. Revisit if a
  target ever needs an auth header.
- **Targets live in Studio → Plugins → Server check** (open choice a), not a hand-edited file:
  consistent with every other integration, and the pane validates inline.
- **No Windows toast in v1** (open choice b): it needs `tauri-plugin-notification` plus a capability
  change — a trust-surface edit the owner must approve explicitly. The source already emits
  `srv.<id>.lastDown`, so an alerts rule or a later toast can hang off it without a data change.
- **ICMP sharing:** `ping.rs::{resolve_ipv4, icmp_ping}` become `pub(crate)` (two words) instead of
  moving them into a new common module — the smallest upstream-merge surface.
- **Probes:** ICMP via the shared helper with the target's timeout; TCP `connect` under
  `tokio::time::timeout`; HTTP GET with a per-request timeout, `redirect::Policy::none()` (a 3xx is
  reported as-is), status rule "exact expected status, else < 400", optional body keyword read
  through the existing bounded `http_response::read_body` (256 KiB cap). Error strings are kind-only
  (`io::ErrorKind`, `reqwest::Error::without_url`) so no address or URL reaches a sample.
- **Scheduling:** one task, per-target deadlines, concurrent probes for everything due in a tick, nap
  capped at 5 s so the demand gate is re-read; coming back from idle probes every target at once.
- **Overlay access:** no new overlay-callable command. The overlay only subscribes to `srv.*`
  sensors; `save_server_check_config` and `restart` are studio-gated like the other sources, so
  `layout_grants` is not involved.

## Consequences
- **Positive:** three probe kinds behind one config; the card renders completely from one sample
  (late-mounting windows get history too via `SampleCache`); the four scalars per target make every
  stock meter usable; zero network while no card is mounted.
- **Negative / trade-offs:** history survives only as long as the worker runs (a restart clears the
  ring); "down since" is wall-clock from this machine; the HTTP probe does not follow redirects (by
  design) so a target behind a redirect must point at the final URL; ICMP needs no admin but is
  blind from the agent sandbox — only the live overlay can verify it.
- **Follow-ups:** toast on up→down (owner approval, ADR); an alerts-rule preset for `srv.<id>.up`;
  the owner's layout gets the card after merge (`scripts/snapshot-layout.ps1` first).
