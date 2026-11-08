//! Per-subscriber flow control (pure, no IO; the clock is passed in so tests need no sleeping).
//!
//! The Tauri channel queue is unbounded, so a stalled webview would make Rust buffer video forever.
//! The client acks every 8 frames and every keyframe (`camera_ack`); this state turns those acks
//! into a send/skip decision per message:
//! - `in_flight` = frames sent - frames acked (wrapping `u32`).
//! - Above `MAX_IN_FLIGHT` deltas are dropped and the subscriber waits for the next keyframe (a
//!   dropped delta breaks the reference chain, so later deltas are useless until then).
//! - CONFIG and keyframes always go through, so a recovering client always gets a way back in.
//! - No ack for `ACK_TIMEOUT` while frames are outstanding = a dead webview: the subscriber is dropped.
//!
//! Sequence numbers are per subscriber and count the FRAMES actually sent to it (no gaps), so a
//! subscriber that joins late or skips deltas still sees seq 0, 1, 2 ... and acks map 1:1 to sends.

use std::time::{Duration, Instant};

pub const MAX_IN_FLIGHT: u32 = 24;
pub const ACK_TIMEOUT: Duration = Duration::from_secs(15);

/// What to do with one FRAME for this subscriber.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Send it, stamped with this seq.
    Send(u32),
    /// Drop this one for this subscriber.
    Skip,
    /// The subscriber stopped acking: remove it.
    Dead,
}

#[derive(Clone, Copy, Debug)]
pub struct Flow {
    /// Seq of the next FRAME (= frames sent so far, wrapping).
    next_seq: u32,
    /// Frames the client has confirmed (`ack seq + 1`, wrapping).
    acked: u32,
    need_key: bool,
    /// Last moment the client proved it is alive (an ack), or the moment frames started flowing
    /// after an idle spell.
    progress_at: Instant,
}

impl Flow {
    /// A new subscriber holds deltas until it has been given a keyframe.
    pub fn new(now: Instant) -> Self {
        Self {
            next_seq: 0,
            acked: 0,
            need_key: true,
            progress_at: now,
        }
    }

    pub fn in_flight(&self) -> u32 {
        self.next_seq.wrapping_sub(self.acked)
    }

    /// Records an ack of frame `seq`. Stale, duplicate and impossible acks (for a frame never sent)
    /// are ignored, so a buggy client can neither widen nor corrupt the window.
    pub fn ack(&mut self, seq: u32, now: Instant) {
        let acked = seq.wrapping_add(1);
        // Distances as signed wrapping values: `advance` > 0 = newer than the last ack;
        // `unsent` < 0 = beyond what was sent.
        let advance = acked.wrapping_sub(self.acked) as i32;
        let unsent = self.next_seq.wrapping_sub(acked) as i32;
        if advance > 0 && unsent >= 0 {
            self.acked = acked;
            self.progress_at = now;
        }
    }

    /// CONFIG always goes through. Its seq is the seq of the next FRAME, and a decoder that was just
    /// (re)configured needs a keyframe before any delta.
    pub fn plan_config(&mut self) -> u32 {
        self.need_key = true;
        self.next_seq
    }

    /// Makes the subscriber wait for the next real keyframe. Used after handing it a CACHED keyframe:
    /// that frame is old, so the live deltas that follow it would not decode.
    pub fn require_key(&mut self) {
        self.need_key = true;
    }

    pub fn plan_frame(&mut self, is_key: bool, now: Instant) -> Plan {
        let in_flight = self.in_flight();
        if in_flight > 0 && now.saturating_duration_since(self.progress_at) >= ACK_TIMEOUT {
            return Plan::Dead;
        }
        if is_key {
            self.need_key = false;
        } else if self.need_key {
            return Plan::Skip;
        } else if in_flight > MAX_IN_FLIGHT {
            self.need_key = true;
            return Plan::Skip;
        }
        if in_flight == 0 {
            // The ack clock only runs while something is outstanding.
            self.progress_at = now;
        }
        let seq = self.next_seq;
        self.next_seq = self.next_seq.wrapping_add(1);
        Plan::Send(seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(t0: Instant, s: u64) -> Instant {
        t0 + Duration::from_secs(s)
    }

    /// Sends `n` deltas (after a keyframe), asserting each goes out.
    fn send_deltas(flow: &mut Flow, n: u32, now: Instant) {
        for _ in 0..n {
            assert!(matches!(flow.plan_frame(false, now), Plan::Send(_)));
        }
    }

    #[test]
    fn a_new_subscriber_waits_for_a_keyframe_and_seqs_have_no_gaps() {
        let t0 = Instant::now();
        let mut f = Flow::new(t0);
        assert_eq!(f.plan_frame(false, t0), Plan::Skip, "no delta before a key");
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        assert_eq!(f.plan_frame(false, t0), Plan::Send(1));
        assert_eq!(f.plan_frame(false, t0), Plan::Send(2));
        assert_eq!(f.in_flight(), 3);
    }

    #[test]
    fn require_key_holds_deltas_after_a_cached_keyframe() {
        let t0 = Instant::now();
        let mut f = Flow::new(t0);
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0)); // the cached keyframe
        f.require_key();
        assert_eq!(f.plan_frame(false, t0), Plan::Skip);
        assert_eq!(
            f.plan_frame(true, t0),
            Plan::Send(1),
            "the next real keyframe"
        );
        assert_eq!(f.plan_frame(false, t0), Plan::Send(2));
    }

    #[test]
    fn config_carries_the_next_frame_seq_and_demands_a_keyframe() {
        let t0 = Instant::now();
        let mut f = Flow::new(t0);
        assert_eq!(f.plan_config(), 0);
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        assert_eq!(f.plan_frame(false, t0), Plan::Send(1));
        assert_eq!(f.plan_config(), 2, "seq stays monotonic across a CONFIG");
        assert_eq!(f.plan_frame(false, t0), Plan::Skip);
        assert_eq!(f.plan_frame(true, t0), Plan::Send(2));
    }

    #[test]
    fn more_than_24_in_flight_drops_deltas_until_the_next_keyframe() {
        let t0 = Instant::now();
        let mut f = Flow::new(t0);
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        send_deltas(&mut f, 24, t0); // 25 in flight now
        assert_eq!(f.in_flight(), 25);
        assert_eq!(f.plan_frame(false, t0), Plan::Skip, "over the window");
        // An ack frees the window, but the chain is broken: deltas still wait for a key.
        f.ack(24, t0);
        assert_eq!(f.in_flight(), 0);
        assert_eq!(f.plan_frame(false, t0), Plan::Skip);
        assert_eq!(f.plan_frame(true, t0), Plan::Send(25));
        assert_eq!(f.plan_frame(false, t0), Plan::Send(26));
    }

    #[test]
    fn exactly_24_in_flight_still_sends() {
        let t0 = Instant::now();
        let mut f = Flow::new(t0);
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        send_deltas(&mut f, 23, t0);
        assert_eq!(f.in_flight(), 24);
        assert!(matches!(f.plan_frame(false, t0), Plan::Send(24)));
    }

    #[test]
    fn a_keyframe_goes_through_even_over_the_window() {
        let t0 = Instant::now();
        let mut f = Flow::new(t0);
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        send_deltas(&mut f, 24, t0);
        assert_eq!(f.plan_frame(false, t0), Plan::Skip);
        assert!(matches!(f.plan_frame(true, t0), Plan::Send(25)));
    }

    #[test]
    fn acks_are_monotonic_and_bounded_by_what_was_sent() {
        let t0 = Instant::now();
        let mut f = Flow::new(t0);
        f.plan_frame(true, t0);
        send_deltas(&mut f, 9, t0); // seq 0..=9 sent
        f.ack(7, t0);
        assert_eq!(f.in_flight(), 2);
        f.ack(3, t0); // stale
        assert_eq!(f.in_flight(), 2);
        f.ack(7, t0); // duplicate
        assert_eq!(f.in_flight(), 2);
        f.ack(500, t0); // never sent
        assert_eq!(f.in_flight(), 2);
        f.ack(9, t0);
        assert_eq!(f.in_flight(), 0);
    }

    #[test]
    fn the_counters_survive_u32_wraparound() {
        let t0 = Instant::now();
        let mut f = Flow::new(t0);
        f.next_seq = u32::MAX - 1;
        f.acked = u32::MAX - 1;
        f.need_key = false;
        assert_eq!(f.plan_frame(false, t0), Plan::Send(u32::MAX - 1));
        assert_eq!(f.plan_frame(false, t0), Plan::Send(u32::MAX));
        assert_eq!(f.plan_frame(false, t0), Plan::Send(0));
        assert_eq!(f.in_flight(), 3);
        f.ack(u32::MAX, t0);
        assert_eq!(f.in_flight(), 1);
        f.ack(0, t0);
        assert_eq!(f.in_flight(), 0);
    }

    #[test]
    fn no_ack_for_15_seconds_while_frames_are_outstanding_kills_the_subscriber() {
        let t0 = Instant::now();
        let mut f = Flow::new(t0);
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        assert!(matches!(f.plan_frame(false, at(t0, 14)), Plan::Send(1)));
        assert_eq!(f.plan_frame(false, at(t0, 15)), Plan::Dead);
        assert_eq!(
            f.plan_frame(true, at(t0, 16)),
            Plan::Dead,
            "even a keyframe"
        );
    }

    #[test]
    fn an_ack_restarts_the_clock() {
        let t0 = Instant::now();
        let mut f = Flow::new(t0);
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        f.ack(0, at(t0, 10));
        assert_eq!(f.plan_frame(false, at(t0, 12)), Plan::Send(1));
        assert!(matches!(f.plan_frame(false, at(t0, 24)), Plan::Send(2)));
        // The clock restarted at the send of seq 1 (t=12), the last moment nothing was outstanding.
        assert_eq!(f.plan_frame(false, at(t0, 27)), Plan::Dead);
    }

    #[test]
    fn an_idle_stream_does_not_time_out() {
        // The camera stalls for a minute with everything acked: nothing is "being sent".
        let t0 = Instant::now();
        let mut f = Flow::new(t0);
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        f.ack(0, at(t0, 1));
        assert_eq!(f.plan_frame(false, at(t0, 61)), Plan::Send(1));
        assert!(matches!(f.plan_frame(false, at(t0, 62)), Plan::Send(2)));
    }
}
