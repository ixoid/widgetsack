//! Notifyfeed source (fork, roadmap N-1) — a read-later feed of Windows toast notifications so
//! toasts that arrive during a full-screen game can be read on the overlay afterwards. A PEER to
//! agenda.rs / server_check.rs: an app-owned `IntegrationTask` polls the A1 WinRT listener
//! (behind the `NotifySource` seam, ADR `notifyfeed-source`) and forwards the in-memory ring over
//! the existing `telemetry` event as `notify.list` (Json) + `notify.count` (Scalar) +
//! `notify.status` (Text kinds). Demand-gated like every source: zero mounted widgets + a closed
//! pane = zero WinRT calls.
//!
//! Privacy invariants (CTO contract §5): bodies never enter logs, errors or persisted files —
//! log lines carry status kinds, counts and app names only; errors cross as `SourceError` kinds,
//! never formatted WinRT text; nothing is persisted beyond the ring (config holds no content).

pub mod commands;
pub mod config;
pub mod gate;
pub mod ring;
pub mod winrt_listener;

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::sensors::{ActiveSensors, TELEMETRY_EVENT};
use config::NotifyConfig;

/// Re-read the demand gate at most this often while idle (agenda parity).
const IDLE_RECHECK: Duration = Duration::from_secs(5);
/// Consecutive read failures before `notify.status` flips to `unavailable`; a single transient
/// error keeps the previous kind.
pub(crate) const UNAVAILABLE_AFTER: u32 = 3;

/// One notification as a backend reports it, BEFORE caps/dedup/aging. `title`/`body` are the
/// first/rest text elements (may be `None`); every cap and the control-char strip are applied at
/// ring INGEST so all backends get identical treatment.
pub struct RawNotification {
    pub key: String,
    pub app: String,
    pub app_key: String,
    pub title: Option<String>,
    pub body: Option<String>,
    pub creation_ms: u64,
}

/// Kind-only source failure — the ONLY thing a backend may report about an error. Never carries
/// OS/WinRT/DB error text (which can embed paths and content).
pub enum SourceError {
    /// Access not granted (`GetAccessStatus != Allowed`).
    Denied,
    /// The backend cannot read at all (API missing, read failure, worker join failure).
    Unavailable,
}

/// Backend seam keeping A1/A2/B interchangeable (ADR `notifyfeed-source`): the worker only knows
/// this trait, so a later sqlite fallback is a drop-in module with zero widget/contract changes.
pub trait NotifySource: Send {
    fn name(&self) -> &'static str;
    fn poll_once(&mut self) -> Result<Vec<RawNotification>, SourceError>;
}

#[cfg(target_os = "windows")]
type DefaultSource = winrt_listener::WinrtListener;
#[cfg(not(target_os = "windows"))]
#[derive(Clone, Default)]
struct NoSource;
#[cfg(not(target_os = "windows"))]
impl NotifySource for NoSource {
    fn name(&self) -> &'static str {
        "none"
    }
    fn poll_once(&mut self) -> Result<Vec<RawNotification>, SourceError> {
        Err(SourceError::Unavailable)
    }
}
#[cfg(not(target_os = "windows"))]
type DefaultSource = NoSource;

/// Managed state. The ring lives HERE (app state), not in the worker task, so it survives worker
/// restarts and config saves — only the exclusion purge and depth aging remove items, which is
/// what makes the feed outlive a game session (sync Q1).
pub struct NotifyState {
    pub(crate) task: crate::integration_task::IntegrationTask,
    /// The latest emitted batch, to prime windows that mount between polls (`prime_window`).
    pub(crate) latest: crate::sample_cache::SampleCache,
    pub(crate) ring: Mutex<ring::NotifyRing>,
    /// `notify_mark_all_seen` stamp: every item with `ts_ms <= this` counts as seen.
    pub(crate) last_mark_ms: AtomicU64,
    /// The worker's current status kind; "off" until the worker first reports.
    pub(crate) status: Mutex<&'static str>,
    /// The last emitted `(plan, status)` — suppresses unchanged re-emits (pure comparison seam).
    last_emitted: Mutex<Option<(ring::EmitPlan, &'static str)>>,
}

impl Default for NotifyState {
    fn default() -> Self {
        Self {
            task: Default::default(),
            latest: Default::default(),
            ring: Default::default(),
            last_mark_ms: Default::default(),
            status: Mutex::new("off"),
            last_emitted: Default::default(),
        }
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn set_status<R: Runtime>(app: &AppHandle<R>, status: &'static str) {
    if let Some(state) = app.try_state::<NotifyState>() {
        *state.status.lock().unwrap_or_else(|e| e.into_inner()) = status;
    }
}

fn current_status<R: Runtime>(app: &AppHandle<R>) -> &'static str {
    app.try_state::<NotifyState>()
        .map(|state| *state.status.lock().unwrap_or_else(|e| e.into_inner()))
        .unwrap_or("off")
}

// ---- telemetry emission + demand gate ----

/// Build the current batch from state and emit it app-wide when anything changed (or `force` —
/// used by `notify_mark_all_seen` and after the exclusion purge, which must update the meter at
/// once even while the worker is idle). The batch is remembered in the `SampleCache` either way
/// it fires. Returns whether an emit happened.
pub(crate) fn sync_emit<R: Runtime>(app: &AppHandle<R>, force: bool) -> bool {
    let Some(state) = app.try_state::<NotifyState>() else {
        return false;
    };
    let plan = {
        let ring = state.ring.lock().unwrap_or_else(|e| e.into_inner());
        ring::emit_plan(&ring, state.last_mark_ms.load(Ordering::Relaxed))
    };
    let status = *state.status.lock().unwrap_or_else(|e| e.into_inner());
    let mut last = state.last_emitted.lock().unwrap_or_else(|e| e.into_inner());
    if !force
        && last
            .as_ref()
            .is_some_and(|(p, s)| *p == plan && *s == status)
    {
        return false;
    }
    let batch = ring::emit_samples(&plan, status, now_ms());
    state.latest.remember(&batch);
    *last = Some((plan, status));
    drop(last);
    let _ = app.emit(TELEMETRY_EVENT, &batch);
    true
}

/// Send `window` the cached `notify.*` samples among the ids it just started consuming.
pub fn prime_window<R: Runtime>(window: &tauri::WebviewWindow<R>, added: &[String]) {
    if let Some(state) = window.app_handle().try_state::<NotifyState>() {
        crate::sample_cache::prime_window(window, &state.latest, added);
    }
}

/// True while any window consumes a `notify.*` sensor.
fn notify_wanted<R: Runtime>(app: &AppHandle<R>) -> bool {
    let active: State<ActiveSensors> = app.state();
    let guard = active.0.lock().unwrap_or_else(|e| e.into_inner());
    if guard.values().all(|ids| ids.is_empty()) {
        return false;
    }
    crate::sensors::any_wanted(&guard, |id| id.starts_with("notify."))
}

// ---- worker ----

/// PURE SEAM: fold one poll outcome into the `(status kind, consecutive-error)` pair. `Ok` and
/// `Denied` reset the error streak; `Unavailable` keeps the previous kind until the streak
/// reaches [`UNAVAILABLE_AFTER`].
fn fold_status(
    current: &'static str,
    errors: u32,
    outcome: Result<(), &SourceError>,
) -> (&'static str, u32) {
    match outcome {
        Ok(()) => ("granted", 0),
        Err(SourceError::Denied) => ("denied", 0),
        Err(SourceError::Unavailable) => {
            let errors = errors.saturating_add(1);
            (
                if errors >= UNAVAILABLE_AFTER {
                    "unavailable"
                } else {
                    current
                },
                errors,
            )
        }
    }
}

async fn make_source() -> Result<DefaultSource, SourceError> {
    #[cfg(target_os = "windows")]
    // COM activation is blocking work — off the async worker threads.
    return match tokio::task::spawn_blocking(winrt_listener::WinrtListener::new).await {
        Ok(result) => result,
        Err(_) => Err(SourceError::Unavailable),
    };
    #[cfg(not(target_os = "windows"))]
    Err(SourceError::Unavailable)
}

/// One poll cycle through the blocking pool. The COM clone is a ref-count bump; a panicked
/// blocking task maps to the `Unavailable` kind (the join error's text is dropped, not logged).
async fn poll_once(source: &mut DefaultSource) -> Result<Vec<RawNotification>, SourceError> {
    let mut probe = source.clone();
    match tokio::task::spawn_blocking(move || probe.poll_once()).await {
        Ok(result) => result,
        Err(_) => Err(SourceError::Unavailable),
    }
}

/// Poll the listener on `poll_secs`, emit `notify.*` telemetry. Demand-gated; the ring (in
/// `NotifyState`) survives restarts, so a restart does not lose the feed.
pub async fn run_notify_worker<R: Runtime>(app: AppHandle<R>, cfg: NotifyConfig) {
    let cfg = match config::validate_config(&cfg) {
        Ok(valid) => valid,
        Err(err) => {
            // A hand-edited file: the message names bounds/counts only, never list contents.
            eprintln!("notifyfeed: invalid config, using defaults: {err}");
            NotifyConfig::default()
        }
    };
    // Purge hook 2 (sync Q1): a hand-edited exclusion list also cleans the ring at worker start.
    if let Some(state) = app.try_state::<NotifyState>() {
        let dropped = state
            .ring
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .apply_exclusions(&cfg.exclusions);
        if dropped > 0 {
            eprintln!("notifyfeed: exclusion purge dropped {dropped} items");
        }
    }
    let mut source = match make_source().await {
        Ok(source) => source,
        Err(_) => {
            eprintln!("notifyfeed: source unavailable");
            set_status(&app, "unavailable");
            sync_emit(&app, false);
            return;
        }
    };
    eprintln!("notifyfeed: worker started (source {})", source.name());
    // The one-shot OS prompt trigger, fired detached: it may wait for the owner indefinitely and
    // the poll loop must not block behind it. Per-cycle re-checks use GetAccessStatus only.
    #[cfg(target_os = "windows")]
    {
        let listener = source.clone();
        tokio::spawn(async move {
            let _ = tokio::task::spawn_blocking(move || listener.request_access_once()).await;
        });
    }
    let poll = Duration::from_secs(cfg.poll_secs);
    let mut errors: u32 = 0;
    let mut idle = true;
    loop {
        if !notify_wanted(&app) {
            if !idle {
                set_status(&app, "off");
                sync_emit(&app, false);
                idle = true;
            }
            tokio::time::sleep(IDLE_RECHECK).await;
            continue;
        }
        idle = false;
        let polled = poll_once(&mut source).await;
        let (status, streak) =
            fold_status(current_status(&app), errors, polled.as_ref().map(|_| ()));
        errors = streak;
        if let Ok(raws) = &polled
            && let Some(state) = app.try_state::<NotifyState>()
        {
            let mut ring = state.ring.lock().unwrap_or_else(|e| e.into_inner());
            let delta = ring.ingest(
                raws,
                &cfg.exclusions,
                cfg.depth_mode,
                cfg.depth_count.min(ring::RING_CAP as u64) as usize,
                cfg.depth_hours,
                now_ms(),
            );
            // Counts only — app names/titles/bodies never enter logs.
            if delta.added > 0 {
                eprintln!("notifyfeed: {} new, ring {}", delta.added, ring.len());
            }
        }
        set_status(&app, status);
        sync_emit(&app, false);
        tokio::time::sleep(poll).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fold_status_maps_outcomes_and_keeps_transients_on_the_previous_kind() {
        assert_eq!(fold_status("granted", 0, Ok(())), ("granted", 0));
        assert_eq!(fold_status("granted", 2, Ok(())), ("granted", 0));
        assert_eq!(
            fold_status("granted", 0, Err(&SourceError::Denied)),
            ("denied", 0)
        );
        assert_eq!(fold_status("denied", 3, Ok(())), ("granted", 0));
        // Single transient read errors keep the previous kind…
        assert_eq!(
            fold_status("granted", 0, Err(&SourceError::Unavailable)),
            ("granted", 1)
        );
        assert_eq!(
            fold_status("granted", 1, Err(&SourceError::Unavailable)),
            ("granted", 2)
        );
        // …until the consecutive threshold flips to unavailable.
        assert_eq!(
            fold_status("granted", 2, Err(&SourceError::Unavailable)),
            ("unavailable", 3)
        );
        assert_eq!(
            fold_status("unavailable", 3, Err(&SourceError::Unavailable)),
            ("unavailable", 4)
        );
        assert_eq!(fold_status("unavailable", 9, Ok(())), ("granted", 0));
        assert_eq!(
            fold_status("unavailable", 9, Err(&SourceError::Denied)),
            ("denied", 0)
        );
    }

    #[test]
    fn the_state_starts_off_with_an_empty_ring_and_a_zero_mark() {
        let state = NotifyState::default();
        assert_eq!(*state.status.lock().unwrap(), "off");
        assert!(state.ring.lock().unwrap().is_empty());
        assert_eq!(state.last_mark_ms.load(Ordering::Relaxed), 0);
    }
}
