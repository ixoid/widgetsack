//! Camera widget backend (fork, ADR-005): one RTSP camera whose address and login live in a
//! DPAPI-encrypted config (`plugins/camera.json`) and never reach the webview. This module holds the
//! managed state and wires the pure seams together; the network worker lands in a later batch.
//!
//! Pure seams (unit-tested, no IO): `config` (address split/validate, secret merge, status),
//! `error_map` (phase + status code -> `CameraErrorKind`). `types` holds every struct that crosses
//! the bridge and, by construction, none of them can contain a `Secret`.

pub mod commands;
pub mod config;
pub mod error_map;
pub mod types;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

/// Managed state. `generation` is bumped on every saved config so a running worker (later batch)
/// knows to reconnect with the new address and to clear any auth lockout.
#[derive(Default)]
pub struct CameraState {
    generation: AtomicU64,
    /// Serialises the read-merge-write of the config file, so two quick saves cannot interleave.
    save_lock: Mutex<()>,
}

impl CameraState {
    /// Returns the new generation.
    pub fn bump_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
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
    }
}
