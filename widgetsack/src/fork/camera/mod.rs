//! Camera widget backend (fork, ADR-005): one RTSP camera whose address and login live in a
//! DPAPI-encrypted config (`plugins/camera.json`) and never reach the webview. This module holds the
//! managed state and wires the seams together.
//!
//! Pure seams (unit-tested, no IO): `config` (address split/validate, secret merge, status),
//! `error_map` (phase + status code -> `CameraErrorKind`), `framing` (binary channel messages).
//! `types` holds every struct that crosses the bridge and, by construction, none of them can contain
//! a `Secret`. IO: `probe` (DESCRIBE-only check) and `worker` (the retina session pump).

pub mod commands;
pub mod config;
pub mod error_map;
#[cfg(test)]
mod fake_rtsp;
pub mod framing;
pub mod probe;
pub mod types;
pub mod worker;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long a 401/403 (from the worker or a probe) blocks further attempts, unless a save comes
/// first. Guards the camera account against lockout by a retry loop.
pub const AUTH_LOCKOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug)]
struct AuthLock {
    /// Config generation the refusal was for; a save bumps the generation and so lifts the lock.
    generation: u64,
    until: Instant,
    until_epoch_ms: u64,
}

/// Pure lockout rule: active only for the same config generation and before the deadline.
fn lock_active(lock: Option<AuthLock>, generation: u64, now: Instant) -> bool {
    lock.is_some_and(|l| l.generation == generation && now < l.until)
}

/// State shared with spawned tasks (the worker outlives the command call that started it).
#[derive(Default)]
pub struct Shared {
    generation: AtomicU64,
    auth_lock: Mutex<Option<AuthLock>>,
}

impl Shared {
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn lock(&self) -> MutexGuard<'_, Option<AuthLock>> {
        self.auth_lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Records a 401/403 for the current config generation.
    pub fn lock_auth(&self) {
        let epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        *self.lock() = Some(AuthLock {
            generation: self.generation(),
            until: Instant::now() + AUTH_LOCKOUT,
            until_epoch_ms: epoch_ms.saturating_add(AUTH_LOCKOUT.as_millis() as u64),
        });
    }

    pub fn auth_locked(&self) -> bool {
        lock_active(*self.lock(), self.generation(), Instant::now())
    }

    /// Epoch ms until which attempts are refused, `None` when not locked.
    pub fn auth_locked_until_ms(&self) -> Option<u64> {
        let lock = *self.lock();
        lock_active(lock, self.generation(), Instant::now())
            .then(|| lock.map(|l| l.until_epoch_ms))
            .flatten()
    }
}

/// Managed state.
#[derive(Default)]
pub struct CameraState {
    shared: Arc<Shared>,
    /// Serialises the read-merge-write of the config file, so two quick saves cannot interleave.
    save_lock: Mutex<()>,
    pub(crate) probe: probe::ProbeGate,
    /// The single running stream (phase 1: one subscriber; a new subscribe replaces it).
    pub(crate) worker: tokio::sync::Mutex<Option<worker::WorkerHandle>>,
}

impl CameraState {
    /// Bumps the config generation (which also lifts an auth lockout). Returns the new generation.
    pub fn bump_generation(&self) -> u64 {
        self.shared.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn shared(&self) -> &Arc<Shared> {
        &self.shared
    }

    pub(crate) fn lock_save(&self) -> MutexGuard<'_, ()> {
        // A panic in a previous save must not wedge saving forever; the guarded data is `()`.
        self.save_lock.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_increments_monotonically() {
        let state = CameraState::default();
        assert_eq!(state.bump_generation(), 1);
        assert_eq!(state.bump_generation(), 2);
        assert_eq!(state.shared().generation(), 2);
    }

    #[test]
    fn lockout_rule_needs_same_generation_and_an_unexpired_deadline() {
        let now = Instant::now();
        let lock = AuthLock {
            generation: 3,
            until: now + Duration::from_secs(60),
            until_epoch_ms: 1,
        };
        assert!(lock_active(Some(lock), 3, now));
        assert!(!lock_active(Some(lock), 4, now), "a save lifts the lock");
        assert!(!lock_active(Some(lock), 3, now + Duration::from_secs(60)));
        assert!(!lock_active(None, 3, now));
    }

    #[test]
    fn auth_lock_holds_until_a_save() {
        let state = CameraState::default();
        assert!(!state.shared().auth_locked());
        assert_eq!(state.shared().auth_locked_until_ms(), None);
        state.shared().lock_auth();
        assert!(state.shared().auth_locked());
        assert!(state.shared().auth_locked_until_ms().is_some());
        state.bump_generation();
        assert!(!state.shared().auth_locked());
        assert_eq!(state.shared().auth_locked_until_ms(), None);
    }
}
