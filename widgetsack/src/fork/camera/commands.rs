//! Tauri commands of the camera widget (config only in this batch). Save is studio-only; the status
//! read is open to every window because it carries no secret (host/port/path and booleans).

use tauri::{AppHandle, Manager, Runtime};

use super::CameraState;
use super::config::{self, SaveInput};
use super::types::{CameraStatus, SaveResult};

/// Pure studio guard (testable without a window). The message names the command, not the input.
fn ensure_studio(label: &str, command: &str) -> Result<(), String> {
    if label != "studio" {
        return Err(format!("{command} is only allowed from the studio window"));
    }
    Ok(())
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
    tokio::task::spawn_blocking(move || {
        let state = app.state::<CameraState>();
        let _guard = state.lock_save();
        let path = config::config_path(&app)?;
        let result = config::save_input(&path, input)?;
        state.bump_generation();
        Ok(result)
    })
    .await
    .map_err(|_| "camera config save failed".to_string())?
}

/// The secret-free status of the saved config. Not studio-gated: it returns no credential or URL.
#[tauri::command]
pub async fn camera_config_status<R: Runtime>(app: AppHandle<R>) -> Result<CameraStatus, String> {
    tokio::task::spawn_blocking(move || {
        let path = config::config_path(&app)?;
        let cfg = config::load_from(&path)?;
        Ok(config::to_status(cfg.as_ref()))
    })
    .await
    .map_err(|_| "camera config read failed".to_string())?
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
}
