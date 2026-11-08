//! Bridge shapes for the camera widget (serde camelCase; mirrored by `camera-types.ts` on the
//! client — change both sides in one commit). Nothing here may hold a `config::Secret`, a username
//! value or a full URL: the webview learns host/port/path and booleans only.

use serde::Serialize;

/// Coarse failure class shown to the user. Derived from phase + status code, never from error text,
/// so no URL, host or credential can ride along.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CameraErrorKind {
    Unreachable,
    AuthFailed,
    Timeout,
    NotFound,
    Protocol,
    UnsupportedCodec,
    StreamLost,
}

impl std::fmt::Display for CameraErrorKind {
    /// Fixed human-readable text, safe to log and to return from a command.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unreachable => "camera is not reachable",
            Self::AuthFailed => "camera rejected the login or password",
            Self::Timeout => "camera did not answer in time",
            Self::NotFound => "camera has no stream at this path",
            Self::Protocol => "camera sent an unexpected RTSP answer",
            Self::UnsupportedCodec => "camera video codec is not supported",
            Self::StreamLost => "camera stream was interrupted",
        })
    }
}

/// Connection state of the (single) camera stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamState {
    NotConfigured,
    Idle,
    Connecting,
    Live,
    Retrying,
    AuthFailed,
    UnsupportedCodec,
}

/// What the webview may know about the saved config.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraStatus {
    pub configured: bool,
    pub host: String,
    pub port: u16,
    pub path: String,
    pub has_username: bool,
    pub has_password: bool,
    /// Both login and password stored.
    pub credentials_set: bool,
    pub codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub state: StreamState,
    /// Epoch ms until which probes/attempts are refused after a 401/403.
    pub auth_locked_until_ms: Option<u64>,
}

/// Outcome of `camera_probe` (a DESCRIBE-only check of the saved config).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    pub kind: Option<CameraErrorKind>,
    pub codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
}

/// What a save did beyond writing, so the pane can explain it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    /// `user:pass@` pasted into the address was moved into secure storage.
    pub credentials_moved: bool,
    /// Host or port changed without a new password, so the stored login was dropped.
    pub credentials_dropped: bool,
}

/// Json status message sent on the stream channel (`kind` is always `"status"`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub kind: &'static str,
    pub state: StreamState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CameraErrorKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_in_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
}

impl StatusEvent {
    pub fn new(state: StreamState) -> Self {
        Self {
            kind: "status",
            state,
            error: None,
            retry_in_ms: None,
            codec: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fork::camera::config::{CameraConfig, SaveInput, merge, to_status};

    const USER: &str = "test_user";
    const PASS: &str = "test_pw_x";

    fn sentinel_config() -> CameraConfig {
        let input = SaveInput {
            url: "rtsp://192.168.0.5:8554/ch2".into(),
            username: Some(USER.into()),
            password: Some(PASS.into()),
            clear_credentials: false,
        };
        merge(None, input).expect("valid input").0
    }

    fn assert_clean(label: &str, text: &str) {
        assert!(!text.contains(USER), "{label} leaks the login");
        assert!(!text.contains(PASS), "{label} leaks the password");
    }

    #[test]
    fn sentinel_credentials_never_appear_in_any_webview_or_debug_output() {
        let cfg = sentinel_config();
        // The sentinels really are stored (otherwise the test proves nothing).
        assert_eq!(cfg.username, USER);
        assert_eq!(cfg.password.expose(), PASS);

        let status = to_status(Some(&cfg));
        assert!(status.credentials_set);
        assert_clean("status json", &serde_json::to_string(&status).unwrap());
        assert_clean("status debug", &format!("{status:?}"));

        let probe = ProbeResult {
            ok: false,
            kind: Some(CameraErrorKind::AuthFailed),
            ..ProbeResult::default()
        };
        assert_clean("probe json", &serde_json::to_string(&probe).unwrap());
        let saved = SaveResult {
            credentials_moved: true,
            credentials_dropped: true,
        };
        assert_clean("save json", &serde_json::to_string(&saved).unwrap());

        let mut event = StatusEvent::new(StreamState::Retrying);
        event.error = Some(CameraErrorKind::Unreachable);
        event.retry_in_ms = Some(1000);
        assert_clean("event json", &serde_json::to_string(&event).unwrap());

        assert_clean("config debug", &format!("{cfg:?}"));
        assert_clean("config pretty debug", &format!("{cfg:#?}"));
        assert_clean("secret debug", &format!("{:?}", cfg.password));
        assert_clean("secret display", &format!("{}", cfg.password));

        for kind in [
            CameraErrorKind::Unreachable,
            CameraErrorKind::AuthFailed,
            CameraErrorKind::Timeout,
            CameraErrorKind::NotFound,
            CameraErrorKind::Protocol,
            CameraErrorKind::UnsupportedCodec,
            CameraErrorKind::StreamLost,
        ] {
            assert_clean("error display", &kind.to_string());
            assert_clean("error debug", &format!("{kind:?}"));
        }
    }

    #[test]
    fn validation_errors_never_echo_the_input() {
        let bad = format!("rtsp://{USER}:{PASS}@a@b/x");
        let err = crate::fork::camera::config::split_url(&bad)
            .err()
            .expect("ambiguous");
        assert_clean("split error", &err);
        let err =
            crate::fork::camera::config::validate_address(&format!("http://{PASS}/")).unwrap_err();
        assert_clean("validate error", &err);
    }

    #[test]
    fn wire_names_are_camel_case() {
        let json = serde_json::to_value(StatusEvent::new(StreamState::AuthFailed)).unwrap();
        assert_eq!(json["kind"], "status");
        assert_eq!(json["state"], "authFailed");
        assert!(json.get("retryInMs").is_none());
        let json = serde_json::to_value(CameraErrorKind::UnsupportedCodec).unwrap();
        assert_eq!(json, "unsupportedCodec");
    }
}
