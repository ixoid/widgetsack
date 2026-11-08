//! The RTSP session pump (phase 1, ADR-005): DESCRIBE/SETUP/PLAY the saved camera through retina
//! and push CONFIG then FRAME messages (`framing`) plus Json status events into one sink.
//!
//! Invariants:
//! - Credentials are built into `retina::Credentials` at the last moment and never formatted;
//!   retina errors are reduced to phase + status code (`error_map`) and never formatted either.
//! - The retina `Session` lives only inside the worker task. Dropping it runs `tokio::spawn`
//!   (background TEARDOWN), so it must be dropped inside the runtime: shutdown is cooperative
//!   (`select!` on a watch channel drops the attempt future in the task), never a drop from sync
//!   code or `spawn_blocking`.
//! - 401/403 sets the shared auth lockout (keyed to the generation read before the attempt loaded
//!   its config) and ends the worker. Transient failures retry after a fixed delay (exponential
//!   backoff is phase 2). Failures a retry cannot fix (404, protocol) park the worker: one status
//!   event, no more attempts until a config save bumps the generation.
//! - Deltas are never sent before a keyframe after each CONFIG; an AU above `MAX_AU_BYTES` is
//!   dropped and the stream waits for the next keyframe.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use retina::client::{
    Credentials, Demuxed, Described, PlayOptions, Session, SessionOptions, SetupOptions, Transport,
};
use retina::codec::{CodecItem, FrameFormat, ParametersRef};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use url::Url;

use super::Shared;
use super::config::{self, CameraConfig};
use super::error_map::{self, Phase};
use super::framing::{encode_config, encode_frame, ticks_to_us};
use super::types::{CameraErrorKind, StatusEvent, StreamState};

pub const STEP_TIMEOUT: Duration = Duration::from_secs(10);
pub const ITEM_TIMEOUT: Duration = Duration::from_secs(8);
pub const RETRY_DELAY: Duration = Duration::from_secs(2);
pub const JOIN_TIMEOUT: Duration = Duration::from_secs(2);
pub const MAX_AU_BYTES: usize = 4 * 1024 * 1024;

/// Where the worker's messages go. `false` from either method means the receiver is gone.
pub trait Sink: Send + Sync + 'static {
    fn media(&self, message: Vec<u8>) -> bool;
    fn status(&self, event: &StatusEvent) -> bool;
}

impl Sink for Channel<InvokeResponseBody> {
    fn media(&self, message: Vec<u8>) -> bool {
        self.send(InvokeResponseBody::Raw(message)).is_ok()
    }

    fn status(&self, event: &StatusEvent) -> bool {
        serde_json::to_string(event)
            .is_ok_and(|json| self.send(InvokeResponseBody::Json(json)).is_ok())
    }
}

/// Reads the saved config (DPAPI); run through `spawn_blocking`.
pub type LoadConfig = Arc<dyn Fn() -> Result<Option<CameraConfig>, String> + Send + Sync>;

#[derive(Clone, Copy, Debug)]
pub struct WorkerOptions {
    pub step_timeout: Duration,
    pub item_timeout: Duration,
    pub retry_delay: Duration,
}

impl Default for WorkerOptions {
    fn default() -> Self {
        Self {
            step_timeout: STEP_TIMEOUT,
            item_timeout: ITEM_TIMEOUT,
            retry_delay: RETRY_DELAY,
        }
    }
}

/// A running worker and who it serves.
pub struct WorkerHandle {
    pub label: String,
    pub key: String,
    shutdown: watch::Sender<bool>,
    join: JoinHandle<()>,
}

impl WorkerHandle {
    /// Must be called inside the tokio runtime (async commands run on Tauri's tokio runtime), so the
    /// task — and the retina session it owns — always lives and drops there.
    pub fn spawn<S: Sink>(
        label: String,
        key: String,
        sink: S,
        load: LoadConfig,
        shared: Arc<Shared>,
        options: WorkerOptions,
    ) -> Self {
        let (shutdown, rx) = watch::channel(false);
        let join = tokio::spawn(run(sink, load, shared, options, rx));
        Self {
            label,
            key,
            shutdown,
            join,
        }
    }

    /// Cooperative stop: the task drops its session (TEARDOWN) itself; abort only if it hangs.
    pub async fn stop(mut self) {
        let _ = self.shutdown.send(true);
        if tokio::time::timeout(JOIN_TIMEOUT, &mut self.join)
            .await
            .is_err()
        {
            self.join.abort();
        }
    }
}

/// A config the worker can use: present and with a valid canonical address.
fn usable(config: Option<CameraConfig>) -> Option<CameraConfig> {
    config.filter(|c| config::validate_address(&c.url).is_ok())
}

/// DESCRIBE the saved camera. Returns the session and the index of its first video stream.
pub(super) async fn describe(
    config: &CameraConfig,
    step_timeout: Duration,
) -> Result<(Session<Described>, usize), CameraErrorKind> {
    let url = Url::parse(&config.url).map_err(|_| CameraErrorKind::Protocol)?;
    // The stored address never has userinfo (config invariant); refuse rather than send it.
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CameraErrorKind::Protocol);
    }
    let creds = (!config.username.is_empty()).then(|| Credentials {
        username: config.username.clone(),
        password: config.password.expose().to_owned(),
    });
    let options = SessionOptions::default().creds(creds);
    let session = match tokio::time::timeout(step_timeout, Session::describe(url, options)).await {
        Err(_) => return Err(error_map::map(Phase::Describe, None, true)),
        Ok(Err(e)) => return Err(error_map::map(Phase::Describe, e.status_code(), false)),
        Ok(Ok(session)) => session,
    };
    let stream_i = session
        .streams()
        .iter()
        .position(|s| s.media() == "video")
        .ok_or(CameraErrorKind::Protocol)?;
    Ok((session, stream_i))
}

pub(super) fn is_h264(stream: &retina::client::Stream) -> bool {
    stream.encoding_name() == "h264"
}

/// SDP codec name for display (`H264`, `H265`, ...).
pub(super) fn codec_name(stream: &retina::client::Stream) -> String {
    stream.encoding_name().to_ascii_uppercase()
}

enum Outcome {
    /// The worker is done (shutdown, sink gone, auth failure, unsupported codec, no config).
    Stop,
    Retry(CameraErrorKind),
}

/// A wrong path or a stream retina cannot read stays wrong until the owner edits the config, so
/// retrying every few seconds would only poll the camera forever.
fn needs_a_save(kind: CameraErrorKind) -> bool {
    matches!(kind, CameraErrorKind::NotFound | CameraErrorKind::Protocol)
}

/// Whether an access unit may be sent. A keyframe is required first (after each CONFIG and after a
/// dropped oversized unit); an oversized unit is dropped and re-arms the wait.
fn admit_unit(seen_key: &mut bool, is_key: bool, len: usize) -> bool {
    if !*seen_key && !is_key {
        return false;
    }
    if len > MAX_AU_BYTES {
        *seen_key = false;
        return false;
    }
    *seen_key = true;
    true
}

fn log_failure(kind: CameraErrorKind, phase: &'static str) {
    crate::log::warn("camera", "stream attempt failed")
        .field("kind", kind)
        .field("phase", phase)
        .emit();
}

pub async fn run<S: Sink>(
    sink: S,
    load: LoadConfig,
    shared: Arc<Shared>,
    options: WorkerOptions,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        // Read before the attempt loads its config, so a save during the attempt is a newer
        // generation than anything this attempt can lock out.
        let generation = shared.generation();
        let outcome = tokio::select! {
            biased;
            () = wait_shutdown(&mut shutdown) => Outcome::Stop,
            outcome = attempt(&sink, &load, &shared, &options, generation) => outcome,
        };
        let Outcome::Retry(kind) = outcome else {
            return;
        };
        let parked = needs_a_save(kind);
        let mut event = StatusEvent::new(StreamState::Retrying);
        event.error = Some(kind);
        // No delay = "waiting for a config save", not a timed retry.
        event.retry_in_ms =
            (!parked).then(|| u64::try_from(options.retry_delay.as_millis()).unwrap_or(u64::MAX));
        if !sink.status(&event) {
            return;
        }
        tokio::select! {
            biased;
            () = wait_shutdown(&mut shutdown) => return,
            () = wait_for_next_try(&shared, parked, generation, options.retry_delay) => {}
        }
    }
}

async fn wait_for_next_try(shared: &Shared, parked: bool, generation: u64, delay: Duration) {
    if parked {
        shared.generation_changed_from(generation).await;
    } else {
        tokio::time::sleep(delay).await;
    }
}

async fn wait_shutdown(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() {
            return;
        }
        // A dropped sender (handle gone) also means stop.
        if rx.changed().await.is_err() {
            return;
        }
    }
}

fn status_with_error(state: StreamState, error: CameraErrorKind) -> StatusEvent {
    let mut event = StatusEvent::new(state);
    event.error = Some(error);
    event
}

/// One connect-and-stream attempt. Everything retina-owned is a local of this future, so dropping
/// the future (shutdown) drops the session inside the worker task.
async fn attempt<S: Sink>(
    sink: &S,
    load: &LoadConfig,
    shared: &Shared,
    options: &WorkerOptions,
    generation: u64,
) -> Outcome {
    if shared.auth_locked() {
        sink.status(&status_with_error(
            StreamState::AuthFailed,
            CameraErrorKind::AuthFailed,
        ));
        return Outcome::Stop;
    }
    let load = Arc::clone(load);
    let config = match tokio::task::spawn_blocking(move || load()).await {
        Ok(Ok(config)) => usable(config),
        // A corrupt or unreadable file does not fix itself; a save restarts the stream.
        _ => None,
    };
    let Some(config) = config else {
        sink.status(&StatusEvent::new(StreamState::NotConfigured));
        return Outcome::Stop;
    };
    if !sink.status(&StatusEvent::new(StreamState::Connecting)) {
        return Outcome::Stop;
    }
    let described = describe(&config, options.step_timeout).await;
    drop(config); // the credentials are no longer needed in this frame
    let (mut session, stream_i) = match described {
        Ok(v) => v,
        Err(kind) => return give_up_or_retry(sink, shared, generation, kind, Phase::Describe),
    };
    let stream = &session.streams()[stream_i];
    if !is_h264(stream) {
        let mut event = status_with_error(
            StreamState::UnsupportedCodec,
            CameraErrorKind::UnsupportedCodec,
        );
        event.codec = Some(codec_name(stream));
        sink.status(&event);
        return Outcome::Stop;
    }
    let setup = SetupOptions::default()
        .transport(Transport::Tcp(Default::default()))
        .frame_format(FrameFormat::MP4);
    match tokio::time::timeout(options.step_timeout, session.setup(stream_i, setup)).await {
        Err(_) => {
            return give_up_or_retry(
                sink,
                shared,
                generation,
                CameraErrorKind::Timeout,
                Phase::Setup,
            );
        }
        Ok(Err(e)) => {
            let kind = error_map::map(Phase::Setup, e.status_code(), false);
            return give_up_or_retry(sink, shared, generation, kind, Phase::Setup);
        }
        Ok(Ok(())) => {}
    }
    let playing = match tokio::time::timeout(
        options.step_timeout,
        session.play(PlayOptions::default()),
    )
    .await
    {
        Err(_) => {
            return give_up_or_retry(
                sink,
                shared,
                generation,
                CameraErrorKind::Timeout,
                Phase::Play,
            );
        }
        Ok(Err(e)) => {
            let kind = error_map::map(Phase::Play, e.status_code(), false);
            return give_up_or_retry(sink, shared, generation, kind, Phase::Play);
        }
        Ok(Ok(playing)) => playing,
    };
    let demuxed = match playing.demuxed() {
        Ok(d) => d,
        Err(_) => {
            return give_up_or_retry(
                sink,
                shared,
                generation,
                CameraErrorKind::Protocol,
                Phase::Play,
            );
        }
    };
    pump(sink, demuxed, stream_i, options.item_timeout).await
}

fn give_up_or_retry<S: Sink>(
    sink: &S,
    shared: &Shared,
    generation: u64,
    kind: CameraErrorKind,
    phase: Phase,
) -> Outcome {
    log_failure(kind, phase.as_str());
    match kind {
        CameraErrorKind::AuthFailed => {
            shared.lock_auth_for(generation);
            sink.status(&status_with_error(StreamState::AuthFailed, kind));
            Outcome::Stop
        }
        _ => Outcome::Retry(kind),
    }
}

async fn pump<S: Sink>(
    sink: &S,
    mut demuxed: Demuxed,
    stream_i: usize,
    item_timeout: Duration,
) -> Outcome {
    let mut seq: u32 = 0;
    let mut configured = false;
    let mut seen_key = false;
    let mut live = false;
    loop {
        let item = match tokio::time::timeout(item_timeout, demuxed.next()).await {
            Ok(Some(Ok(item))) => item,
            // Stall, end of stream or a broken stream: all "lost" (error text is never inspected).
            _ => {
                log_failure(CameraErrorKind::StreamLost, Phase::Stream.as_str());
                return Outcome::Retry(error_map::map(Phase::Stream, None, false));
            }
        };
        let CodecItem::VideoFrame(frame) = item else {
            continue;
        };
        if frame.stream_id() != stream_i {
            continue;
        }
        let mut codec = None;
        if !configured || frame.has_new_parameters() {
            let Some(ParametersRef::Video(params)) = demuxed.streams()[stream_i].parameters()
            else {
                return Outcome::Retry(CameraErrorKind::Protocol);
            };
            let (width, height) = params.pixel_dimensions();
            seq = 0;
            let Some(message) = encode_config(
                seq,
                width,
                height,
                params.rfc6381_codec(),
                params.extra_data(),
            ) else {
                return Outcome::Retry(CameraErrorKind::Protocol);
            };
            codec = Some(params.rfc6381_codec().to_owned());
            if !sink.media(message) {
                return Outcome::Stop;
            }
            configured = true;
            // A (re)configured decoder needs a keyframe before any delta.
            seen_key = false;
        }
        let is_key = frame.is_random_access_point();
        if !admit_unit(&mut seen_key, is_key, frame.data().len()) {
            continue;
        }
        let timestamp = frame.timestamp();
        let ts_us = ticks_to_us(timestamp.elapsed(), timestamp.clock_rate().get());
        if !sink.media(encode_frame(seq, ts_us, is_key, frame.data())) {
            return Outcome::Stop;
        }
        seq = seq.wrapping_add(1);
        if !live {
            live = true;
            let mut event = StatusEvent::new(StreamState::Live);
            event.codec = codec;
            if !sink.status(&event) {
                return Outcome::Stop;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fork::camera::config::Secret;
    use crate::fork::camera::fake_rtsp::{self, FakeOptions, FakeRtsp, TS_STEP};
    use crate::fork::camera::framing::{FLAG_KEYFRAME, FRAME_PREFIX_LEN, KIND_CONFIG, KIND_FRAME};
    use std::sync::Mutex;
    use tokio::sync::Notify;

    #[derive(Debug, Clone)]
    enum Msg {
        Media(Vec<u8>),
        Status(StatusEvent),
    }

    #[derive(Clone, Default)]
    struct VecSink {
        msgs: Arc<Mutex<Vec<Msg>>>,
        notify: Arc<Notify>,
    }

    impl Sink for VecSink {
        fn media(&self, message: Vec<u8>) -> bool {
            self.msgs.lock().unwrap().push(Msg::Media(message));
            self.notify.notify_waiters();
            true
        }
        fn status(&self, event: &StatusEvent) -> bool {
            self.msgs.lock().unwrap().push(Msg::Status(event.clone()));
            self.notify.notify_waiters();
            true
        }
    }

    impl VecSink {
        fn snapshot(&self) -> Vec<Msg> {
            self.msgs.lock().unwrap().clone()
        }
        fn media(&self) -> Vec<Vec<u8>> {
            self.snapshot()
                .into_iter()
                .filter_map(|m| match m {
                    Msg::Media(b) => Some(b),
                    Msg::Status(_) => None,
                })
                .collect()
        }
        fn states(&self) -> Vec<StreamState> {
            self.snapshot()
                .into_iter()
                .filter_map(|m| match m {
                    Msg::Status(e) => Some(e.state),
                    Msg::Media(_) => None,
                })
                .collect()
        }
        /// Waits (bounded) until `done` holds over the collected messages.
        async fn wait_until(&self, done: impl Fn(&VecSink) -> bool) {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            while !done(self) {
                let notified = self.notify.notified();
                if done(self) {
                    break;
                }
                assert!(
                    tokio::time::timeout_at(deadline, notified).await.is_ok(),
                    "timed out; got {:?}",
                    self.states()
                );
            }
        }
    }

    fn config_for(url: &str, user: &str, pass: &str) -> CameraConfig {
        CameraConfig {
            url: url.to_string(),
            username: user.to_string(),
            password: Secret::new(pass),
        }
    }

    fn loader(config: CameraConfig) -> LoadConfig {
        Arc::new(move || Ok(Some(config.clone())))
    }

    fn fast() -> WorkerOptions {
        WorkerOptions {
            step_timeout: Duration::from_secs(2),
            item_timeout: Duration::from_secs(2),
            retry_delay: Duration::from_millis(50),
        }
    }

    fn start(sink: VecSink, config: CameraConfig, shared: Arc<Shared>) -> WorkerHandle {
        WorkerHandle::spawn(
            "studio".into(),
            "w1".into(),
            sink,
            loader(config),
            shared,
            fast(),
        )
    }

    fn frame_fields(msg: &[u8]) -> (bool, u32, u64) {
        assert_eq!(msg[0], KIND_FRAME);
        let seq = u32::from_le_bytes(msg[4..8].try_into().unwrap());
        let ts = u64::from_le_bytes(msg[8..16].try_into().unwrap());
        (msg[1] & FLAG_KEYFRAME != 0, seq, ts)
    }

    #[tokio::test]
    async fn streams_config_then_keyframe_then_deltas_with_monotonic_timestamps() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let sink = VecSink::default();
        let handle = start(
            sink.clone(),
            config_for(&fake.url(), fake_rtsp::USER, fake_rtsp::PASS),
            Arc::new(Shared::default()),
        );
        sink.wait_until(|s| s.media().len() >= 5).await;
        handle.stop().await;

        let media = sink.media();
        let config = &media[0];
        assert_eq!(config[0], KIND_CONFIG);
        assert_eq!(&config[8..10], &1920u16.to_le_bytes());
        assert_eq!(&config[10..12], &1080u16.to_le_bytes());
        let codec_len = usize::from(config[12]);
        let codec = std::str::from_utf8(&config[13..13 + codec_len]).unwrap();
        assert!(codec.starts_with("avc1."), "{codec}");
        let avcc = &config[13 + codec_len..];
        assert_eq!(avcc[0], 1, "avcC configurationVersion");

        let aus = fake_rtsp::access_units(3);
        let mut last_ts = None;
        for (i, msg) in media[1..5].iter().enumerate() {
            let (key, seq, ts) = frame_fields(msg);
            assert_eq!(key, i == 0, "only the first frame is a keyframe");
            assert_eq!(seq, i as u32);
            assert_eq!(ts, ticks_to_us(i64::from(TS_STEP) * i as i64, 90_000));
            if let Some(prev) = last_ts {
                assert!(ts > prev);
            }
            last_ts = Some(ts);
            // MP4 framing: 4-byte big-endian length prefix + the NAL as sent.
            let payload = &msg[FRAME_PREFIX_LEN..];
            assert_eq!(&payload[..4], &(aus[i].len() as u32).to_be_bytes());
            assert_eq!(&payload[4..], aus[i].as_slice());
        }
        assert_eq!(
            sink.states(),
            vec![StreamState::Connecting, StreamState::Live]
        );
        assert_eq!(fake.accepts(), 1);
    }

    #[tokio::test]
    async fn a_dropped_connection_opens_a_second_session() {
        let fake = FakeRtsp::start(FakeOptions {
            drop_connections: 1,
            ..FakeOptions::default()
        })
        .await;
        let sink = VecSink::default();
        let handle = start(
            sink.clone(),
            config_for(&fake.url(), fake_rtsp::USER, fake_rtsp::PASS),
            Arc::new(Shared::default()),
        );
        let configs = |s: &VecSink| s.media().iter().filter(|m| m[0] == KIND_CONFIG).count();
        sink.wait_until(|s| configs(s) >= 2).await;
        handle.stop().await;
        assert_eq!(fake.accepts(), 2);
        let retrying: Vec<StatusEvent> = sink
            .snapshot()
            .into_iter()
            .filter_map(|m| match m {
                Msg::Status(e) if e.state == StreamState::Retrying => Some(e),
                _ => None,
            })
            .collect();
        assert_eq!(retrying.len(), 1);
        assert_eq!(retrying[0].error, Some(CameraErrorKind::StreamLost));
        assert_eq!(retrying[0].retry_in_ms, Some(50));
        // The second session starts over with CONFIG + keyframe at seq 0.
        let media = sink.media();
        let second = media.iter().rposition(|m| m[0] == KIND_CONFIG).unwrap();
        let (key, seq, _) = frame_fields(&media[second + 1]);
        assert!(key);
        assert_eq!(seq, 0);
    }

    #[tokio::test]
    async fn wrong_credentials_make_exactly_one_attempt_and_lock_out() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let sink = VecSink::default();
        let shared = Arc::new(Shared::default());
        let handle = start(
            sink.clone(),
            config_for(&fake.url(), fake_rtsp::USER, "wrong"),
            Arc::clone(&shared),
        );
        sink.wait_until(|s| s.states().contains(&StreamState::AuthFailed))
            .await;
        // The worker ends by itself; give a retry (50 ms) ample time to show up if it existed.
        tokio::time::timeout(Duration::from_millis(500), handle.join)
            .await
            .expect("worker stops after 401")
            .unwrap();
        assert_eq!(fake.accepts(), 1);
        assert!(sink.media().is_empty());
        assert!(shared.auth_locked());
        let event = sink
            .snapshot()
            .into_iter()
            .find_map(|m| match m {
                Msg::Status(e) if e.state == StreamState::AuthFailed => Some(e),
                _ => None,
            })
            .unwrap();
        assert_eq!(event.error, Some(CameraErrorKind::AuthFailed));

        // While locked, a new worker refuses without touching the network.
        let sink2 = VecSink::default();
        let handle = start(
            sink2.clone(),
            config_for(&fake.url(), fake_rtsp::USER, fake_rtsp::PASS),
            Arc::clone(&shared),
        );
        sink2
            .wait_until(|s| s.states().contains(&StreamState::AuthFailed))
            .await;
        handle.stop().await;
        assert_eq!(fake.accepts(), 1);
    }

    #[tokio::test]
    async fn an_unsupported_codec_stops_without_retrying() {
        let fake = FakeRtsp::start(FakeOptions {
            encoding: "H265",
            ..FakeOptions::default()
        })
        .await;
        let sink = VecSink::default();
        let handle = start(
            sink.clone(),
            config_for(&fake.url(), fake_rtsp::USER, fake_rtsp::PASS),
            Arc::new(Shared::default()),
        );
        sink.wait_until(|s| s.states().contains(&StreamState::UnsupportedCodec))
            .await;
        tokio::time::timeout(Duration::from_millis(500), handle.join)
            .await
            .expect("worker stops")
            .unwrap();
        let event = sink
            .snapshot()
            .into_iter()
            .find_map(|m| match m {
                Msg::Status(e) if e.state == StreamState::UnsupportedCodec => Some(e),
                _ => None,
            })
            .unwrap();
        assert_eq!(event.codec.as_deref(), Some("H265"));
        assert_eq!(fake.accepts(), 1);
    }

    #[tokio::test]
    async fn no_config_reports_not_configured_and_stops() {
        let sink = VecSink::default();
        let handle = WorkerHandle::spawn(
            "studio".into(),
            "w1".into(),
            sink.clone(),
            Arc::new(|| Ok(None)),
            Arc::new(Shared::default()),
            fast(),
        );
        sink.wait_until(|s| !s.states().is_empty()).await;
        handle.stop().await;
        assert_eq!(sink.states(), vec![StreamState::NotConfigured]);
    }

    #[tokio::test]
    async fn an_unreachable_camera_retries_until_stopped() {
        let (port, server) = fake_rtsp::closing_listener().await;
        let sink = VecSink::default();
        let handle = start(
            sink.clone(),
            config_for(&format!("rtsp://127.0.0.1:{port}/ch2"), "", ""),
            Arc::new(Shared::default()),
        );
        let retries = |s: &VecSink| {
            s.states()
                .iter()
                .filter(|st| **st == StreamState::Retrying)
                .count()
        };
        sink.wait_until(|s| retries(s) >= 2).await;
        handle.stop().await;
        server.abort();
        let first_retry = sink
            .snapshot()
            .into_iter()
            .find_map(|m| match m {
                Msg::Status(e) if e.state == StreamState::Retrying => Some(e),
                _ => None,
            })
            .unwrap();
        assert_eq!(first_retry.error, Some(CameraErrorKind::Unreachable));
    }

    #[tokio::test]
    async fn stop_ends_a_live_session_promptly() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let sink = VecSink::default();
        let handle = start(
            sink.clone(),
            config_for(&fake.url(), fake_rtsp::USER, fake_rtsp::PASS),
            Arc::new(Shared::default()),
        );
        sink.wait_until(|s| s.states().contains(&StreamState::Live))
            .await;
        let started = std::time::Instant::now();
        handle.stop().await;
        assert!(
            started.elapsed() < JOIN_TIMEOUT,
            "cooperative stop, not abort"
        );
        let count = sink.snapshot().len();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(sink.snapshot().len(), count, "nothing sent after stop");
        // The session was really dropped: the camera sees the TCP connection close (retina sends a
        // TEARDOWN on the way out, best effort).
        wait_for(|| fake.closed() == 1 && fake.teardowns() == 1).await;
        assert_eq!(fake.accepts(), 1);
    }

    /// Polls a condition for at most 3 s.
    async fn wait_for(done: impl Fn() -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while !done() {
            assert!(tokio::time::Instant::now() < deadline, "timed out");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn a_delta_before_the_first_keyframe_is_never_sent() {
        let fake = FakeRtsp::start(FakeOptions {
            leading_delta: true,
            ..FakeOptions::default()
        })
        .await;
        let sink = VecSink::default();
        let handle = start(
            sink.clone(),
            config_for(&fake.url(), fake_rtsp::USER, fake_rtsp::PASS),
            Arc::new(Shared::default()),
        );
        sink.wait_until(|s| s.media().len() >= 4).await;
        handle.stop().await;
        let media = sink.media();
        assert_eq!(media[0][0], KIND_CONFIG);
        let (key, seq, _) = frame_fields(&media[1]);
        assert!(key, "the first frame after CONFIG is the keyframe");
        assert_eq!(seq, 0);
        // The leading P-slice (0x41 0x9a 0x7f) was held back.
        for msg in &media[1..] {
            assert!(
                !msg.ends_with(&[0x41, 0x9a, 0x7f]),
                "held-back delta leaked"
            );
        }
    }

    #[test]
    fn the_gate_holds_deltas_until_a_keyframe_and_drops_oversized_units() {
        let mut seen = false;
        assert!(
            !admit_unit(&mut seen, false, 10),
            "delta before any keyframe"
        );
        assert!(admit_unit(&mut seen, true, 10));
        assert!(
            admit_unit(&mut seen, false, 10),
            "deltas flow after a keyframe"
        );
        // An oversized delta is dropped and re-arms the wait for a keyframe.
        assert!(!admit_unit(&mut seen, false, MAX_AU_BYTES + 1));
        assert!(!seen);
        assert!(
            !admit_unit(&mut seen, false, 10),
            "waiting for a keyframe again"
        );
        // An oversized keyframe is dropped too, and does not count as seen.
        assert!(!admit_unit(&mut seen, true, MAX_AU_BYTES + 1));
        assert!(!seen);
        // Exactly the cap is fine.
        assert!(admit_unit(&mut seen, true, MAX_AU_BYTES));
        assert!(admit_unit(&mut seen, false, 10));
    }

    #[tokio::test]
    async fn a_save_during_the_attempt_is_not_locked_out_by_the_old_logins_401() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let sink = VecSink::default();
        let shared = Arc::new(Shared::default());
        // The loader runs after the worker read the generation; the "save" lands right after it,
        // i.e. while DESCRIBE with the old login is in flight.
        let config = config_for(&fake.url(), fake_rtsp::USER, "old_pw");
        let bumper = Arc::clone(&shared);
        let load: LoadConfig = Arc::new(move || {
            bumper.bump_generation();
            Ok(Some(config.clone()))
        });
        let handle = WorkerHandle::spawn(
            "studio".into(),
            "w1".into(),
            sink.clone(),
            load,
            Arc::clone(&shared),
            fast(),
        );
        sink.wait_until(|s| s.states().contains(&StreamState::AuthFailed))
            .await;
        tokio::time::timeout(Duration::from_millis(500), handle.join)
            .await
            .expect("worker stops after 401")
            .unwrap();
        assert_eq!(shared.generation(), 1);
        assert!(!shared.auth_locked(), "the newer save must stay usable");
    }

    #[tokio::test]
    async fn a_missing_path_is_tried_once_then_parked_until_a_save() {
        let fake = FakeRtsp::start(FakeOptions {
            not_found: true,
            ..FakeOptions::default()
        })
        .await;
        let sink = VecSink::default();
        let shared = Arc::new(Shared::default());
        let handle = start(
            sink.clone(),
            config_for(&fake.url(), fake_rtsp::USER, fake_rtsp::PASS),
            Arc::clone(&shared),
        );
        let retrying = |s: &VecSink| {
            s.snapshot()
                .into_iter()
                .filter_map(|m| match m {
                    Msg::Status(e) if e.state == StreamState::Retrying => Some(e),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        sink.wait_until(|s| !retrying(s).is_empty()).await;
        // Far longer than the 50 ms retry delay: a polling worker would have retried many times.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(fake.accepts(), 1, "exactly one attempt, then idle");
        let events = retrying(&sink);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].error, Some(CameraErrorKind::NotFound));
        assert_eq!(events[0].retry_in_ms, None, "parked, not a timed retry");

        shared.bump_generation(); // the owner saved a new path
        sink.wait_until(|s| retrying(s).len() >= 2).await;
        assert_eq!(fake.accepts(), 2, "a save re-arms exactly one new attempt");
        handle.stop().await;
    }
}
