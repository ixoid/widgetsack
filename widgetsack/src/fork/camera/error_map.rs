//! Maps a failed RTSP step to a `CameraErrorKind` by PHASE and STATUS CODE only. retina's error
//! text carries connection context (addresses) and must never be inspected, logged or forwarded.

use super::types::CameraErrorKind;

/// Which step of the RTSP session failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    #[allow(
        dead_code,
        reason = "retina's describe() connects and describes in one call; kept for a future transport"
    )]
    Connect,
    Describe,
    Setup,
    Play,
    Stream,
}

impl Phase {
    /// Stable label for logs (`{kind, phase}` is all the worker may log).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::Describe => "describe",
            Self::Setup => "setup",
            Self::Play => "play",
            Self::Stream => "stream",
        }
    }
}

/// `status_code` is the RTSP status of a refusal if the server sent one; `timed_out` is our own
/// per-step timeout firing.
pub fn map(phase: Phase, status_code: Option<u16>, timed_out: bool) -> CameraErrorKind {
    // A broken stream is a lost stream whatever the reason; the worker decides about retrying.
    if phase == Phase::Stream {
        return CameraErrorKind::StreamLost;
    }
    match status_code {
        Some(401 | 403) => CameraErrorKind::AuthFailed,
        Some(404) => CameraErrorKind::NotFound,
        Some(_) => CameraErrorKind::Protocol,
        None if timed_out => CameraErrorKind::Timeout,
        None => match phase {
            Phase::Connect | Phase::Describe => CameraErrorKind::Unreachable,
            Phase::Setup | Phase::Play => CameraErrorKind::Protocol,
            Phase::Stream => CameraErrorKind::StreamLost,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use CameraErrorKind::*;

    #[test]
    fn maps_by_phase_and_status() {
        let table: &[(Phase, Option<u16>, bool, CameraErrorKind)] = &[
            (Phase::Describe, Some(401), false, AuthFailed),
            (Phase::Describe, Some(403), false, AuthFailed),
            (Phase::Setup, Some(401), false, AuthFailed),
            (Phase::Describe, Some(404), false, NotFound),
            (Phase::Play, Some(404), false, NotFound),
            (Phase::Describe, Some(500), false, Protocol),
            (Phase::Setup, Some(461), false, Protocol),
            (Phase::Connect, None, true, Timeout),
            (Phase::Describe, None, true, Timeout),
            (Phase::Play, None, true, Timeout),
            (Phase::Connect, None, false, Unreachable),
            (Phase::Describe, None, false, Unreachable),
            (Phase::Setup, None, false, Protocol),
            (Phase::Play, None, false, Protocol),
            (Phase::Stream, None, false, StreamLost),
            (Phase::Stream, None, true, StreamLost),
            (Phase::Stream, Some(401), false, StreamLost),
        ];
        for (phase, status, timed_out, want) in table {
            assert_eq!(
                map(*phase, *status, *timed_out),
                *want,
                "{} {status:?} timed_out={timed_out}",
                phase.as_str()
            );
        }
    }

    #[test]
    fn phase_labels_are_stable() {
        assert_eq!(Phase::Connect.as_str(), "connect");
        assert_eq!(Phase::Stream.as_str(), "stream");
    }
}
