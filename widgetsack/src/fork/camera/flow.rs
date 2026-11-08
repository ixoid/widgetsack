//! Per-subscriber flow control (pure, no IO; the clock is passed in so tests need no sleeping).
//!
//! The Tauri channel queue is unbounded, so a stalled webview would make Rust buffer video forever.
//! The client acks every 8 frames and every keyframe (`camera_ack`); this state turns those acks
//! into a send/skip decision per message:
//! - `in_flight` = frames sent - frames acked (wrapping `u32`).
//! - Above `MAX_IN_FLIGHT` deltas are dropped and the subscriber waits for the next keyframe (a
//!   dropped delta breaks the reference chain, so later deltas are useless until then).
//! - CONFIG and keyframes always go through, so a recovering client always gets a way back in.
//! - No ack for `ACK_TIMEOUT` while an ack is DUE = a dead webview: the subscriber is dropped. An ack
//!   is due only when the client is known to owe one: `ACK_CADENCE` or more frames are unacked, or a
//!   keyframe was sent and is unacked (the client acks every keyframe). Below that the client may
//!   legitimately be silent (a stalled stream, a camera under 1 fps), so the clock does not run.
//!
//! Sequence numbers are per subscriber and count the FRAMES actually sent to it (no gaps), so a
//! subscriber that joins late or skips deltas still sees seq 0, 1, 2 ... and acks map 1:1 to sends.

use std::time::{Duration, Instant};

pub const MAX_IN_FLIGHT: u32 = 24;
pub const ACK_TIMEOUT: Duration = Duration::from_secs(15);
/// The client acks at least every this many frames (mirrors the client's ack cadence).
pub const ACK_CADENCE: u32 = 8;

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
    /// Seq of the last keyframe sent since the last CONFIG; the client acks every keyframe.
    key_seq: Option<u32>,
    /// When an ack became due (see the module docs); reset by every ack and every CONFIG.
    /// `None` = no ack is owed, so there is nothing to time out.
    due_since: Option<Instant>,
}

impl Default for Flow {
    fn default() -> Self {
        Self::new()
    }
}

impl Flow {
    /// A new subscriber holds deltas until it has been given a keyframe.
    pub fn new() -> Self {
        Self {
            next_seq: 0,
            acked: 0,
            need_key: true,
            key_seq: None,
            due_since: None,
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
            // Progress restarts the clock, but only if the next ack is already owed.
            self.due_since = self.ack_due().then_some(now);
        }
    }

    fn key_outstanding(&self) -> bool {
        self.key_seq
            .is_some_and(|key| (key.wrapping_add(1).wrapping_sub(self.acked) as i32) > 0)
    }

    fn ack_due(&self) -> bool {
        self.in_flight() >= ACK_CADENCE || self.key_outstanding()
    }

    /// CONFIG always goes through. Its seq is the seq of the next FRAME, and a decoder that was just
    /// (re)configured needs a keyframe before any delta. A CONFIG starts a new stream session (after
    /// an outage the old frames are never going to be acked by the cadence), so it also restarts the
    /// ack clock: acks owed for the previous session do not count against the new one.
    pub fn plan_config(&mut self, now: Instant) -> u32 {
        self.need_key = true;
        self.key_seq = None;
        self.due_since = (self.in_flight() >= ACK_CADENCE).then_some(now);
        self.next_seq
    }

    /// Makes the subscriber wait for the next real keyframe. Used after handing it a CACHED keyframe:
    /// that frame is old, so the live deltas that follow it would not decode.
    pub fn require_key(&mut self) {
        self.need_key = true;
    }

    pub fn plan_frame(&mut self, is_key: bool, now: Instant) -> Plan {
        let in_flight = self.in_flight();
        if self
            .due_since
            .is_some_and(|since| now.saturating_duration_since(since) >= ACK_TIMEOUT)
        {
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
        let seq = self.next_seq;
        self.next_seq = self.next_seq.wrapping_add(1);
        if is_key {
            self.key_seq = Some(seq);
        }
        if self.due_since.is_none() && self.ack_due() {
            self.due_since = Some(now);
        }
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
        let mut f = Flow::new();
        assert_eq!(f.plan_frame(false, t0), Plan::Skip, "no delta before a key");
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        assert_eq!(f.plan_frame(false, t0), Plan::Send(1));
        assert_eq!(f.plan_frame(false, t0), Plan::Send(2));
        assert_eq!(f.in_flight(), 3);
    }

    #[test]
    fn require_key_holds_deltas_after_a_cached_keyframe() {
        let t0 = Instant::now();
        let mut f = Flow::new();
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
        let mut f = Flow::new();
        assert_eq!(f.plan_config(t0), 0);
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        assert_eq!(f.plan_frame(false, t0), Plan::Send(1));
        assert_eq!(f.plan_config(t0), 2, "seq stays monotonic across a CONFIG");
        assert_eq!(f.plan_frame(false, t0), Plan::Skip);
        assert_eq!(f.plan_frame(true, t0), Plan::Send(2));
    }

    #[test]
    fn more_than_24_in_flight_drops_deltas_until_the_next_keyframe() {
        let t0 = Instant::now();
        let mut f = Flow::new();
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
        let mut f = Flow::new();
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        send_deltas(&mut f, 23, t0);
        assert_eq!(f.in_flight(), 24);
        assert!(matches!(f.plan_frame(false, t0), Plan::Send(24)));
    }

    #[test]
    fn a_keyframe_goes_through_even_over_the_window() {
        let t0 = Instant::now();
        let mut f = Flow::new();
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        send_deltas(&mut f, 24, t0);
        assert_eq!(f.plan_frame(false, t0), Plan::Skip);
        assert!(matches!(f.plan_frame(true, t0), Plan::Send(25)));
    }

    #[test]
    fn acks_are_monotonic_and_bounded_by_what_was_sent() {
        let t0 = Instant::now();
        let mut f = Flow::new();
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
        let mut f = Flow::new();
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
        let mut f = Flow::new();
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
        let mut f = Flow::new();
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        send_deltas(&mut f, 7, t0); // 8 in flight: an ack is due since t0
        f.ack(3, at(t0, 10)); // 4 left: nothing owed, the clock stops
        send_deltas(&mut f, 4, at(t0, 12)); // 8 in flight again: due since t12
        // Without the ack at t10 this would be dead from t15 on.
        assert!(matches!(f.plan_frame(false, at(t0, 26)), Plan::Send(_)));
        assert_eq!(f.plan_frame(false, at(t0, 27)), Plan::Dead);
    }

    #[test]
    fn a_stream_stall_with_unacked_frames_does_not_drop_the_subscriber_after_the_reconnect() {
        // The reviewed bug: 3 deltas unacked (below the cadence), the camera is down for a minute,
        // then CONFIG + keyframe arrive. The old rule saw "outstanding + 15 s" and dropped it.
        let t0 = Instant::now();
        let mut f = Flow::new();
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        f.ack(0, t0); // the keyframe ack
        send_deltas(&mut f, 3, t0);
        assert_eq!(f.in_flight(), 3);
        assert_eq!(f.plan_config(at(t0, 60)), 4, "reconnect: new CONFIG");
        assert_eq!(f.plan_frame(true, at(t0, 61)), Plan::Send(4));
        // Positive control: the clock is alive again from the keyframe, 15 s of silence kills it.
        assert!(matches!(f.plan_frame(false, at(t0, 75)), Plan::Send(_)));
        assert_eq!(f.plan_frame(false, at(t0, 76)), Plan::Dead);
    }

    #[test]
    fn an_unacked_keyframe_from_before_the_outage_does_not_count_after_a_config() {
        let t0 = Instant::now();
        let mut f = Flow::new();
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0)); // never acked
        send_deltas(&mut f, 2, t0);
        f.plan_config(at(t0, 60));
        assert_eq!(f.plan_frame(true, at(t0, 61)), Plan::Send(3));
    }

    #[test]
    fn eight_unacked_frames_and_15_seconds_of_silence_drop_the_subscriber() {
        let t0 = Instant::now();
        let mut f = Flow::new();
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        f.ack(0, t0);
        send_deltas(&mut f, 7, t0); // 7 in flight: not due
        assert!(matches!(f.plan_frame(false, at(t0, 30)), Plan::Send(_)));
        // The 8th unacked frame (sent at t30) made an ack due.
        assert!(matches!(f.plan_frame(false, at(t0, 44)), Plan::Send(_)));
        assert_eq!(f.plan_frame(false, at(t0, 45)), Plan::Dead);
    }

    #[test]
    fn an_unacked_keyframe_for_15_seconds_drops_the_subscriber() {
        let t0 = Instant::now();
        let mut f = Flow::new();
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        send_deltas(&mut f, 2, t0); // 3 in flight, below the cadence: only the keyframe is owed
        assert_eq!(f.plan_frame(false, at(t0, 15)), Plan::Dead);
    }

    #[test]
    fn an_acked_keyframe_stops_the_clock() {
        let t0 = Instant::now();
        let mut f = Flow::new();
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        send_deltas(&mut f, 2, t0);
        f.ack(0, at(t0, 1));
        assert!(matches!(f.plan_frame(false, at(t0, 600)), Plan::Send(_)));
    }

    #[test]
    fn a_slow_camera_acked_at_the_eighth_frame_is_never_dropped() {
        // One frame every 4 s (0.25 fps): 8 frames take 32 s, longer than the timeout, yet the
        // client acks the keyframe at once and then every 8th frame.
        let t0 = Instant::now();
        let mut f = Flow::new();
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        f.ack(0, t0);
        for i in 1..=24u32 {
            let now = at(t0, 4 * u64::from(i));
            assert_eq!(f.plan_frame(false, now), Plan::Send(i), "frame {i}");
            if i % 8 == 0 {
                f.ack(i, now);
            }
        }
    }

    #[test]
    fn an_idle_stream_does_not_time_out() {
        // The camera stalls for a minute with everything acked: nothing is "being sent".
        let t0 = Instant::now();
        let mut f = Flow::new();
        assert_eq!(f.plan_frame(true, t0), Plan::Send(0));
        f.ack(0, at(t0, 1));
        assert_eq!(f.plan_frame(false, at(t0, 61)), Plan::Send(1));
        assert!(matches!(f.plan_frame(false, at(t0, 62)), Plan::Send(2)));
    }
}
