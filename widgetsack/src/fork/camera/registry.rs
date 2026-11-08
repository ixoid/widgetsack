//! Subscriber registry and fan-out. There is ONE camera config, so there is ONE worker (one RTSP
//! session) however many widgets watch it; this hub owns that worker and the subscribers it feeds,
//! keyed by `(window label, key)` like `audio::SpectrumState`.
//!
//! Lifecycle:
//! - First subscribe starts the worker; later ones attach to it (and replace a stale entry with the
//!   same `(label, key)`, so a remount never duplicates).
//! - The last unsubscribe (or `forget_window`, or a dropped dead subscriber) starts a grace timer;
//!   when it fires with nobody left the worker is stopped cooperatively (TEARDOWN). A subscribe
//!   during the grace cancels it, which is what makes a StrictMode remount or a brief hide cheap.
//! - A config save restarts the session so the new address / login applies without a resubscribe.
//!
//! Cache (per worker, deliberately NOT a GOP): the current CONFIG and the latest keyframe. A new
//! subscriber gets the current status, the cached CONFIG and keyframe at once, then deltas only
//! after the next real keyframe (the cached one is old, so deltas after it would not decode).
//! The cache is dropped whenever the stream leaves `live`, so a retrying camera never replays a
//! stale picture.
//!
//! Sequence numbers are PER SUBSCRIBER (`flow.rs`): the hub re-stamps each copy, the byte layout and
//! the golden vector are unchanged.
//!
//! The hub lock is a plain mutex held only for short non-blocking work (channel sends do not wait).
//! Nothing is awaited under it; stopping a worker happens after the lock is released.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::runtime::Handle;

use super::Shared;
use super::flow::{Flow, Plan};
use super::framing::{Kind, classify, with_seq};
use super::types::{StatusEvent, StreamState};
use super::worker::{LoadConfig, Sink, WorkerHandle, WorkerOptions};

/// How long the worker outlives its last subscriber.
pub const GRACE: Duration = Duration::from_secs(2);

/// What a worker needs to (re)start; kept so a config save can restart it.
#[derive(Clone)]
pub struct Start {
    pub load: LoadConfig,
    pub shared: Arc<Shared>,
    pub options: WorkerOptions,
}

type SubId = (String, String);

struct Subscriber<S> {
    sink: S,
    flow: Flow,
}

struct Running {
    /// Messages from a worker with another id (a replaced one still winding down) are refused.
    id: u64,
    handle: WorkerHandle,
    start: Start,
}

#[derive(Default)]
struct Cache {
    config: Option<Vec<u8>>,
    key: Option<Vec<u8>>,
    status: Option<StatusEvent>,
}

struct Inner<S> {
    subs: HashMap<SubId, Subscriber<S>>,
    worker: Option<Running>,
    cache: Cache,
    /// Bumped by every subscribe and every idle transition; a grace timer only acts if the epoch is
    /// still the one it was started under.
    grace_epoch: u64,
    worker_seq: u64,
    /// Captured at subscribe (always inside the runtime) so `forget_window`, called from the main
    /// thread's window-event callback, can still start the grace timer.
    runtime: Option<Handle>,
}

/// Sends one message through a subscriber's flow state. `false` = remove the subscriber (dead
/// channel or no acks).
fn deliver<S: Sink>(sub: &mut Subscriber<S>, message: &[u8], kind: Kind, now: Instant) -> bool {
    match kind {
        Kind::Config => {
            let seq = sub.flow.plan_config();
            sub.sink.media(with_seq(message, seq))
        }
        Kind::Frame { key } => match sub.flow.plan_frame(key, now) {
            Plan::Send(seq) => sub.sink.media(with_seq(message, seq)),
            Plan::Skip => true,
            Plan::Dead => false,
        },
    }
}

impl<S: Sink> Inner<S> {
    fn broadcast_status(&mut self, event: &StatusEvent) {
        // The worker repeats `connecting` after the hub announced it; every subscriber needs each
        // distinct status once.
        if self.cache.status.as_ref() == Some(event) {
            return;
        }
        if event.state != StreamState::Live {
            self.cache.config = None;
            self.cache.key = None;
        }
        self.cache.status = Some(event.clone());
        self.subs.retain(|_, sub| sub.sink.status(event));
    }

    fn broadcast_media(&mut self, message: &[u8], now: Instant) {
        let Some(kind) = classify(message) else {
            return;
        };
        match kind {
            Kind::Config => {
                self.cache.config = Some(message.to_vec());
                // A keyframe from the old configuration cannot be decoded with the new one.
                self.cache.key = None;
            }
            Kind::Frame { key: true } => self.cache.key = Some(message.to_vec()),
            Kind::Frame { key: false } => {}
        }
        self.subs.retain(|_, sub| deliver(sub, message, kind, now));
    }

    /// Status first, then the cached CONFIG and keyframe. `false` = the channel is already dead.
    fn greet(&self, sub: &mut Subscriber<S>, now: Instant) -> bool {
        let status = self
            .cache
            .status
            .clone()
            .unwrap_or_else(|| StatusEvent::new(StreamState::Connecting));
        if !sub.sink.status(&status) {
            return false;
        }
        let Some(config) = &self.cache.config else {
            return true;
        };
        if !deliver(sub, config, Kind::Config, now) {
            return false;
        }
        if let Some(key) = &self.cache.key {
            if !deliver(sub, key, Kind::Frame { key: true }, now) {
                return false;
            }
            sub.flow.require_key();
        }
        true
    }
}

pub struct Hub<S: Sink> {
    inner: Mutex<Inner<S>>,
    grace: Duration,
    /// Counts finished grace checks, so tests can wait for one instead of sleeping.
    #[cfg(test)]
    idle_checks: std::sync::atomic::AtomicUsize,
}

impl<S: Sink> Default for Hub<S> {
    fn default() -> Self {
        Self::new(GRACE)
    }
}

/// The sink the worker writes into: it forwards to the hub, tagged with the worker's id.
struct FanoutSink<S: Sink> {
    hub: Arc<Hub<S>>,
    worker_id: u64,
}

impl<S: Sink> Sink for FanoutSink<S> {
    fn media(&self, message: Vec<u8>) -> bool {
        self.hub.on_media(self.worker_id, &message)
    }

    fn status(&self, event: &StatusEvent) -> bool {
        self.hub.on_status(self.worker_id, event)
    }
}

impl<S: Sink> Hub<S> {
    pub fn new(grace: Duration) -> Self {
        Self {
            inner: Mutex::new(Inner {
                subs: HashMap::new(),
                worker: None,
                cache: Cache::default(),
                grace_epoch: 0,
                worker_seq: 0,
                runtime: None,
            }),
            grace,
            #[cfg(test)]
            idle_checks: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner<S>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[cfg(test)]
    fn subscriber_count(&self) -> usize {
        self.lock().subs.len()
    }

    /// Adds (or replaces) the subscriber `(label, key)`, starting the worker if none is running.
    /// Must run inside the tokio runtime.
    pub fn subscribe(self: &Arc<Self>, label: &str, key: &str, sink: S, start: Start) {
        let mut g = self.lock();
        g.runtime = Some(Handle::current());
        // Cancels a pending grace timer.
        g.grace_epoch += 1;
        // Replace first, so a stale entry for the same widget never lingers.
        g.subs.remove(&(label.to_string(), key.to_string()));
        // A worker that ended by itself (auth failure, unsupported codec, no config) is replaced:
        // a new subscribe is the owner asking again.
        if g.worker.as_ref().is_none_or(|w| w.handle.is_finished()) {
            self.spawn_worker(&mut g, start);
        }
        self.attach(&mut g, label, key, sink, Instant::now());
    }

    fn attach(&self, g: &mut Inner<S>, label: &str, key: &str, sink: S, now: Instant) {
        let mut sub = Subscriber {
            sink,
            flow: Flow::new(now),
        };
        if g.greet(&mut sub, now) {
            g.subs.insert((label.to_string(), key.to_string()), sub);
        }
    }

    fn spawn_worker(self: &Arc<Self>, g: &mut Inner<S>, start: Start) {
        g.worker_seq += 1;
        let id = g.worker_seq;
        g.cache = Cache::default();
        let sink = FanoutSink {
            hub: Arc::clone(self),
            worker_id: id,
        };
        let handle = WorkerHandle::spawn(
            sink,
            Arc::clone(&start.load),
            Arc::clone(&start.shared),
            start.options,
        );
        g.worker = Some(Running { id, handle, start });
        // Subscribers of a replaced worker learn at once that a new attempt is under way.
        g.broadcast_status(&StatusEvent::new(StreamState::Connecting));
    }

    /// Removes the caller's own subscriber; anything unknown is a no-op.
    pub fn unsubscribe(self: &Arc<Self>, label: &str, key: &str) {
        let mut g = self.lock();
        if g.subs
            .remove(&(label.to_string(), key.to_string()))
            .is_some()
        {
            self.after_removal(&mut g);
        }
    }

    /// Removes every subscriber of a destroyed window (its webview can no longer unsubscribe).
    pub fn forget_window(self: &Arc<Self>, label: &str) {
        let mut g = self.lock();
        let before = g.subs.len();
        g.subs.retain(|(l, _), _| l != label);
        if g.subs.len() != before {
            self.after_removal(&mut g);
        }
    }

    /// Records an ack from `(label, key)`; unknown subscribers are ignored.
    pub fn ack(&self, label: &str, key: &str, seq: u32) {
        self.ack_at(label, key, seq, Instant::now());
    }

    fn ack_at(&self, label: &str, key: &str, seq: u32, now: Instant) {
        let mut g = self.lock();
        if let Some(sub) = g.subs.get_mut(&(label.to_string(), key.to_string())) {
            sub.flow.ack(seq, now);
        }
    }

    /// Starts the grace timer when nobody is left.
    fn after_removal(self: &Arc<Self>, g: &mut Inner<S>) {
        if !g.subs.is_empty() {
            return;
        }
        g.grace_epoch += 1;
        let epoch = g.grace_epoch;
        if g.worker.is_none() {
            return;
        }
        let Some(runtime) = g.runtime.clone() else {
            return;
        };
        let hub = Arc::clone(self);
        let grace = self.grace;
        runtime.spawn(async move {
            tokio::time::sleep(grace).await;
            hub.finish_idle(epoch).await;
        });
    }

    /// Stops the worker if the grace period ended with nobody back.
    async fn finish_idle(&self, epoch: u64) {
        let running = {
            let mut g = self.lock();
            if g.grace_epoch == epoch && g.subs.is_empty() {
                g.cache = Cache::default();
                g.worker.take()
            } else {
                None
            }
        };
        if let Some(running) = running {
            // Cooperative: the worker task drops its session (TEARDOWN) itself.
            running.handle.stop().await;
        }
        #[cfg(test)]
        self.idle_checks
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// Restarts the session so a saved config applies. No worker (nobody watching) = nothing to do:
    /// the next subscribe loads the new config anyway. The old session is torn down first, so the
    /// camera never sees two sessions from us.
    pub async fn restart(self: &Arc<Self>) {
        let old = {
            let mut g = self.lock();
            g.cache = Cache::default();
            g.worker.take()
        };
        let Some(old) = old else {
            return;
        };
        let start = old.start.clone();
        old.handle.stop().await;
        let mut g = self.lock();
        // A subscribe that came in meanwhile has already started a worker with the new config.
        if !g.subs.is_empty() && g.worker.is_none() {
            self.spawn_worker(&mut g, start);
        }
    }

    fn on_status(self: &Arc<Self>, worker_id: u64, event: &StatusEvent) -> bool {
        let mut g = self.lock();
        if g.worker.as_ref().map(|w| w.id) != Some(worker_id) {
            return false;
        }
        let had_subs = !g.subs.is_empty();
        g.broadcast_status(event);
        if had_subs {
            self.after_removal(&mut g);
        }
        true
    }

    fn on_media(self: &Arc<Self>, worker_id: u64, message: &[u8]) -> bool {
        if self.lock().worker.as_ref().map(|w| w.id) != Some(worker_id) {
            return false;
        }
        self.media_at(message, Instant::now());
        true
    }

    fn media_at(self: &Arc<Self>, message: &[u8], now: Instant) {
        let mut g = self.lock();
        let had_subs = !g.subs.is_empty();
        g.broadcast_media(message, now);
        if had_subs {
            self.after_removal(&mut g);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fork::camera::config::{CameraConfig, Secret};
    use crate::fork::camera::fake_rtsp::{self, FakeOptions, FakeRtsp};
    use crate::fork::camera::flow::{ACK_TIMEOUT, MAX_IN_FLIGHT};
    use crate::fork::camera::framing::{
        FLAG_KEYFRAME, KIND_CONFIG, KIND_FRAME, encode_config, encode_frame,
    };
    use crate::fork::camera::types::CameraErrorKind;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Debug, Clone, PartialEq)]
    enum Rec {
        Status(StatusEvent),
        Media(Vec<u8>),
    }

    /// A subscriber that records everything and can be "killed" (a destroyed webview).
    #[derive(Clone)]
    struct RecSink {
        log: Arc<Mutex<Vec<Rec>>>,
        alive: Arc<AtomicBool>,
    }

    impl RecSink {
        fn new() -> Self {
            Self {
                log: Arc::default(),
                alive: Arc::new(AtomicBool::new(true)),
            }
        }
        fn log(&self) -> Vec<Rec> {
            self.log.lock().unwrap().clone()
        }
        fn media(&self) -> Vec<Vec<u8>> {
            self.log()
                .into_iter()
                .filter_map(|r| match r {
                    Rec::Media(m) => Some(m),
                    Rec::Status(_) => None,
                })
                .collect()
        }
        fn states(&self) -> Vec<StreamState> {
            self.log()
                .into_iter()
                .filter_map(|r| match r {
                    Rec::Status(e) => Some(e.state),
                    Rec::Media(_) => None,
                })
                .collect()
        }
        /// (kind, key flag, seq) of each media message.
        fn shape(&self) -> Vec<(u8, bool, u32)> {
            self.media()
                .iter()
                .map(|m| {
                    (
                        m[0],
                        m[1] & FLAG_KEYFRAME != 0,
                        u32::from_le_bytes(m[4..8].try_into().unwrap()),
                    )
                })
                .collect()
        }
    }

    impl Sink for RecSink {
        fn media(&self, message: Vec<u8>) -> bool {
            self.alive.load(Ordering::SeqCst) && {
                self.log.lock().unwrap().push(Rec::Media(message));
                true
            }
        }
        fn status(&self, event: &StatusEvent) -> bool {
            self.alive.load(Ordering::SeqCst) && {
                self.log.lock().unwrap().push(Rec::Status(event.clone()));
                true
            }
        }
    }

    fn cfg_msg() -> Vec<u8> {
        encode_config(0, 1920, 1080, "avc1.4d002a", &[1, 2, 3]).unwrap()
    }
    fn key_msg() -> Vec<u8> {
        encode_frame(0, 0, true, &[0, 0, 0, 1, 0x65])
    }
    fn delta_msg() -> Vec<u8> {
        encode_frame(0, 0, false, &[0, 0, 0, 1, 0x41])
    }

    fn hub() -> Arc<Hub<RecSink>> {
        Arc::new(Hub::new(GRACE))
    }

    /// Attaches without a worker, so fan-out rules are tested without any session.
    fn attach(hub: &Hub<RecSink>, label: &str, key: &str, now: Instant) -> RecSink {
        let sink = RecSink::new();
        let mut g = hub.lock();
        hub.attach(&mut g, label, key, sink.clone(), now);
        sink
    }

    fn live() -> StatusEvent {
        StatusEvent::new(StreamState::Live)
    }

    // --- fan-out and cache (no worker) ---

    #[test]
    fn every_subscriber_receives_every_status_once() {
        let hub = hub();
        let a = attach(&hub, "studio", "w1", Instant::now());
        let b = attach(&hub, "overlay-1", "w2", Instant::now());
        let mut retrying = StatusEvent::new(StreamState::Retrying);
        retrying.error = Some(CameraErrorKind::StreamLost);
        retrying.retry_in_ms = Some(1000);
        {
            let mut g = hub.lock();
            g.broadcast_status(&live());
            g.broadcast_status(&live()); // a repeat is not re-sent
            g.broadcast_status(&retrying);
        }
        // Each got its greeting (`connecting`), then the two distinct statuses.
        for sub in [&a, &b] {
            assert_eq!(
                sub.states(),
                [
                    StreamState::Connecting,
                    StreamState::Live,
                    StreamState::Retrying
                ]
            );
        }
        assert_eq!(a.log().last(), Some(&Rec::Status(retrying)));
    }

    #[test]
    fn a_new_subscriber_gets_status_then_config_then_keyframe_then_waits_for_a_real_key() {
        let hub = hub();
        let first = attach(&hub, "studio", "w1", Instant::now());
        let t = Instant::now();
        {
            let mut g = hub.lock();
            g.broadcast_status(&StatusEvent::new(StreamState::Connecting));
            g.broadcast_media(&cfg_msg(), t);
            g.broadcast_media(&key_msg(), t);
            g.broadcast_status(&live());
            g.broadcast_media(&delta_msg(), t);
            g.broadcast_media(&delta_msg(), t);
        }
        assert_eq!(
            first.shape(),
            [
                (KIND_CONFIG, false, 0),
                (KIND_FRAME, true, 0),
                (KIND_FRAME, false, 1),
                (KIND_FRAME, false, 2)
            ]
        );

        // A second widget mounts mid-session: it must start from the cached CONFIG and keyframe.
        let late = attach(&hub, "overlay-1", "w2", t);
        let log = late.log();
        assert_eq!(log[0], Rec::Status(live()), "current status first");
        assert!(matches!(&log[1], Rec::Media(m) if m[0] == KIND_CONFIG));
        assert!(
            matches!(&log[2], Rec::Media(m) if m[0] == KIND_FRAME && m[1] & FLAG_KEYFRAME != 0)
        );
        // Its own numbering starts at 0 even though the first subscriber is at seq 2.
        assert_eq!(
            late.shape(),
            [(KIND_CONFIG, false, 0), (KIND_FRAME, true, 0)]
        );

        // Live deltas are held until the next real keyframe, then seq continues without a gap.
        {
            let mut g = hub.lock();
            g.broadcast_media(&delta_msg(), t);
            g.broadcast_media(&delta_msg(), t);
            g.broadcast_media(&key_msg(), t);
            g.broadcast_media(&delta_msg(), t);
        }
        assert_eq!(
            late.shape(),
            [
                (KIND_CONFIG, false, 0),
                (KIND_FRAME, true, 0),
                (KIND_FRAME, true, 1),
                (KIND_FRAME, false, 2)
            ]
        );
        // The old subscriber saw every one of them.
        assert_eq!(first.shape().len(), 4 + 4);
    }

    #[test]
    fn leaving_live_drops_the_cache_so_a_newcomer_never_sees_a_stale_picture() {
        let hub = hub();
        let t = Instant::now();
        {
            let mut g = hub.lock();
            g.broadcast_status(&live());
            g.broadcast_media(&cfg_msg(), t);
            g.broadcast_media(&key_msg(), t);
            g.broadcast_status(&StatusEvent::new(StreamState::Retrying));
        }
        let late = attach(&hub, "studio", "w1", t);
        assert_eq!(late.states(), [StreamState::Retrying]);
        assert!(late.media().is_empty());
    }

    #[test]
    fn a_new_config_discards_the_old_keyframe() {
        let hub = hub();
        let t = Instant::now();
        {
            let mut g = hub.lock();
            g.broadcast_media(&cfg_msg(), t);
            g.broadcast_media(&key_msg(), t);
            g.broadcast_media(&cfg_msg(), t); // reconnect with new SPS/PPS
        }
        let late = attach(&hub, "studio", "w1", t);
        assert_eq!(late.shape(), [(KIND_CONFIG, false, 0)]);
    }

    #[test]
    fn more_than_24_in_flight_drops_deltas_for_that_subscriber_only_and_a_keyframe_resumes() {
        let hub = hub();
        let t = Instant::now();
        let slow = attach(&hub, "studio", "w1", t);
        let quick = attach(&hub, "overlay-1", "w2", t);
        let frames = |s: &RecSink| s.shape().iter().filter(|(k, ..)| *k == KIND_FRAME).count();
        hub.media_at(&cfg_msg(), t);
        hub.media_at(&key_msg(), t);
        for _ in 0..MAX_IN_FLIGHT {
            hub.media_at(&delta_msg(), t);
        }
        assert_eq!(
            (frames(&slow), frames(&quick)),
            (25, 25),
            "key + 24 deltas each"
        );

        // Only `quick` acks (everything up to seq 24); `slow` stays silent.
        hub.ack_at("overlay-1", "w2", 24, t);
        hub.media_at(&delta_msg(), t);
        assert_eq!(
            (frames(&slow), frames(&quick)),
            (25, 26),
            "slow drops, quick is served"
        );
        hub.media_at(&delta_msg(), t);
        assert_eq!(
            (frames(&slow), frames(&quick)),
            (25, 27),
            "slow waits for a keyframe"
        );

        hub.media_at(&key_msg(), t);
        assert_eq!(
            (frames(&slow), frames(&quick)),
            (26, 28),
            "a keyframe always goes through"
        );
        hub.media_at(&delta_msg(), t);
        assert_eq!(
            (frames(&slow), frames(&quick)),
            (26, 29),
            "still over the window: the keyframe alone does not reopen it"
        );
        hub.ack_at("studio", "w1", 25, t); // the slow one finally catches up
        // Caught up, but the chain was broken by the dropped delta: it still needs a keyframe.
        hub.media_at(&delta_msg(), t);
        assert_eq!((frames(&slow), frames(&quick)), (26, 30));
        hub.media_at(&key_msg(), t);
        hub.media_at(&delta_msg(), t);
        assert_eq!(
            (frames(&slow), frames(&quick)),
            (28, 32),
            "deltas resume after the next keyframe, once acked"
        );
        // Numbering stays gapless for the one that dropped frames.
        let seqs: Vec<u32> = slow
            .shape()
            .iter()
            .filter(|(k, ..)| *k == KIND_FRAME)
            .map(|s| s.2)
            .collect();
        assert_eq!(seqs, (0..28).collect::<Vec<u32>>());
    }

    #[test]
    fn a_subscriber_that_never_acks_is_dropped_after_15_seconds_and_others_stay() {
        let hub = hub();
        let t = Instant::now();
        let _mute = attach(&hub, "studio", "mute", t);
        let _chatty = attach(&hub, "studio", "chatty", t);
        hub.media_at(&cfg_msg(), t);
        hub.media_at(&key_msg(), t);
        // One second short of the limit: both are still served.
        let almost = t + ACK_TIMEOUT - Duration::from_secs(1);
        hub.ack_at("studio", "chatty", 0, almost);
        hub.media_at(&delta_msg(), almost);
        assert_eq!(hub.subscriber_count(), 2);
        // The chatty one keeps acking; the mute one has been silent for the full 15 s.
        hub.ack_at("studio", "chatty", 1, t + ACK_TIMEOUT);
        hub.media_at(&delta_msg(), t + ACK_TIMEOUT);
        assert_eq!(hub.subscriber_count(), 1);
        assert!(
            hub.lock()
                .subs
                .contains_key(&("studio".into(), "chatty".into()))
        );
    }

    #[test]
    fn a_dead_channel_removes_its_subscriber() {
        let hub = hub();
        let t = Instant::now();
        let gone = attach(&hub, "studio", "w1", t);
        let _other = attach(&hub, "overlay-1", "w2", t);
        gone.alive.store(false, Ordering::SeqCst);
        hub.media_at(&cfg_msg(), t);
        assert_eq!(hub.subscriber_count(), 1);
    }

    #[test]
    fn unknown_acks_and_unsubscribes_are_no_ops() {
        let hub = hub();
        let _a = attach(&hub, "studio", "w1", Instant::now());
        hub.ack("overlay-1", "w1", 5);
        hub.ack("studio", "nope", 5);
        hub.unsubscribe("overlay-1", "w1");
        hub.unsubscribe("studio", "nope");
        assert_eq!(hub.subscriber_count(), 1);
    }

    #[test]
    fn forget_window_removes_every_subscriber_of_that_window_only() {
        let hub = hub();
        let t = Instant::now();
        for (label, key) in [("overlay-1", "a"), ("overlay-1", "b"), ("studio", "c")] {
            attach(&hub, label, key, t);
        }
        hub.forget_window("overlay-1");
        assert_eq!(hub.subscriber_count(), 1);
        assert!(hub.lock().subs.contains_key(&("studio".into(), "c".into())));
        hub.forget_window("overlay-9"); // unknown label: no-op
        assert_eq!(hub.subscriber_count(), 1);
    }

    // --- worker lifecycle against the fake camera (real clock, short grace) ---

    const TEST_GRACE: Duration = Duration::from_millis(150);

    fn fast() -> WorkerOptions {
        use crate::fork::camera::backoff::Policy;
        WorkerOptions {
            step_timeout: Duration::from_secs(2),
            item_timeout: Duration::from_secs(2),
            backoff: Policy {
                base: Duration::from_millis(50),
                cap: Duration::from_millis(200),
                reset_after_live: Duration::from_secs(10),
            },
        }
    }

    fn config_for(fake: &FakeRtsp, pass: &str) -> CameraConfig {
        CameraConfig {
            url: fake.url(),
            username: fake_rtsp::USER.into(),
            password: Secret::new(pass),
        }
    }

    fn start_with(config: CameraConfig, shared: &Arc<Shared>) -> Start {
        Start {
            load: Arc::new(move || Ok(Some(config.clone()))),
            shared: Arc::clone(shared),
            options: fast(),
        }
    }

    fn graceful_hub() -> Arc<Hub<RecSink>> {
        Arc::new(Hub::new(TEST_GRACE))
    }

    /// Polls a condition for at most 3 s.
    async fn wait_for(what: &str, done: impl Fn() -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while !done() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {what}"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn idle_checks(hub: &Hub<RecSink>) -> usize {
        hub.idle_checks.load(Ordering::SeqCst)
    }

    #[tokio::test]
    async fn two_subscribers_share_one_rtsp_session() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let shared = Arc::new(Shared::default());
        let hub = graceful_hub();
        let start = start_with(config_for(&fake, fake_rtsp::PASS), &shared);
        let (a, b) = (RecSink::new(), RecSink::new());
        hub.subscribe("studio", "w1", a.clone(), start.clone());
        hub.subscribe("overlay-1", "w2", b.clone(), start);
        for sink in [&a, &b] {
            wait_for("live", || sink.states().contains(&StreamState::Live)).await;
        }
        assert_eq!(fake.accepts(), 1, "one RTSP session for two widgets");
        // The second subscriber joined before the first frame, so it saw the same stream from the
        // start: CONFIG, then a keyframe, each numbered from 0.
        for sink in [&a, &b] {
            wait_for("frames", || sink.media().len() >= 4).await;
            let shape = sink.shape();
            assert_eq!(shape[0], (KIND_CONFIG, false, 0));
            assert_eq!(shape[1], (KIND_FRAME, true, 0));
            assert_eq!(shape[2].2, 1);
        }
        assert_eq!(hub.subscriber_count(), 2);
    }

    #[tokio::test]
    async fn the_last_unsubscribe_stops_the_session_after_the_grace() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let shared = Arc::new(Shared::default());
        let hub = graceful_hub();
        let start = start_with(config_for(&fake, fake_rtsp::PASS), &shared);
        let (a, b) = (RecSink::new(), RecSink::new());
        hub.subscribe("studio", "w1", a.clone(), start.clone());
        hub.subscribe("studio", "w2", b.clone(), start);
        wait_for("live", || a.states().contains(&StreamState::Live)).await;

        hub.unsubscribe("studio", "w1");
        assert_eq!(fake.closed(), 0, "a subscriber is left: the session stays");

        hub.unsubscribe("studio", "w2");
        assert_eq!(fake.closed(), 0, "inside the grace the session is still up");
        wait_for("idle check", || idle_checks(&hub) == 1).await;
        wait_for("teardown", || fake.closed() == 1 && fake.teardowns() == 1).await;
        assert_eq!(fake.accepts(), 1);
    }

    #[tokio::test]
    async fn a_resubscribe_inside_the_grace_keeps_the_session() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let shared = Arc::new(Shared::default());
        let hub = graceful_hub();
        let start = start_with(config_for(&fake, fake_rtsp::PASS), &shared);
        let a = RecSink::new();
        hub.subscribe("studio", "w1", a.clone(), start.clone());
        wait_for("live", || a.states().contains(&StreamState::Live)).await;

        hub.unsubscribe("studio", "w1");
        // StrictMode-style remount: a fresh channel for the same widget.
        let again = RecSink::new();
        hub.subscribe("studio", "w1", again.clone(), start);
        wait_for("the cancelled grace check", || idle_checks(&hub) == 1).await;
        assert_eq!(fake.closed(), 0, "the shutdown was cancelled");
        assert_eq!(fake.accepts(), 1, "no second session");
        // The remounted widget was greeted from the cache: status, CONFIG, keyframe.
        assert_eq!(again.states()[0], StreamState::Live);
        assert_eq!(
            again.shape()[..2],
            [(KIND_CONFIG, false, 0), (KIND_FRAME, true, 0)]
        );
        assert_eq!(hub.subscriber_count(), 1);
    }

    #[tokio::test]
    async fn forgetting_the_last_window_starts_the_grace_and_stops_the_session() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let shared = Arc::new(Shared::default());
        let hub = graceful_hub();
        let start = start_with(config_for(&fake, fake_rtsp::PASS), &shared);
        let (a, b) = (RecSink::new(), RecSink::new());
        hub.subscribe("overlay-1", "w1", a.clone(), start.clone());
        hub.subscribe("studio", "w2", b.clone(), start);
        wait_for("live", || b.states().contains(&StreamState::Live)).await;

        hub.forget_window("overlay-1");
        assert_eq!(hub.subscriber_count(), 1);
        hub.forget_window("studio");
        assert_eq!(hub.subscriber_count(), 0);
        wait_for("teardown", || fake.closed() == 1 && fake.teardowns() == 1).await;
    }

    #[tokio::test]
    async fn a_save_restarts_the_session_with_the_new_login() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let shared = Arc::new(Shared::default());
        let hub = graceful_hub();
        // The loader serves whatever the "owner saved" last.
        let saved = Arc::new(Mutex::new(config_for(&fake, "wrong_pw")));
        let cell = Arc::clone(&saved);
        let start = Start {
            load: Arc::new(move || Ok(Some(cell.lock().unwrap().clone()))),
            shared: Arc::clone(&shared),
            options: fast(),
        };
        let a = RecSink::new();
        hub.subscribe("studio", "w1", a.clone(), start);
        wait_for("auth failure", || {
            a.states().contains(&StreamState::AuthFailed)
        })
        .await;
        assert!(shared.auth_locked());
        assert_eq!(fake.accepts(), 1);

        // The save: new password, generation bump (lifts the lockout), restart.
        *saved.lock().unwrap() = config_for(&fake, fake_rtsp::PASS);
        shared.bump_generation();
        hub.restart().await;
        wait_for("live after the save", || {
            a.states().contains(&StreamState::Live)
        })
        .await;
        assert_eq!(fake.accepts(), 2, "exactly one new attempt");

        assert_eq!(
            a.states()
                .iter()
                .filter(|s| **s == StreamState::Live)
                .count(),
            1
        );
        // A second save while live: the old session is torn down before the new one starts.
        shared.bump_generation();
        hub.restart().await;
        wait_for("a third connection", || fake.accepts() == 3).await;
        wait_for("old session closed", || {
            fake.closed() >= 2 && fake.teardowns() >= 1
        })
        .await;
        wait_for("live again", || {
            a.states()
                .iter()
                .filter(|s| **s == StreamState::Live)
                .count()
                >= 2
        })
        .await;
    }

    #[tokio::test]
    async fn a_restart_with_nobody_watching_does_nothing() {
        let hub = graceful_hub();
        hub.restart().await;
        assert_eq!(hub.subscriber_count(), 0);
        assert!(hub.lock().worker.is_none());
    }

    #[tokio::test]
    async fn a_stall_mid_stream_tells_every_subscriber_it_is_retrying_with_the_backoff_delay() {
        // The fake sends its frames and then goes quiet, i.e. the camera freezes mid-stream.
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let shared = Arc::new(Shared::default());
        let hub = graceful_hub();
        let mut start = start_with(config_for(&fake, fake_rtsp::PASS), &shared);
        start.options.item_timeout = Duration::from_millis(150);
        let (a, b) = (RecSink::new(), RecSink::new());
        hub.subscribe("studio", "w1", a.clone(), start.clone());
        hub.subscribe("overlay-1", "w2", b.clone(), start);
        let retrying = |s: &RecSink| {
            s.log().into_iter().find_map(|r| match r {
                Rec::Status(e) if e.state == StreamState::Retrying => Some(e),
                _ => None,
            })
        };
        for sink in [&a, &b] {
            wait_for("retrying", || retrying(sink).is_some()).await;
            let event = retrying(sink).unwrap();
            assert_eq!(event.error, Some(CameraErrorKind::StreamLost));
            assert_eq!(event.retry_in_ms, Some(50), "first rung of the ladder");
        }
        // ... and then it reconnects by itself.
        wait_for("reconnect", || fake.accepts() >= 2).await;
    }
}
