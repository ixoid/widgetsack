# ADR-006: Notification feed — source choice (A1 WinRT listener, unpackaged, probe-gated)

- **Status:** Accepted — the owner accepted the A1 rule at the STEP 4 cost gate (2026-11-08, «Принять A1»); the live probe returned **GO** the same day (owner grant «да»; evidence: run bus `N-1-20261108-1637/probe-record.md`): no prompt, `allowed` directly on build 10.0.26200; 36 → 39 notifications with 3 self-fired synthetic toasts; grant persisted across a process restart without re-prompt. Recovery command if the feed ever goes silently empty: `cargo test probe_live_listener -- --ignored --nocapture` (status kind + count + app names only, never bodies).
- **Date:** 2026-11-08
- **Deciders:** owner (A1 rule + probe grant, STEP 4 cost gate), CTO review (interface contract),
  architect (this record)
- **Feature:** N-1 `notifyfeed` (docs/PRODUCT_ROADMAP.md Vector N)

## Context

The owner wants a read-later feed of Windows toast notifications on the overlay («прилетают пока в
игре — а посмотреть потом негде»). Hard constraints: the app is an **unpackaged** NSIS-installed
Tauri 2 exe (no package identity) on Windows 11 build 26200; the **release build is live** on the
owner's screen (all dev on a `--multi` stand); privacy is absolute (notification bodies never leave
the machine, never in logs/errors/git, no persistence beyond the in-memory ring); v1 is read-only
w.r.t. Windows notifications.

Three source candidates (full matrix: run `research-source.md`):

| Row | A1 WinRT unpackaged | A2 WinRT + sparse package | B `wpndatabase.db` SQLite ro |
|---|---|---|---|
| Backfill / latency | yes / 2–5 s poll | yes / event possible | yes / 2–5 s poll |
| Installer impact | none | msix + signing + NSIS hooks + version rule | none |
| Stability | unsupported-but-observed-working | supported | internal schema, no contract |
| Grant UX | UNCONFIRMED prompt | documented prompt + Settings | none (also: no OS privacy gate) |
| Dismiss (v2+) | yes | yes | no |
| New crates / effort | 2 feature lines / 400–600 ln | A1 + installer work | +rusqlite / 500–800 ln + AUMID names |

**Evidence chain for A1 (chronological):**

1. Microsoft's stated position (2019, windows-uwp#1601): the listener "requires identity and an
   installed package" — Desktop Bridge/UWP only.
2. Current-build reality (2026, WindowsAppSDK#6172, build 26100): an unpackaged app gets
   `UserNotificationListener.Current` working, `RequestAccessAsync` → **Allowed**,
   `GetNotificationsAsync` returning real data; only `NotificationChanged` throws 0x80070490.
   Rivera: "Apps with identity appear to work fine."
3. Production prior art: `dbeuttel/WPUService` — unpackaged .NET 9 tray app, no admin, uses the
   listener in production with a first-launch grant prompt.
4. Contrary evidence: `lwytch/Notifications-Pro` saw "false-positive Allowed" for unpackaged apps
   on some build and ultimately shipped MSIX.
5. Official revocation behavior: revoked access **silently returns an empty list**; MS docs name
   `GetAccessStatus` as the discriminator — but a future build making unpackaged reads silently
   empty while `GetAccessStatus` still says Allowed is **undetectable at runtime**
   (`granted + empty feed` is byte-identical to "no notifications").

## Decision

**Primary: A1** — `Windows.UI.Notifications.Management.UserNotificationListener`, unpackaged,
demand-gated 2–5 s polling of `GetNotificationsAsync` — **behind a dev-stand probe gate**.
**Fallback: B** (read-only `wpndatabase.db`) — automatic on a failed probe, no new owner question.
**A2 (sparse package / external-location identity) is the documented upgrade path, NOT built.**
All three stay interchangeable behind the `NotifySource` seam
(`poll_once() -> Result<Vec<RawNotification>, SourceError>`, kind-only errors) and the
`notify.list` / `notify.count` / `notify.status` sensor contract; the widget and TS types are
source-agnostic, so an override or a later A2 adoption is a backend-file swap.

- **No new crates this run.** Two feature strings on the existing `windows = "0.62"` dep
  (`UI_Notifications`, `UI_Notifications_Management`; research-confirmed feature graph). No CSP,
  no capabilities, no installer change.
- **rusqlite is DEFERRED** until B is actually taken (lean-repo rule: a fallback that may never run
  does not justify a bundled C dependency in every build). If taken: one Cargo line + its own ADR
  (schema fixture pin, `mode=ro` per-poll connection, never `immutable=1`, WAL present).
- **Poll-only, never the event.** `NotificationChanged` is known-broken unpackaged (#6172); a
  read-later feed does not need it. Do not "improve" latency with the event subscription.
- **Read-only stance (v1).** `RemoveNotification`/`ClearNotifications` exist but are never called;
  B opens `mode=ro`. No writes to `wpndatabase.db`, registry, or notification settings, ever.
- **Privacy rules** (CTO contract §5): exclusions at ingest AND retro-purge on config save
  (sync Q1: one shared `is_excluded` matcher, two call sites — ingest and
  `NotifyRing::apply_exclusions`); per-item caps (app 80 / title 160 / body 480 chars) applied at
  ingest, control chars stripped; error kind enums only — never a formatted WinRT/SQLite error
  (`fork/camera/error_map.rs` precedent, and no `log` facade backend, ADR-005 invariant); nothing
  persisted beyond the in-memory ring; config `plugins/notify.json` plain JSON (ADR-002 precedent —
  no secrets, no token URLs).
- **WinRT threading:** `RequestAccessAsync` once per worker start (the documented prompt trigger);
  `GetAccessStatus` per cycle (repeat requests instantly return Denied); blocking `.get()` calls
  only inside `tokio::task::spawn_blocking` (camera `load_blocking` / win-gsmtc precedent).

### Probe gate (BLOCKED until the owner's explicit «да»)

30-minute probe on the `--multi` dev stand, **our own synthetic toasts only** (fired via the
Windows toast XML API under a well-known installed AUMID, e.g. PowerShell's). The probe reads the
owner's real Action Center into process memory — that is why it needs the owner's word
(project boundary). Pass criteria (research §"Open UNCONFIRMED" 1–2):

1. **Prompt behavior:** `RequestAccessAsync` from the unpackaged dev exe raises the real OS prompt
   (and/or a visible entry under Settings → Privacy & security → Notifications), not a silent
   Allowed.
2. **Read parity:** after the grant, `GetNotificationsAsync(Toast)` returns the synthetic toasts
   with correct display name, `CreationTime` and text elements; repeated polls diff cleanly by
   `Id`; the mapper output matches the fixture-tested seam.
3. **Persistence:** the grant survives a dev-stand restart (own PID stop/start) and revoking it in
   Settings flips `GetAccessStatus` off Allowed (proves the discriminator works on 26200).

Fail any → B is taken automatically (its own ADR records the schema pin + rusqlite). The probe may
log: status kinds, item counts, and the app names of OUR synthetic toasts — never bodies or
titles, and never the contents of the owner's real notifications.

## Consequences

- **Positive:** zero installer/signing change to the just-shipped NSIS release; the official read
  API with backfill, display names for free and a dismiss path for v2; two independent current
  sources show reads work unpackaged; backend swap = one module behind the seam.
- **Negative / trade-off:** A1 is an unsupported scenario — any Windows update can make unpackaged
  reads silently return empty while the widget shows a healthy empty state; detection is manual
  (the owner notices the feed died), recovery is a manual probe, the B fallback, or A2's one-time
  signing obligation (self-signed cert + TrustedPeople import + msix asset + Add/Remove-AppxPackage
  hooks + a version-bump rule on every upgrade — the fork's first code-signing cost). This rule is
  priced for the owner in the run record (`architecture-decision.md` § Цена правила); the empty
  state copy must stay neutral and never claim "all working".
- **Follow-ups:** A2 upgrade procedure stays documented (not built); if B is taken, pin the mapper
  by fixture and locate the DB at runtime; app icons, auto-clear timer, per-item dismiss and a
  clear-feed action are backlog.

**Cross-references:** ADR-002 (plain plugin config, no secrets → no DPAPI), ADR-005 (`gate.rs`
layout-gate and `error_map.rs` kind-only-error precedents; no-log-facade invariant).
