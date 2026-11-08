//! `camera_probe` core: a DESCRIBE-only check of the SAVED config (no PLAY, no address argument).
//! It spends a login attempt on the camera, so it is single-flight, at least `PROBE_INTERVAL` apart,
//! and honours (and sets) the shared 401/403 lockout (ADD G).

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use retina::codec::ParametersRef;

use super::Shared;
use super::config::{self, CameraConfig};
use super::types::{CameraErrorKind, ProbeResult};
use super::worker;

pub const PROBE_INTERVAL: Duration = Duration::from_secs(2);

pub const ERR_BUSY: &str = "a camera test is already running";
pub const ERR_TOO_SOON: &str = "wait 2 seconds between camera tests";
pub const ERR_NOT_CONFIGURED: &str = "camera is not configured";

/// Single-flight + throttle state.
#[derive(Default)]
pub struct ProbeGate {
    busy: AtomicBool,
    last_start: Mutex<Option<Instant>>,
}

/// Clears `busy` however the probe ends (including a cancelled command future).
struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Pure throttle rule.
fn too_soon(last_start: Option<Instant>, now: Instant) -> bool {
    last_start.is_some_and(|t| now.duration_since(t) < PROBE_INTERVAL)
}

fn failed(kind: CameraErrorKind) -> ProbeResult {
    ProbeResult {
        ok: false,
        kind: Some(kind),
        ..ProbeResult::default()
    }
}

/// Runs a probe of `config` under the gate. A lockout refusal is an `Ok` result with
/// `kind = authFailed` (no network); busy / too soon / not configured are fixed `Err` strings.
/// `generation` is the config generation read BEFORE `config` was loaded, so a save that lands
/// during DESCRIBE is not locked out by a 401 of the old login.
pub async fn run(
    gate: &ProbeGate,
    shared: &Shared,
    generation: u64,
    config: Option<CameraConfig>,
    step_timeout: Duration,
) -> Result<ProbeResult, String> {
    if gate.busy.swap(true, Ordering::SeqCst) {
        return Err(ERR_BUSY.into());
    }
    let _busy = BusyGuard(&gate.busy);
    if shared.auth_locked() {
        return Ok(failed(CameraErrorKind::AuthFailed));
    }
    {
        let mut last = gate.last_start.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if too_soon(*last, now) {
            return Err(ERR_TOO_SOON.into());
        }
        *last = Some(now);
    }
    let config = config
        .filter(|c| config::validate_address(&c.url).is_ok())
        .ok_or_else(|| ERR_NOT_CONFIGURED.to_string())?;
    let described = worker::describe(&config, step_timeout).await;
    drop(config);
    let (session, stream_i) = match described {
        Ok(v) => v,
        Err(kind) => {
            if kind == CameraErrorKind::AuthFailed {
                shared.lock_auth_for(generation);
            }
            return Ok(failed(kind));
        }
    };
    let stream = &session.streams()[stream_i];
    let codec = Some(worker::codec_name(stream));
    let (width, height) = match stream.parameters() {
        Some(ParametersRef::Video(p)) => {
            let (w, h) = p.pixel_dimensions();
            (Some(w), Some(h))
        }
        _ => (None, None),
    };
    let fps = stream.framerate().map(f64::from);
    let result = if worker::is_h264(stream) {
        ProbeResult {
            ok: true,
            kind: None,
            codec,
            width,
            height,
            fps,
        }
    } else {
        ProbeResult {
            ok: false,
            kind: Some(CameraErrorKind::UnsupportedCodec),
            codec,
            width,
            height,
            fps,
        }
    };
    // `session` (DESCRIBE only, no SETUP) drops here, inside the command's tokio task.
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fork::camera::config::Secret;
    use crate::fork::camera::fake_rtsp::{self, FakeOptions, FakeRtsp};

    fn cfg(url: &str, pass: &str) -> Option<CameraConfig> {
        Some(CameraConfig {
            url: url.to_string(),
            username: fake_rtsp::USER.to_string(),
            password: Secret::new(pass),
        })
    }

    const STEP: Duration = Duration::from_secs(2);

    fn assert_no_leak(text: &str, port: u16) {
        for needle in [
            fake_rtsp::USER,
            fake_rtsp::PASS,
            "wrong_pw",
            "127.0.0.1",
            "rtsp://",
            &port.to_string(),
        ] {
            assert!(!text.contains(needle), "{text:?} leaks {needle}");
        }
    }

    #[tokio::test]
    async fn a_good_config_reports_codec_size_and_fps() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let gate = ProbeGate::default();
        let shared = Shared::default();
        let result = run(&gate, &shared, 0, cfg(&fake.url(), fake_rtsp::PASS), STEP)
            .await
            .unwrap();
        assert_eq!(
            result,
            ProbeResult {
                ok: true,
                kind: None,
                codec: Some("H264".into()),
                width: Some(1920),
                height: Some(1080),
                fps: Some(15.0),
            }
        );
        assert_no_leak(&serde_json::to_string(&result).unwrap(), fake.port);
        assert!(!gate.busy.load(Ordering::SeqCst), "busy flag released");
    }

    #[tokio::test]
    async fn wrong_credentials_fail_once_then_the_lockout_refuses_without_network() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let gate = ProbeGate::default();
        let shared = Shared::default();
        let first = run(&gate, &shared, 0, cfg(&fake.url(), "wrong_pw"), STEP)
            .await
            .unwrap();
        assert!(!first.ok);
        assert_eq!(first.kind, Some(CameraErrorKind::AuthFailed));
        assert!(shared.auth_locked());
        assert_no_leak(&serde_json::to_string(&first).unwrap(), fake.port);
        assert_no_leak(&format!("{first:?}"), fake.port);

        let second = run(&gate, &shared, 0, cfg(&fake.url(), fake_rtsp::PASS), STEP)
            .await
            .unwrap();
        assert_eq!(second.kind, Some(CameraErrorKind::AuthFailed));
        assert_eq!(fake.accepts(), 1, "the refused probe never connected");
    }

    #[tokio::test]
    async fn throttle_busy_and_missing_config_are_fixed_errors() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let gate = ProbeGate::default();
        let shared = Shared::default();
        run(&gate, &shared, 0, cfg(&fake.url(), fake_rtsp::PASS), STEP)
            .await
            .unwrap();
        let err = run(&gate, &shared, 0, cfg(&fake.url(), fake_rtsp::PASS), STEP)
            .await
            .unwrap_err();
        assert_eq!(err, ERR_TOO_SOON);
        assert_eq!(fake.accepts(), 1);

        gate.busy.store(true, Ordering::SeqCst);
        let err = run(&ProbeGate::default(), &shared, 0, None, STEP)
            .await
            .unwrap_err();
        assert_eq!(err, ERR_NOT_CONFIGURED);
        let err = run(&gate, &shared, 0, None, STEP).await.unwrap_err();
        assert_eq!(err, ERR_BUSY);
        assert!(
            gate.busy.load(Ordering::SeqCst),
            "a refused call keeps the owner's flag"
        );

        let bad = Some(CameraConfig {
            url: "http://x/".into(),
            ..CameraConfig::default()
        });
        let err = run(&ProbeGate::default(), &shared, 0, bad, STEP)
            .await
            .unwrap_err();
        assert_eq!(err, ERR_NOT_CONFIGURED);
        for text in [ERR_BUSY, ERR_TOO_SOON, ERR_NOT_CONFIGURED] {
            assert_no_leak(text, fake.port);
        }
    }

    #[tokio::test]
    async fn a_connection_closed_without_an_answer_maps_to_unreachable() {
        let (port, server) = fake_rtsp::closing_listener().await;
        let result = run(
            &ProbeGate::default(),
            &Shared::default(),
            0,
            cfg(&format!("rtsp://127.0.0.1:{port}/ch2"), fake_rtsp::PASS),
            STEP,
        )
        .await
        .unwrap();
        server.abort();
        assert_eq!(result.kind, Some(CameraErrorKind::Unreachable));
        assert_no_leak(&serde_json::to_string(&result).unwrap(), port);
    }

    #[tokio::test]
    async fn a_non_h264_stream_is_reported_as_unsupported() {
        let fake = FakeRtsp::start(FakeOptions {
            encoding: "H265",
            ..FakeOptions::default()
        })
        .await;
        let result = run(
            &ProbeGate::default(),
            &Shared::default(),
            0,
            cfg(&fake.url(), fake_rtsp::PASS),
            STEP,
        )
        .await
        .unwrap();
        assert!(!result.ok);
        assert_eq!(result.kind, Some(CameraErrorKind::UnsupportedCodec));
        assert_eq!(result.codec.as_deref(), Some("H265"));
    }

    #[test]
    fn throttle_rule() {
        let now = Instant::now();
        assert!(!too_soon(None, now));
        assert!(too_soon(Some(now), now + Duration::from_millis(1999)));
        assert!(!too_soon(Some(now), now + PROBE_INTERVAL));
    }
}
