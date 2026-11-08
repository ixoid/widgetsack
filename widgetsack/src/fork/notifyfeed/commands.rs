//! Tauri commands of the notifyfeed source. `save_notify_config` is studio-only (the other
//! plugin-config saves); `notify_config_status`, `notify_connect`, `notify_disconnect` are open
//! (agenda parity — the status carries no secrets, and disconnect stops the worker for every
//! window, a precedent flagged for the security step); `notify_mark_all_seen` mutates only the
//! in-memory seen stamp and is layout-grant-gated for overlays (camera gate clone). The save and
//! mark handlers are thin adapters over the pure seams (`validate_config`, `apply_exclusions`,
//! `sync_emit`) — their logic is covered by the ring/config tests (sync Q1).

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Runtime, State};

use super::NotifyState;
use super::config::{self, NotifyConfig};
use super::{now_ms, sync_emit};

/// Studio guard for the config save (pure; the message names the command, never the input).
fn ensure_studio(label: &str, command: &str) -> Result<(), String> {
    if label != "studio" {
        return Err(format!("{command} is only allowed from the studio window"));
    }
    Ok(())
}

/// Persist `plugins/notify.json` (plain JSON, defaults-friendly). After a successful write the
/// exclusion list retro-purges the ring and the meter re-emits at once (sync Q1) — even while the
/// worker is idle or not started, because the ring lives in app state.
#[tauri::command]
pub async fn save_notify_config<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    app: AppHandle<R>,
    state: State<'_, NotifyState>,
    config: NotifyConfig,
) -> Result<(), String> {
    ensure_studio(window.label(), "save_notify_config")?;
    let cfg = config::validate_config(&config)?;
    let exclusions = cfg.exclusions.clone();
    let path = config::config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let txt = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    crate::file_io::atomic_write(&path, &txt)?;
    let dropped = state
        .ring
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .apply_exclusions(&exclusions);
    if dropped > 0 {
        eprintln!("notifyfeed: exclusion purge dropped {dropped} items");
    }
    sync_emit(&app, true);
    Ok(())
}

/// The secret-free status of the saved config (defaults when the file is absent).
#[tauri::command]
pub async fn notify_config_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<config::NotifyStatus, String> {
    let cfg = tokio::task::spawn_blocking(move || config::load_config(&app))
        .await
        .map_err(|e| e.to_string())??;
    Ok(config::status_of(cfg.as_ref()))
}

/// Start the poll worker if not already running. Idempotent + demand-gated; `restart` (studio
/// only) swaps in the saved config — the RING survives the swap (game-session rule).
#[tauri::command]
pub async fn notify_connect<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    app: AppHandle<R>,
    state: State<'_, NotifyState>,
    restart: Option<bool>,
) -> Result<(), String> {
    let restart = restart.unwrap_or(false);
    if restart && window.label() != "studio" {
        return Err("integration restart is only allowed from the studio window".into());
    }
    state
        .task
        .start(restart, || {
            let cfg = config::load_config(&app)?.unwrap_or_default();
            let app_for_task = app.clone();
            Ok(Some(async move {
                super::run_notify_worker(app_for_task, cfg).await;
            }))
        })
        .await
}

/// Stop the worker for every window (agenda parity). The ring is kept: a later `notify_connect`
/// resumes with the feed intact.
#[tauri::command]
pub async fn notify_disconnect(state: State<'_, NotifyState>) -> Result<(), String> {
    state.task.stop().await;
    state.latest.clear();
    Ok(())
}

/// Mark every ring item as seen (`last_mark_ms = now`) and re-emit at once. Open to the studio;
/// an overlay needs a Notifyfeed widget in its SAVED layout (gate).
#[tauri::command]
pub async fn notify_mark_all_seen<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    app: AppHandle<R>,
    state: State<'_, NotifyState>,
) -> Result<(), String> {
    super::gate::authorize_saved(&app, window.label()).await?;
    state.last_mark_ms.store(now_ms(), Ordering::SeqCst);
    sync_emit(&app, true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_studio_window_passes_the_save_guard() {
        assert!(ensure_studio("studio", "save_notify_config").is_ok());
        for label in ["main", "overlay-1", "Studio", ""] {
            assert_eq!(
                ensure_studio(label, "save_notify_config").unwrap_err(),
                "save_notify_config is only allowed from the studio window"
            );
        }
    }
}
