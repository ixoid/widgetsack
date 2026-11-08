//! Tauri commands of the camera widget. Save is studio-only. Probe and subscribe are open to the
//! studio and to overlays whose SAVED layout contains a Camera widget (`gate`). The status read is
//! open to every window because it carries no secret (host/port/path and booleans). Unsubscribe and
//! ack only touch the caller's own `(window, key)`.

use std::sync::Arc;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Runtime};

use super::config::{self, SaveInput};
use super::registry::Start;
use super::types::{CameraStatus, ProbeResult, SaveResult, StreamState};
use super::worker::{self, LoadConfig, WorkerOptions};
use super::{CameraState, Shared, gate, probe};

const MAX_KEY_LEN: usize = 64;

/// Pure studio guard (testable without a window). The message names the command, not the input.
fn ensure_studio(label: &str, command: &str) -> Result<(), String> {
    if label != "studio" {
        return Err(format!("{command} is only allowed from the studio window"));
    }
    Ok(())
}

/// Stream key = widget instance id: 1..=64 of `[A-Za-z0-9_-]`. The error never echoes the key.
fn validate_key(key: &str) -> Result<(), String> {
    let ok = !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(())
    } else {
        Err("camera stream key must be 1-64 letters, digits, '_' or '-'".into())
    }
}

/// Overlays the live auth lockout onto the file-derived status.
fn with_lockout(mut status: CameraStatus, shared: &Shared) -> CameraStatus {
    status.auth_locked_until_ms = shared.auth_locked_until_ms();
    if status.configured && status.auth_locked_until_ms.is_some() {
        status.state = StreamState::AuthFailed;
    }
    status
}

/// A loader reading the saved config through DPAPI (the worker runs it in `spawn_blocking`).
fn file_loader<R: Runtime>(app: AppHandle<R>) -> LoadConfig {
    Arc::new(move || config::load_from(&config::config_path(&app)?))
}

async fn load_blocking<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<config::CameraConfig>, String> {
    tokio::task::spawn_blocking(move || config::load_from(&config::config_path(&app)?))
        .await
        .map_err(|_| "camera config read failed".to_string())?
}

/// Save the address and (write-only) login. Blank login/password keep the stored ones. Returns what
/// the save did beyond writing so the pane can explain it.
#[tauri::command]
pub async fn save_camera_config<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    app: AppHandle<R>,
    url: String,
    username: Option<String>,
    password: Option<String>,
    clear_credentials: Option<bool>,
) -> Result<SaveResult, String> {
    ensure_studio(window.label(), "save_camera_config")?;
    let input = SaveInput {
        url,
        username,
        password,
        clear_credentials: clear_credentials.unwrap_or(false),
    };
    // DPAPI + file IO stay off the async worker threads.
    let blocking_app = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let app = blocking_app;
        let state = app.state::<CameraState>();
        let _guard = state.lock_save();
        let path = config::config_path(&app)?;
        let result = config::save_input(&path, input)?;
        state.bump_generation();
        Ok::<_, String>(result)
    })
    .await
    .map_err(|_| "camera config save failed".to_string())??;
    // A live session still runs on the old address/login: restart it in the background (the old
    // session is torn down first), so the save does not wait for the TEARDOWN.
    let hub = Arc::clone(&app.state::<CameraState>().hub);
    tokio::spawn(async move { hub.restart().await });
    Ok(result)
}

/// The secret-free status of the saved config. Not studio-gated: it returns no credential or URL.
#[tauri::command]
pub async fn camera_config_status<R: Runtime>(app: AppHandle<R>) -> Result<CameraStatus, String> {
    let cfg = load_blocking(app.clone()).await?;
    let state = app.state::<CameraState>();
    Ok(with_lockout(
        config::to_status(cfg.as_ref()),
        state.shared(),
    ))
}

/// DESCRIBE-only check of the SAVED config (takes no address). It spends a login attempt on the
/// camera, so it is single-flight and throttled; an overlay needs a Camera widget in its saved layout.
#[tauri::command]
pub async fn camera_probe<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    app: AppHandle<R>,
) -> Result<ProbeResult, String> {
    gate::authorize_saved(&app, window.label()).await?;
    let generation = app.state::<CameraState>().shared().generation();
    let cfg = load_blocking(app.clone()).await?;
    let state = app.state::<CameraState>();
    probe::run(
        &state.probe,
        state.shared(),
        generation,
        cfg,
        worker::STEP_TIMEOUT,
    )
    .await
}

/// Start streaming into `channel` (Raw CONFIG/FRAME messages + Json status events). Subscribers
/// share one RTSP session; subscribing again with the same `(window, key)` replaces the entry. An
/// overlay needs a Camera widget in its saved layout.
#[tauri::command]
pub async fn camera_subscribe<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    app: AppHandle<R>,
    channel: Channel<InvokeResponseBody>,
    key: String,
) -> Result<CameraStatus, String> {
    gate::authorize_saved(&app, window.label()).await?;
    validate_key(&key)?;
    let cfg = load_blocking(app.clone()).await?;
    let state = app.state::<CameraState>();
    let status = with_lockout(config::to_status(cfg.as_ref()), state.shared());
    drop(cfg);
    state.hub.subscribe(
        window.label(),
        &key,
        channel,
        Start {
            load: file_loader(app.clone()),
            shared: Arc::clone(state.shared()),
            options: WorkerOptions::default(),
        },
    );
    Ok(status)
}

/// Remove the caller's own subscriber; anything else (another window's or key's) is a no-op. The
/// stream stops 2 s after the last one leaves.
#[tauri::command]
pub async fn camera_unsubscribe<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    app: AppHandle<R>,
    key: String,
) -> Result<(), String> {
    validate_key(&key)?;
    app.state::<CameraState>()
        .hub
        .unsubscribe(window.label(), &key);
    Ok(())
}

/// Flow control: the client confirms it has handled frame `seq` (it acks every 8 frames and every
/// keyframe). An unknown `(window, key)` is a no-op, so a late ack after unsubscribe is harmless.
/// Open to studio and overlay: it only moves the caller's own counter.
#[tauri::command]
pub async fn camera_ack<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    app: AppHandle<R>,
    key: String,
    seq: u32,
) -> Result<(), String> {
    app.state::<CameraState>()
        .hub
        .ack(window.label(), &key, seq);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_studio_window_passes_the_guard() {
        assert!(ensure_studio("studio", "save_camera_config").is_ok());
        for label in ["main", "overlay-1", "Studio", ""] {
            let err = ensure_studio(label, "save_camera_config").unwrap_err();
            assert_eq!(
                err,
                "save_camera_config is only allowed from the studio window"
            );
        }
    }

    #[test]
    fn stream_keys_are_short_and_plain() {
        for ok in ["w1", "camera-1_A", &"a".repeat(64)] {
            assert!(validate_key(ok).is_ok(), "{ok}");
        }
        for bad in ["", "a b", "a/b", "ключ", "x.y", &"a".repeat(65)] {
            // Fixed text: the key is never echoed.
            assert_eq!(
                validate_key(bad).unwrap_err(),
                "camera stream key must be 1-64 letters, digits, '_' or '-'",
                "{bad}"
            );
        }
    }

    #[test]
    fn lockout_overlays_the_status() {
        let shared = Shared::default();
        let cfg = config::CameraConfig {
            url: "rtsp://192.168.0.5:8554/ch2".into(),
            ..config::CameraConfig::default()
        };
        let status = with_lockout(config::to_status(Some(&cfg)), &shared);
        assert_eq!(status.state, StreamState::Idle);
        assert_eq!(status.auth_locked_until_ms, None);
        shared.lock_auth_for(shared.generation());
        let status = with_lockout(config::to_status(Some(&cfg)), &shared);
        assert_eq!(status.state, StreamState::AuthFailed);
        assert!(status.auth_locked_until_ms.is_some());
        let status = with_lockout(config::to_status(None), &shared);
        assert_eq!(status.state, StreamState::NotConfigured);
    }
}
