//! Retry delays of the stream worker (pure, no IO): 1, 2, 4, 8, 16, 30, 30 ... s. The ladder starts
//! over once a connection stayed `live` long enough to count as healthy, so one flaky minute does not
//! leave the next unplug waiting 30 s. The 60 s auth lockout lives in `mod.rs` (`Shared`), not here:
//! a wrong password must never be retried on a timer at all.

use std::time::Duration;

/// First delay; each retry doubles it.
pub const BASE: Duration = Duration::from_secs(1);
/// Longest wait between attempts.
pub const CAP: Duration = Duration::from_secs(30);
/// A session live for at least this long resets the ladder.
pub const RESET_AFTER_LIVE: Duration = Duration::from_secs(10);

/// The tunable numbers (tests shrink them; production uses `Default`).
#[derive(Clone, Copy, Debug)]
pub struct Policy {
    pub base: Duration,
    pub cap: Duration,
    pub reset_after_live: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            base: BASE,
            cap: CAP,
            reset_after_live: RESET_AFTER_LIVE,
        }
    }
}

/// `base * 2^step`, capped. The shift is bounded so a very long outage cannot overflow.
fn delay_for(policy: &Policy, step: u32) -> Duration {
    let factor = 1u32 << step.min(16);
    policy.base.saturating_mul(factor).min(policy.cap)
}

/// Where the worker is on the ladder.
#[derive(Clone, Copy, Debug)]
pub struct Backoff {
    policy: Policy,
    step: u32,
}

impl Backoff {
    pub fn new(policy: Policy) -> Self {
        Self { policy, step: 0 }
    }

    /// The delay before the next attempt; advances the ladder.
    pub fn next_delay(&mut self) -> Duration {
        let delay = delay_for(&self.policy, self.step);
        self.step = self.step.saturating_add(1);
        delay
    }

    /// Call when a session ended after being live for `live_for`.
    pub fn note_live(&mut self, live_for: Duration) {
        if live_for >= self.policy.reset_after_live {
            self.reset();
        }
    }

    pub fn reset(&mut self) {
        self.step = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fork::camera::{AUTH_LOCKOUT, AuthLock, lock_active};
    use std::time::Instant;

    fn secs(b: &mut Backoff, n: usize) -> Vec<u64> {
        (0..n).map(|_| b.next_delay().as_secs()).collect()
    }

    #[test]
    fn delays_double_up_to_the_cap_and_stay_there() {
        let mut b = Backoff::new(Policy::default());
        assert_eq!(secs(&mut b, 9), [1, 2, 4, 8, 16, 30, 30, 30, 30]);
    }

    #[test]
    fn a_very_long_outage_does_not_overflow() {
        let mut b = Backoff::new(Policy::default());
        for _ in 0..10_000 {
            assert!(b.next_delay() <= CAP);
        }
    }

    #[test]
    fn ten_seconds_of_live_resets_the_ladder_but_nine_do_not() {
        let mut b = Backoff::new(Policy::default());
        assert_eq!(secs(&mut b, 4), [1, 2, 4, 8]);
        b.note_live(Duration::from_millis(9_999));
        assert_eq!(b.next_delay().as_secs(), 16, "a short live keeps climbing");
        b.note_live(Duration::from_secs(10));
        assert_eq!(secs(&mut b, 3), [1, 2, 4], "a healthy session starts over");
    }

    #[test]
    fn an_explicit_reset_starts_over() {
        let mut b = Backoff::new(Policy::default());
        secs(&mut b, 3);
        b.reset();
        assert_eq!(b.next_delay(), BASE);
    }

    /// The auth lockout table: held for 60 s of the SAME config generation, lifted by a save.
    #[test]
    fn the_auth_lockout_is_sixty_seconds_for_one_generation() {
        assert_eq!(AUTH_LOCKOUT, Duration::from_secs(60));
        let now = Instant::now();
        let lock = AuthLock {
            generation: 5,
            until: now + AUTH_LOCKOUT,
            until_epoch_ms: 0,
        };
        let table: &[(u64, u64, bool)] = &[
            // (generation now, seconds since the 401, still locked)
            (5, 0, true),
            (5, 59, true),
            (5, 60, false),
            (6, 0, false),
            (6, 30, false),
        ];
        for (generation, after_s, locked) in table {
            let at = now + Duration::from_secs(*after_s);
            assert_eq!(
                lock_active(Some(lock), *generation, at),
                *locked,
                "generation {generation}, {after_s} s after"
            );
        }
    }
}
