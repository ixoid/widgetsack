//! HWiNFO hardware sensors (fork, roadmap H-1): CPU temperature, effective clocks and package power
//! — plus any HWiNFO reading the user enables — as `hw.*` telemetry. HWiNFO64 publishes its sensor
//! table through two read-only interfaces (ADR-003); this source reads whichever is available:
//! shared memory (`shared_mem.rs`, the full catalog, must be switched on in HWiNFO) first, else the
//! registry gadget mirror (`registry.rs`, the readings ticked in HWiNFO, on by default for Rainmeter
//! users). Both produce `model::Reading`s; `model.rs` derives the well-known `hw.cpu.*` ids and the
//! `hw.<slug>` catalog from them.
//!
//! App-owned integration worker like stocks.rs: `IntegrationTask` + `SampleCache` + `prime_window`,
//! config in `plugins/hwinfo.json` (nothing secret), demand-gated on the `hw.` prefix so it costs
//! nothing until a widget binds an `hw.*` sensor. No network, no child process, no writes outside
//! the config file.

pub mod model;
pub mod registry;
pub mod shared_mem;

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::sensors::{ActiveSensors, SensorSample, TELEMETRY_EVENT};
use model::{CatalogEntry, Reading};

/// How often to re-check the demand gate while nothing wants `hw.*`.
const IDLE_RECHECK: Duration = Duration::from_secs(3);
/// How long to wait before retrying when HWiNFO is not reachable at all.
const UNAVAILABLE_RETRY: Duration = Duration::from_secs(5);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn default_poll() -> u64 {
    model::DEFAULT_POLL_SECS
}

/// `plugins/hwinfo.json`. `#[serde(default)]` everywhere so a partial or hand-edited file parses.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HwinfoConfig {
    #[serde(default = "default_poll")]
    pub poll_seconds: u64,
    /// Catalog slugs (`hw.<slug>`) the user enabled in the settings pane.
    #[serde(default)]
    pub enabled: Vec<String>,
}

impl Default for HwinfoConfig {
    fn default() -> Self {
        Self {
            poll_seconds: default_poll(),
            enabled: Vec::new(),
        }
    }
}

/// Which HWiNFO interface answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Backend {
    SharedMemory,
    Registry,
    None,
}

/// What the webview learns (all non-secret). camelCase on the wire ↔ `hwinfo-types.ts`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwinfoStatus {
    pub configured: bool,
    pub poll_seconds: u64,
    pub enabled: Vec<String>,
    /// `HWiNFO64.exe` is running (process table), regardless of which interface is on.
    pub running: bool,
    pub backend: Backend,
    /// HWiNFO's own gadget-reporting flag (`None` when HWiNFO has never written its settings).
    pub gadget_enabled: Option<bool>,
    /// One human line for the pane: what was found, or what is missing and how to fix it.
    pub detail: String,
    pub readings: Vec<CatalogEntry>,
}

/// Managed state: the running worker + the latest batch for priming late-mounting windows.
#[derive(Default)]
pub struct HwinfoState {
    task: crate::integration_task::IntegrationTask,
    latest: crate::sample_cache::SampleCache,
}

// ---- config I/O ----

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = crate::file_io::config_root(app)?;
    Ok(dir.join("plugins").join("hwinfo.json"))
}

pub fn load_config<R: Runtime>(app: &AppHandle<R>) -> Result<Option<HwinfoConfig>, String> {
    let path = config_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(txt) => serde_json::from_str(&txt)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// Keep only slugs we could have produced, deduped, capped. Pure.
pub fn sanitize_enabled(enabled: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in enabled {
        let s = s.trim().to_string();
        if model::valid_slug(&s) && !out.contains(&s) {
            out.push(s);
        }
        if out.len() >= model::MAX_ENABLED {
            break;
        }
    }
    out
}

// ---- reading HWiNFO (blocking, run on the blocking pool) ----

/// One read of whichever interface is available, plus a human detail line.
pub struct Probe {
    pub backend: Backend,
    pub readings: Vec<Reading>,
    pub detail: String,
}

/// Try shared memory, then the registry mirror. Pure given the two readers (injected for tests).
pub fn probe_with(
    shared: impl FnOnce() -> Result<shared_mem::Snapshot, shared_mem::LiveError>,
    gadget: impl FnOnce() -> Result<Vec<Reading>, String>,
    gadget_flag: Option<bool>,
) -> Probe {
    let shared_detail = match shared() {
        Ok(snap) => {
            let n = snap.readings.len();
            return Probe {
                backend: Backend::SharedMemory,
                readings: snap.readings,
                detail: format!("shared memory · {n} readings"),
            };
        }
        Err(shared_mem::LiveError::NotFound) => None,
        Err(other) => Some(other.to_string()),
    };
    match gadget() {
        Ok(readings) if !readings.is_empty() => {
            let n = readings.len();
            Probe {
                backend: Backend::Registry,
                readings,
                detail: format!(
                    "gadget registry · {n} readings — enable Shared Memory Support in HWiNFO for the full catalog"
                ),
            }
        }
        Ok(_) => Probe {
            backend: Backend::None,
            readings: Vec::new(),
            detail: shared_detail.unwrap_or_else(|| {
                if gadget_flag == Some(false) {
                    "HWiNFO gadget reporting is off and shared memory is not available".to_string()
                } else {
                    "HWiNFO exposes no readings yet — tick some in its Sensors window (gadget) or enable Shared Memory Support".to_string()
                }
            }),
        },
        Err(err) => Probe {
            backend: Backend::None,
            readings: Vec::new(),
            detail: shared_detail.unwrap_or(err),
        },
    }
}

fn probe() -> Probe {
    probe_with(
        shared_mem::read_live,
        registry::read_live,
        registry::gadget_enabled(),
    )
}

/// Is `HWiNFO64.exe` (or the 32-bit build) in the process table? A process-table refresh costs
/// tens of ms, so this runs only in the status command and when a poll finds no interface.
fn hwinfo_running() -> bool {
    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.processes()
        .values()
        .any(|p| is_hwinfo_process(&p.name().to_string_lossy()))
}

/// Case-insensitive match on HWiNFO's executable names. Pure.
fn is_hwinfo_process(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "hwinfo64.exe" || n == "hwinfo32.exe" || n == "hwinfo64" || n == "hwinfo32"
}

// ---- telemetry emission ----

fn emit_batch<R: Runtime>(app: &AppHandle<R>, batch: &[SensorSample]) {
    if let Some(state) = app.try_state::<HwinfoState>() {
        state.latest.remember(batch);
    }
    let _ = app.emit(TELEMETRY_EVENT, batch);
}

fn emit_status<R: Runtime>(app: &AppHandle<R>, status: &str) {
    emit_batch(
        app,
        &[SensorSample::text(model::STATUS_ID, now_ms(), status)],
    );
}

/// Send `window` the cached `hw.*` samples among the ids it just started consuming.
pub fn prime_window<R: Runtime>(window: &tauri::WebviewWindow<R>, added: &[String]) {
    if let Some(state) = window.app_handle().try_state::<HwinfoState>() {
        crate::sample_cache::prime_window(window, &state.latest, added);
    }
}

/// True while any window consumes an `hw.*` sensor (incl. the studio wildcard once it reported).
fn wanted<R: Runtime>(app: &AppHandle<R>) -> bool {
    let active: State<ActiveSensors> = app.state();
    active.wanted(|id| id.starts_with("hw."))
}

/// The batch for one successful read: well-known CPU ids + enabled catalog slugs + status. Pure.
pub fn tick_batch(readings: &[Reading], enabled: &[String], ts: u64) -> Vec<SensorSample> {
    let mut batch = model::well_known_samples(readings, ts);
    if !enabled.is_empty() {
        let catalog = model::catalog(readings);
        batch.extend(model::enabled_samples(&catalog, enabled, ts));
    }
    batch.push(SensorSample::text(model::STATUS_ID, ts, "connected"));
    batch
}

/// Poll HWiNFO on the interval, emitting `hw.*` telemetry. Demand-gated; idles (no reads) while no
/// window wants an `hw.*` id. Runs until aborted by `hwinfo_disconnect` / a restart.
pub async fn run_hwinfo_source<R: Runtime>(app: AppHandle<R>, cfg: HwinfoConfig) {
    if let Some(state) = app.try_state::<HwinfoState>() {
        state.latest.clear();
    }
    let interval = Duration::from_secs(model::clamp_poll(cfg.poll_seconds));
    let enabled = sanitize_enabled(cfg.enabled);
    let timings = app.state::<crate::timings::SubsystemTimings>();
    let mut idle = true;
    loop {
        if !wanted(&app) {
            idle = true;
            tokio::time::sleep(IDLE_RECHECK).await;
            continue;
        }
        if idle {
            emit_status(&app, "connecting");
            idle = false;
        }
        let probe = match tokio::task::spawn_blocking(probe).await {
            Ok(p) => p,
            Err(err) => {
                eprintln!("hwinfo: probe task failed: {err}");
                emit_status(&app, "error");
                tokio::time::sleep(UNAVAILABLE_RETRY).await;
                continue;
            }
        };
        if probe.backend == Backend::None {
            // Not running → disconnected; running but no interface / unreadable → error.
            let running = tokio::task::spawn_blocking(hwinfo_running)
                .await
                .unwrap_or(false);
            emit_status(&app, if running { "error" } else { "disconnected" });
            tokio::time::sleep(UNAVAILABLE_RETRY).await;
            continue;
        }
        {
            let _t = timings.start("plugin.hwinfo");
            let batch = tick_batch(&probe.readings, &enabled, now_ms());
            emit_batch(&app, &batch);
        }
        tokio::time::sleep(interval).await;
    }
}

// ---- Tauri commands ----

/// Persist `plugins/hwinfo.json` (creates `plugins/`). Studio-window-guarded like the other plugin
/// configs; nothing secret, so a straight write. Slugs are validated server-side.
#[tauri::command]
pub async fn save_hwinfo_config(
    window: tauri::WebviewWindow,
    app: AppHandle,
    poll_seconds: u64,
    enabled: Vec<String>,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("save_hwinfo_config is only allowed from the studio window".into());
    }
    let path = config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let cfg = HwinfoConfig {
        poll_seconds: model::clamp_poll(poll_seconds),
        enabled: sanitize_enabled(enabled),
    };
    let txt = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    crate::file_io::atomic_write(&path, &txt)
}

/// The config plus a live probe of HWiNFO (which interface answers, the catalog, whether the
/// process runs). Blocking work runs on the blocking pool.
#[tauri::command]
pub async fn hwinfo_config_status<R: Runtime>(app: AppHandle<R>) -> Result<HwinfoStatus, String> {
    let cfg = tokio::task::spawn_blocking(move || load_config(&app))
        .await
        .map_err(|e| e.to_string())??
        .unwrap_or_default();
    let (probe, running, gadget_flag) =
        tokio::task::spawn_blocking(|| (probe(), hwinfo_running(), registry::gadget_enabled()))
            .await
            .map_err(|e| e.to_string())?;
    let detail = if probe.backend == Backend::None && !running {
        "HWiNFO64 is not running".to_string()
    } else {
        probe.detail
    };
    Ok(HwinfoStatus {
        configured: !cfg.enabled.is_empty(),
        poll_seconds: model::clamp_poll(cfg.poll_seconds),
        enabled: sanitize_enabled(cfg.enabled),
        running,
        backend: probe.backend,
        gadget_enabled: gadget_flag,
        detail,
        readings: model::catalog(&probe.readings),
    })
}

/// Start the poll task if not already running. Idempotent; `restart` (studio only) reloads the
/// config. Starts even with an empty config: the well-known `hw.cpu.*` ids need no configuration.
#[tauri::command]
pub async fn hwinfo_connect<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    app: AppHandle<R>,
    state: State<'_, HwinfoState>,
    restart: Option<bool>,
) -> Result<(), String> {
    let restart = restart.unwrap_or(false);
    if restart && window.label() != "studio" {
        return Err("integration restart is only allowed from the studio window".into());
    }
    state
        .task
        .start(restart, || {
            let cfg = load_config(&app)?.unwrap_or_default();
            let app_for_task = app.clone();
            Ok(Some(async move {
                run_hwinfo_source(app_for_task, cfg).await;
            }))
        })
        .await
}

/// Stop the poll task (if any).
#[tauri::command]
pub async fn hwinfo_disconnect(state: State<'_, HwinfoState>) -> Result<(), String> {
    state.task.stop().await;
    state.latest.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sensors::SensorValue;
    use model::ReadingKind;

    fn r(sensor: &str, label: &str, unit: &str, kind: ReadingKind, value: f64) -> Reading {
        Reading {
            sensor: sensor.into(),
            label: label.into(),
            unit: unit.into(),
            kind,
            value,
        }
    }

    #[test]
    fn config_defaults_keep_a_minimal_json_valid() {
        let cfg: HwinfoConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(cfg.poll_seconds, model::DEFAULT_POLL_SECS);
        assert!(cfg.enabled.is_empty());
        let cfg: HwinfoConfig =
            serde_json::from_str(r#"{"poll_seconds": 5, "enabled": ["a", "b"]}"#).unwrap();
        assert_eq!(cfg.poll_seconds, 5);
        assert_eq!(cfg.enabled, vec!["a", "b"]);
        let json = serde_json::to_string(&HwinfoConfig::default()).unwrap();
        assert!(json.contains("\"poll_seconds\":2"));
    }

    #[test]
    fn sanitize_enabled_drops_bad_slugs_dupes_and_caps() {
        let out = sanitize_enabled(vec![
            " cpu-tctl-tdie ".into(),
            "cpu-tctl-tdie".into(),
            "Bad Slug".into(),
            "hw.injected".into(),
            "".into(),
            "gpu-power".into(),
        ]);
        assert_eq!(out, vec!["cpu-tctl-tdie", "gpu-power"]);
        let many: Vec<String> = (0..(model::MAX_ENABLED + 10))
            .map(|i| format!("s{i}"))
            .collect();
        assert_eq!(sanitize_enabled(many).len(), model::MAX_ENABLED);
    }

    #[test]
    fn probe_prefers_shared_memory() {
        let p = probe_with(
            || {
                Ok(shared_mem::Snapshot {
                    version: 2,
                    revision: 0,
                    poll_time: 0,
                    readings: vec![r("CPU", "CPU (Tctl/Tdie)", "C", ReadingKind::Temp, 1.0)],
                })
            },
            || panic!("gadget must not be read when shared memory answers"),
            Some(true),
        );
        assert_eq!(p.backend, Backend::SharedMemory);
        assert_eq!(p.readings.len(), 1);
        assert_eq!(p.detail, "shared memory · 1 readings");
    }

    #[test]
    fn probe_falls_back_to_the_gadget_registry() {
        let p = probe_with(
            || Err(shared_mem::LiveError::NotFound),
            || {
                Ok(vec![r(
                    "CPU",
                    "Core Clocks",
                    "MHz",
                    ReadingKind::Clock,
                    3600.0,
                )])
            },
            Some(true),
        );
        assert_eq!(p.backend, Backend::Registry);
        assert_eq!(p.readings.len(), 1);
        assert!(p.detail.starts_with("gadget registry · 1 readings"));
    }

    #[test]
    fn probe_reports_why_nothing_was_found() {
        // Gadget off + no shared memory.
        let p = probe_with(
            || Err(shared_mem::LiveError::NotFound),
            || Ok(vec![]),
            Some(false),
        );
        assert_eq!(p.backend, Backend::None);
        assert!(p.detail.contains("gadget reporting is off"));
        // Gadget on but nothing ticked.
        let p = probe_with(
            || Err(shared_mem::LiveError::NotFound),
            || Ok(vec![]),
            Some(true),
        );
        assert!(p.detail.contains("no readings yet"));
        // Gadget key absent.
        let p = probe_with(
            || Err(shared_mem::LiveError::NotFound),
            || Err("HWiNFO gadget key: not found".into()),
            None,
        );
        assert_eq!(p.detail, "HWiNFO gadget key: not found");
        // A shared-memory failure other than "not found" is the more informative detail.
        let p = probe_with(
            || {
                Err(shared_mem::LiveError::Parse(
                    shared_mem::SnapshotError::ShuttingDown,
                ))
            },
            || Ok(vec![]),
            Some(true),
        );
        assert_eq!(p.backend, Backend::None);
        assert_eq!(p.detail, "HWiNFO is shutting down");
        let p = probe_with(
            || Err(shared_mem::LiveError::Os(5)),
            || Err("gadget broken".into()),
            Some(true),
        );
        assert_eq!(p.detail, "HWiNFO shared memory: Win32 error 5");
    }

    #[test]
    fn tick_batch_has_well_known_enabled_and_status() {
        let readings = vec![
            r(
                "CPU [#0]: X: Enhanced",
                "CPU (Tctl/Tdie)",
                "°C",
                ReadingKind::Temp,
                63.8,
            ),
            r(
                "GPU [#0]: Y",
                "GPU Temperature",
                "°C",
                ReadingKind::Temp,
                30.4,
            ),
        ];
        let batch = tick_batch(&readings, &["gpu-temperature".to_string()], 9);
        let ids: Vec<&str> = batch.iter().map(|s| s.sensor.as_str()).collect();
        assert_eq!(ids, vec!["hw.cpu.temp", "hw.gpu-temperature", "hw.status"]);
        assert!(matches!(batch[2].value, SensorValue::Text(ref t) if t == "connected"));
        assert!(batch.iter().all(|s| s.ts_ms == 9));
        // No enabled slugs → no catalog work, still the well-known ids + status.
        let batch = tick_batch(&readings, &[], 9);
        assert_eq!(batch.len(), 2);
    }

    #[test]
    fn hwinfo_process_names_match_case_insensitively() {
        assert!(is_hwinfo_process("HWiNFO64.EXE"));
        assert!(is_hwinfo_process("hwinfo64.exe"));
        assert!(is_hwinfo_process("HWiNFO32.exe"));
        assert!(!is_hwinfo_process("HWiNFO64 Installer.exe"));
        assert!(!is_hwinfo_process("explorer.exe"));
    }

    #[test]
    fn backend_serializes_kebab_case_for_the_webview() {
        assert_eq!(
            serde_json::to_string(&Backend::SharedMemory).unwrap(),
            "\"shared-memory\""
        );
        assert_eq!(
            serde_json::to_string(&Backend::Registry).unwrap(),
            "\"registry\""
        );
        assert_eq!(serde_json::to_string(&Backend::None).unwrap(), "\"none\"");
    }
}
