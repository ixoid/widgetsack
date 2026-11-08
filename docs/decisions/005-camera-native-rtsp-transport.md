# ADR-005: Camera widget — native in-process RTSP (retina → Tauri Channel → WebCodecs)

- **Status:** Accepted (phase 1 spike pending; superseded by the fallback below on a spike no-go)
- **Date:** 2026-11-08
- **Deciders:** owner (transport A, "native, with a spike; on failure go2rtc", 2026-11-08); CTO review
  (interface contract); architect (this record)

## Context
C-1 shows one LAN camera (an Aqara door lock with a camera, RTSP `:8554`, path `ch2`, H.264 per
every public Aqara source) as an ordinary overlay widget. The owner's hard requirement: the camera
login/password live only in `secure_config` (DPAPI) and in the memory of our own process (or a child
we fully control) — never in the webview, never in plaintext on disk, never on a command line, never
in logs/errors, never readable through an unauthenticated local API. Setup must be "three fields in
Studio, everything else starts itself".

Constraints from the codebase: CSP `connect-src 'self' ipc: http://ipc.localhost` (an `iframe`/
`customhtml` cannot reach a loopback media server); Tauri `Channel` already streams per-window data
for the spectrum widget (`audio.rs`); `secure_config.rs` gives DPAPI read/write; the overlay may call
only what the saved layout grants (`layout_grants.rs`).

## Options considered (full matrix: run record `research-transport.md` §3)
1. **A. Native: `retina` RTSP client in Rust → H.264 access units over a Tauri `Channel` →
   WebCodecs `VideoDecoder` → `<canvas>`.** No child, no port, no CSP change; ~0.15–0.4 s latency.
   Risk: retina is 0.4.x with one maintainer and is untested against this firmware.
2. **A′. Same backend, fMP4 muxed in TS → MSE `<video>` via `blob:`.** Renderer fallback inside A
   only if WebCodecs alone fails.
3. **B. Bundled go2rtc child (hardened) + WHEP proxied through Rust.** Mature, H.265 paths; but
   8 default holes must be closed (all-interface API/RTSP/WebRTC listeners, `local_auth`, `/api/streams`
   leaking producer URLs with credentials, logs, inline `-c`), a sidecar to pin and update, and a
   per-launch API secret that may have to live in a generated file.
4. **C. MediaMTX child.** Same shape and cost as B.
5. **D. ffmpeg child.** Credentials on argv — violates the requirement. Rejected.
6. **E. Snapshot/MJPEG.** Aqara exposes no HTTP snapshot/ONVIF; would be A without the video. Rejected.

## Decision
Option **A**, delivered in two phases: a ≤1-day spike (vertical slice against the real camera),
then the full widget. All new code lives in `widgetsack/src/fork/camera/` and
`client/src/lib/widgets/fork/camera/`; core files get registration lines only.

- **Dependency:** `retina = "=0.4.21"` (default features, incl. `h265` depacketisation so an H.265
  SDP is reported, not mis-parsed) and `url = "2"` (already transitive). Licences: retina MIT/Apache-2.0;
  all 22 new transitive crates MIT, MIT/Apache-2.0 or BSD-2/Apache/MIT — compatible with the repo's
  `MIT OR Apache-2.0`. Pinned exactly; bump deliberately with a re-run of the fake-RTSP tests.
- **Framing:** `FrameFormat::MP4` (4-byte length-prefixed NALs, `extra_data()` = avcC) maps 1:1 onto
  WebCodecs `avc` with `description`; no Annex-B conversion. Media frames go as
  `InvokeResponseBody::Raw`, status as `Json`, on one per-subscriber `Channel` (ordered by the JS
  Channel's message index).
- **Demand gate:** video is not a `SensorSample`; demand = `camera_subscribe` count per `(window, key)`.
  One RTSP session per camera fan-outs to all subscribers; it starts on 0→1 and is torn down 2 s after
  1→0.
- **Backpressure:** application-level `camera_ack` (the Tauri channel queue is unbounded and gives no
  lag signal); more than 24 frames in flight → drop deltas until the next keyframe.
- **No CSP change, no capability change, no child process, no listening port.**

### Credential flow
```
Studio pane (password input, write-only, cleared after save)
   │ invoke save_camera_config {url, username?, password?}   [studio window only]
   ▼
Rust config.rs: split_url (user:pass@ → fields) · validate · Secret(Debug="***")
   │ secure_config::write  (DPAPI CurrentUser, "widgetsack-dpapi-v1:" prefix)
   ▼
%APPDATA%\io.github.gyng\plugins\camera.json   {url (no userinfo), username, password}
   │ secure_config::read in spawn_blocking, per connect attempt
   ▼
worker locals → retina::Credentials (built just before describe, dropped after; never formatted)
   │ RTSP/TCP interleaved, Basic/Digest as the camera challenges
   ▼
camera ─RTP→ retina demux ─AU bytes→ Channel(Raw) ─→ webview: VideoDecoder → canvas
webview receives only: CameraStatus {host, port, path, hasUsername, hasPassword, state, codec, WxH}
```

## Consequences
- **Good:** the credential never leaves our process; nothing to bundle, start, firewall or update;
  latency well under the ≤1 s target; P-1 packaging inherits nothing.
- **Bad:** we own RTSP reconnect, backoff, keyframe gating and backpressure (≈1 400 Rust + ≈1 200 TS
  lines incl. tests). retina is a single-maintainer 0.4.x crate. +22 crates and second copies of
  `rand 0.8`/`rand_core 0.6`/`getrandom 0.2`/`base64 0.22`/`socket2 0.5`/`windows-sys 0.52` in the
  lock (isolated `cargo check` of retina + tokio + url: 9 s on this machine).
- **Rule priced for the owner:** wait-for-keyframe after every (re)connect costs up to one GOP of
  stale/blank picture (run record `architecture-decision.md` § Цена правила).
- **Residual risks (accepted):** RTSP Basic/Digest is cleartext/replayable on the LAN (camera
  property); same-user malware can read our process memory (same boundary as DPAPI CurrentUser).
- **Invariants:** no `log` backend is installed (retina logs via the `log` facade); retina errors,
  `Credentials`, `SessionOptions` are never formatted; a retina `Session` is dropped only inside the
  tokio runtime (its drop spawns the TEARDOWN task).

### Fallback trigger (option B, no new owner question)
The spike is NO-GO when any of: retina fails DESCRIBE/SETUP/PLAY against this firmware; the codec is
not H.264 and not decodable; frames are corrupt with a correct avcC; the Aqara Home app cannot open
live view while our session runs and lowering session churn does not fix it; or WebCodecs fails and
the A′ MSE rule does not apply. Then this ADR is marked Superseded and a new ADR records B (hardened
go2rtc sidecar, credentials via child env only, WHEP proxied through `invoke`, CSP unchanged unless
proxying proves impossible). Kept from A: `config.rs`, the Studio pane, `save`/`status` commands,
error kinds, subscriber registry, layout gate, client model. The coordinator asks the owner one
question at that point: whether the go2rtc per-launch API secret may live in a user-only generated
file if env substitution in `api:` does not work.
