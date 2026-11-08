//! Camera config: parsing and validating the stream address, the write-only login/password and their
//! merge rules, persistence through `secure_config` (DPAPI) and the secret-free status view.
//!
//! Invariants: the stored `url` never carries userinfo, query or fragment; the password is a
//! `Secret` (prints `***`); every error is a fixed string that never echoes the input.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use super::types::{CameraStatus, SaveResult, StreamState};

const DEFAULT_PORT: u16 = 554;
const MAX_URL_LEN: usize = 512;
const MAX_HOST_LEN: usize = 253;
/// Longest path including the leading `/`.
const MAX_PATH_LEN: usize = 128;
const MAX_CRED_LEN: usize = 128;

const ERR_ADDRESS: &str = "stream address must be rtsp://host[:port]/path";
const ERR_USERINFO: &str = "stream address must not contain a login or password";
const ERR_QUERY: &str = "stream address must not contain a query or fragment";
const ERR_AMBIGUOUS: &str = "use the separate login and password fields";
const ERR_CREDENTIALS: &str = "login and password must be at most 128 bytes without control characters, and a password needs a login";

/// A password. `Debug` and `Display` print `***`. `Serialize` exists ONLY so `CameraConfig` can be
/// written to the DPAPI-encrypted file; no webview-facing type contains a `Secret`.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The raw value. Call only where it is handed to the RTSP client or compared.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}

impl std::fmt::Display for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}

/// The saved config (`plugins/camera.json`, DPAPI-encrypted).
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CameraConfig {
    /// `rtsp://host[:port]/path`, canonical, no userinfo.
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: Secret,
}

impl std::fmt::Debug for CameraConfig {
    /// The login is a credential too, so only its presence is printed.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CameraConfig")
            .field("url", &self.url)
            .field("username_set", &!self.username.is_empty())
            .field("password", &self.password)
            .finish()
    }
}

/// Input of `save_camera_config`. No `Debug` on purpose: it carries raw secrets.
pub struct SaveInput {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub clear_credentials: bool,
}

/// An address split into its credential-free URL and any pasted `user:pass@`.
#[derive(PartialEq, Eq)]
pub struct Split {
    pub bare_url: String,
    pub userinfo: Option<(String, String)>,
}

fn percent_decode(text: &str) -> Result<String, ()> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(());
            }
            let hi = (bytes[i + 1] as char).to_digit(16).ok_or(())?;
            let lo = (bytes[i + 2] as char).to_digit(16).ok_or(())?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

/// Moves a pasted `user:pass@` out of the address. Anything ambiguous is an error: a password is
/// never truncated or guessed (more than one `@`, a stray `:`, a bad `%` escape, non-UTF-8).
pub fn split_url(input: &str) -> Result<Split, String> {
    let Some((scheme, rest)) = input.split_once("://") else {
        return Ok(Split {
            bare_url: input.to_string(),
            userinfo: None,
        });
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    // An `@` after the authority means the password held a `/`, `?` or `#` and the real host is
    // further on; guessing would truncate the password.
    if tail.contains('@') || authority.matches('@').count() > 1 {
        return Err(ERR_AMBIGUOUS.into());
    }
    let Some((userinfo, host_port)) = authority.split_once('@') else {
        return Ok(Split {
            bare_url: input.to_string(),
            userinfo: None,
        });
    };
    if userinfo.matches(':').count() > 1 {
        return Err(ERR_AMBIGUOUS.into());
    }
    let (user, pass) = userinfo.split_once(':').unwrap_or((userinfo, ""));
    let user = percent_decode(user).map_err(|_| ERR_AMBIGUOUS.to_string())?;
    let pass = percent_decode(pass).map_err(|_| ERR_AMBIGUOUS.to_string())?;
    let bare_url = format!("{scheme}://{host_port}{tail}");
    let userinfo = (!user.is_empty() || !pass.is_empty()).then_some((user, pass));
    Ok(Split { bare_url, userinfo })
}

/// A validated, credential-free stream address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Address {
    /// Lower-cased; IPv6 keeps its brackets.
    pub host: String,
    /// `None` when the address omitted it (RTSP default applies).
    pub port: Option<u16>,
    /// Empty or `/...`.
    pub path: String,
}

impl Address {
    pub fn effective_port(&self) -> u16 {
        self.port.unwrap_or(DEFAULT_PORT)
    }

    pub fn canonical(&self) -> String {
        match self.port {
            Some(port) => format!("rtsp://{}:{port}{}", self.host, self.path),
            None => format!("rtsp://{}{}", self.host, self.path),
        }
    }
}

fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > MAX_HOST_LEN {
        return false;
    }
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return inner.contains(':')
            && inner
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.');
    }
    host.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn parse_port(text: &str) -> Option<u16> {
    if text.is_empty() || text.len() > 5 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u16>().ok().filter(|p| *p != 0)
}

fn valid_path(path: &str) -> bool {
    path.len() <= MAX_PATH_LEN
        && !path.contains("..")
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'/' | b'-'))
}

/// Validates a credential-free address (run `split_url` first). `rtsp://` only; no userinfo, query
/// or fragment, so a secret can never sit in the stored URL.
pub fn validate_address(url: &str) -> Result<Address, String> {
    if url.len() > MAX_URL_LEN {
        return Err(ERR_ADDRESS.into());
    }
    let (scheme, rest) = url.split_once("://").ok_or(ERR_ADDRESS)?;
    if !scheme.eq_ignore_ascii_case("rtsp") {
        return Err(ERR_ADDRESS.into());
    }
    if rest.contains('@') {
        return Err(ERR_USERINFO.into());
    }
    if rest.contains(['?', '#']) {
        return Err(ERR_QUERY.into());
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    let (host, port_text) = if authority.starts_with('[') {
        let end = authority.find(']').ok_or(ERR_ADDRESS)?;
        let (host, after) = authority.split_at(end + 1);
        match after.strip_prefix(':') {
            Some(port) => (host, Some(port)),
            None if after.is_empty() => (host, None),
            None => return Err(ERR_ADDRESS.into()),
        }
    } else {
        match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    if !valid_host(host) {
        return Err(ERR_ADDRESS.into());
    }
    let port = match port_text {
        Some(text) => Some(parse_port(text).ok_or(ERR_ADDRESS)?),
        None => None,
    };
    if !valid_path(path) {
        return Err(ERR_ADDRESS.into());
    }
    Ok(Address {
        host: host.to_ascii_lowercase(),
        port,
        path: path.to_string(),
    })
}

fn validate_credentials(username: &str, password: &Secret) -> Result<(), String> {
    let too_long = username.len() > MAX_CRED_LEN || password.expose().len() > MAX_CRED_LEN;
    let control =
        username.chars().any(char::is_control) || password.expose().chars().any(char::is_control);
    if too_long || control || (username.is_empty() && !password.is_empty()) {
        return Err(ERR_CREDENTIALS.into());
    }
    Ok(())
}

/// Merges a save request into the stored config.
///
/// - A blank login/password keeps the stored one (write-only fields); a non-blank explicit field
///   wins over a pasted `user:pass@`.
/// - `clear_credentials` wipes both and discards anything supplied alongside it.
/// - A changed host or port without a new password drops the stored login, so old credentials are
///   never sent to a new host.
pub fn merge(
    previous: Option<&CameraConfig>,
    input: SaveInput,
) -> Result<(CameraConfig, SaveResult), String> {
    let split = split_url(&input.url)?;
    let address = validate_address(&split.bare_url)?;

    let explicit_user = input
        .username
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(str::to_string);
    let explicit_pass = input.password.filter(|p| !p.is_empty());
    let (pasted_user, pasted_pass) = match split.userinfo {
        Some((user, pass)) => (
            Some(user).filter(|u| !u.is_empty()),
            Some(pass).filter(|p| !p.is_empty()),
        ),
        None => (None, None),
    };
    let mut result = SaveResult::default();

    if input.clear_credentials {
        let config = CameraConfig {
            url: address.canonical(),
            username: String::new(),
            password: Secret::default(),
        };
        return Ok((config, result));
    }

    let new_user = explicit_user.clone().or(pasted_user.clone());
    let new_pass = explicit_pass.clone().or(pasted_pass.clone());
    result.credentials_moved = (pasted_user.is_some() && explicit_user.is_none())
        || (pasted_pass.is_some() && explicit_pass.is_none());

    let mut kept_user = previous.map(|p| p.username.clone()).unwrap_or_default();
    let mut kept_pass = previous.map(|p| p.password.clone()).unwrap_or_default();
    if let Some(previous) = previous
        && new_pass.is_none()
    {
        let old = validate_address(&previous.url).ok();
        let moved = old.is_none_or(|old| {
            old.host != address.host || old.effective_port() != address.effective_port()
        });
        if moved {
            result.credentials_dropped = !kept_user.is_empty() || !kept_pass.is_empty();
            kept_user.clear();
            kept_pass = Secret::default();
        }
    }

    let username = new_user.unwrap_or(kept_user);
    let password = new_pass.map(Secret::new).unwrap_or(kept_pass);
    validate_credentials(&username, &password)?;
    let config = CameraConfig {
        url: address.canonical(),
        username,
        password,
    };
    Ok((config, result))
}

/// The secret-free view of a saved config. An unparsable stored URL reads as not configured.
pub fn to_status(config: Option<&CameraConfig>) -> CameraStatus {
    let parsed = config.and_then(|c| validate_address(&c.url).ok().map(|a| (c, a)));
    let Some((config, address)) = parsed else {
        return CameraStatus {
            configured: false,
            host: String::new(),
            port: DEFAULT_PORT,
            path: String::new(),
            has_username: false,
            has_password: false,
            credentials_set: false,
            codec: None,
            width: None,
            height: None,
            state: StreamState::NotConfigured,
            auth_locked_until_ms: None,
        };
    };
    let has_username = !config.username.is_empty();
    let has_password = !config.password.is_empty();
    CameraStatus {
        configured: true,
        port: address.effective_port(),
        host: address.host,
        path: address.path,
        has_username,
        has_password,
        credentials_set: has_username && has_password,
        codec: None,
        width: None,
        height: None,
        state: StreamState::Idle,
        auth_locked_until_ms: None,
    }
}

// ---- persistence ----

pub fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = crate::file_io::config_root(app)?;
    Ok(dir.join("plugins").join("camera.json"))
}

/// Reads the encrypted config. Errors are fixed strings: a serde or DPAPI message must not leak
/// stored values into the webview.
pub fn load_from(path: &Path) -> Result<Option<CameraConfig>, String> {
    let text = crate::secure_config::read(path).map_err(|_| "camera config could not be read")?;
    text.map(|txt| serde_json::from_str(&txt).map_err(|_| "camera config is corrupt".to_string()))
        .transpose()
}

pub fn save_to(path: &Path, config: &CameraConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "camera config folder is not writable")?;
    }
    let text = serde_json::to_string(config).map_err(|_| "camera config could not be encoded")?;
    crate::secure_config::write(path, &text).map_err(|_| "camera config could not be saved".into())
}

/// Read, merge and write under the caller's save lock. An unreadable previous file is treated as
/// absent, so a corrupt config can always be repaired by saving again.
pub fn save_input(path: &Path, input: SaveInput) -> Result<SaveResult, String> {
    let previous = load_from(path).ok().flatten();
    let (config, result) = merge(previous.as_ref(), input)?;
    save_to(path, &config)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "test_user";
    const PASS: &str = "test_pw_x";

    fn split_ok(input: &str) -> Split {
        split_url(input).unwrap_or_else(|_| panic!("split should succeed"))
    }

    #[test]
    fn split_moves_userinfo_and_percent_decodes() {
        let s = split_ok("rtsp://test_user:p%40ss%3Aw@192.168.0.5:8554/ch2");
        assert_eq!(s.bare_url, "rtsp://192.168.0.5:8554/ch2");
        assert_eq!(s.userinfo, Some(("test_user".into(), "p@ss:w".into())));
    }

    #[test]
    fn split_passes_through_addresses_without_userinfo() {
        let s = split_ok("rtsp://cam.local/ch2");
        assert_eq!(s.bare_url, "rtsp://cam.local/ch2");
        assert!(s.userinfo.is_none());
        // No scheme: left for `validate_address` to reject.
        assert_eq!(split_ok("not a url").bare_url, "not a url");
    }

    #[test]
    fn split_login_only_and_empty_userinfo() {
        let s = split_ok("rtsp://admin@host/x");
        assert_eq!(s.userinfo, Some(("admin".into(), String::new())));
        assert!(split_ok("rtsp://@host/x").userinfo.is_none());
        assert_eq!(split_ok("rtsp://@host/x").bare_url, "rtsp://host/x");
    }

    #[test]
    fn split_rejects_every_ambiguous_form() {
        for bad in [
            "rtsp://u:p@ss@host/x",    // two @ in the authority
            "rtsp://u:pa:ss@host/x",   // stray colon
            "rtsp://u:p%zz@host/x",    // bad escape
            "rtsp://u:p%4@host/x",     // truncated escape
            "rtsp://u:p%@host/x",      // lone percent
            "rtsp://u:%ff%fe@host/x",  // not UTF-8
            "rtsp://u:pa/ss@host/x",   // password held a slash
            "rtsp://u:pa?ss@host/x",   // password held a question mark
            "rtsp://u:pa#ss@host/x",   // password held a hash
            "rtsp://host/x?token=a@b", // @ in the query
        ] {
            assert_eq!(
                split_url(bad).err().as_deref(),
                Some(ERR_AMBIGUOUS),
                "case {}",
                bad.len()
            );
        }
    }

    #[test]
    fn validate_accepts_good_addresses() {
        let a = validate_address("RTSP://Cam-1.local:8554/ch2/main_0.x~").unwrap();
        assert_eq!(a.host, "cam-1.local");
        assert_eq!(a.port, Some(8554));
        assert_eq!(a.path, "/ch2/main_0.x~");
        assert_eq!(a.canonical(), "rtsp://cam-1.local:8554/ch2/main_0.x~");

        let a = validate_address("rtsp://192.168.0.5/ch2").unwrap();
        assert_eq!((a.port, a.effective_port()), (None, 554));
        assert_eq!(a.canonical(), "rtsp://192.168.0.5/ch2");

        let a = validate_address("rtsp://host").unwrap();
        assert_eq!(a.path, "");
        let a = validate_address("rtsp://[fe80::1]:554/x").unwrap();
        assert_eq!(a.host, "[fe80::1]");
        assert_eq!(validate_address("rtsp://[::1]/x").unwrap().port, None);
        assert_eq!(validate_address("rtsp://h:1/").unwrap().port, Some(1));
        assert_eq!(
            validate_address("rtsp://h:65535/").unwrap().port,
            Some(65535)
        );
    }

    #[test]
    fn validate_rejects_bad_addresses() {
        let long_host = format!("rtsp://{}/x", "a".repeat(254));
        let long_path = format!("rtsp://h/{}", "a".repeat(128));
        let long_url = format!("rtsp://h/{}", "a".repeat(600));
        let cases: Vec<(&str, &str)> = vec![
            ("rtsps://h/x", ERR_ADDRESS),
            ("http://h/x", ERR_ADDRESS),
            ("h/x", ERR_ADDRESS),
            ("rtsp://", ERR_ADDRESS),
            ("rtsp:///x", ERR_ADDRESS),
            ("rtsp://ho st/x", ERR_ADDRESS),
            ("rtsp://h$st/x", ERR_ADDRESS),
            ("rtsp://h:0/x", ERR_ADDRESS),
            ("rtsp://h:65536/x", ERR_ADDRESS),
            ("rtsp://h:/x", ERR_ADDRESS),
            ("rtsp://h:+80/x", ERR_ADDRESS),
            ("rtsp://h:80:81/x", ERR_ADDRESS),
            ("rtsp://[fe80::1/x", ERR_ADDRESS),
            ("rtsp://[fe80::1]x/x", ERR_ADDRESS),
            ("rtsp://[abc]/x", ERR_ADDRESS),
            ("rtsp://h/a/../b", ERR_ADDRESS),
            ("rtsp://h/a b", ERR_ADDRESS),
            ("rtsp://h/a%20b", ERR_ADDRESS),
            ("rtsp://h/a\\b", ERR_ADDRESS),
            ("rtsp://h/ch2?user=a&pass=b", ERR_QUERY),
            ("rtsp://h/ch2#frag", ERR_QUERY),
            ("rtsp://u:p@h/ch2", ERR_USERINFO),
            (long_host.as_str(), ERR_ADDRESS),
            (long_path.as_str(), ERR_ADDRESS),
            (long_url.as_str(), ERR_ADDRESS),
        ];
        for (input, want) in cases {
            assert_eq!(
                validate_address(input).err().as_deref(),
                Some(want),
                "input length {}",
                input.len()
            );
        }
    }

    #[test]
    fn secret_prints_stars_everywhere() {
        let secret = Secret::new(PASS);
        assert_eq!(format!("{secret:?}"), "***");
        assert_eq!(format!("{secret}"), "***");
        assert_eq!(secret.expose(), PASS);
    }

    fn input(url: &str) -> SaveInput {
        SaveInput {
            url: url.into(),
            username: None,
            password: None,
            clear_credentials: false,
        }
    }

    fn with_creds(url: &str, user: &str, pass: &str) -> CameraConfig {
        CameraConfig {
            url: url.into(),
            username: user.into(),
            password: Secret::new(pass),
        }
    }

    #[test]
    fn first_save_stores_explicit_credentials() {
        let mut i = input("rtsp://10.0.0.2:8554/ch2");
        i.username = Some(" test_user ".into());
        i.password = Some(PASS.into());
        let (cfg, res) = merge(None, i).unwrap();
        assert_eq!(cfg, with_creds("rtsp://10.0.0.2:8554/ch2", USER, PASS));
        assert_eq!(res, SaveResult::default());
    }

    #[test]
    fn blank_fields_keep_the_stored_credentials() {
        let prev = with_creds("rtsp://10.0.0.2:8554/ch2", USER, PASS);
        let mut i = input("rtsp://10.0.0.2:8554/ch3");
        i.username = Some("   ".into());
        i.password = Some(String::new());
        let (cfg, res) = merge(Some(&prev), i).unwrap();
        assert_eq!(cfg, with_creds("rtsp://10.0.0.2:8554/ch3", USER, PASS));
        assert_eq!(res, SaveResult::default());
    }

    #[test]
    fn same_host_with_default_port_spelled_out_keeps_credentials() {
        let prev = with_creds("rtsp://10.0.0.2/ch2", USER, PASS);
        let (cfg, res) = merge(Some(&prev), input("rtsp://10.0.0.2:554/ch2")).unwrap();
        assert_eq!(cfg.username, USER);
        assert!(!res.credentials_dropped);
    }

    #[test]
    fn clear_credentials_wipes_both_and_ignores_supplied_values() {
        let prev = with_creds("rtsp://10.0.0.2:8554/ch2", USER, PASS);
        let mut i = input("rtsp://u:p@10.0.0.2:8554/ch2");
        i.password = Some("new".into());
        i.clear_credentials = true;
        let (cfg, res) = merge(Some(&prev), i).unwrap();
        assert_eq!(cfg, with_creds("rtsp://10.0.0.2:8554/ch2", "", ""));
        assert_eq!(res, SaveResult::default());
    }

    #[test]
    fn host_or_port_change_without_password_drops_credentials() {
        let prev = with_creds("rtsp://10.0.0.2:8554/ch2", USER, PASS);
        for url in ["rtsp://10.0.0.9:8554/ch2", "rtsp://10.0.0.2:554/ch2"] {
            let (cfg, res) = merge(Some(&prev), input(url)).unwrap();
            assert_eq!(cfg.username, "", "{url}");
            assert!(cfg.password.is_empty(), "{url}");
            assert!(res.credentials_dropped, "{url}");
        }
        // Nothing stored, nothing to report as dropped.
        let bare = with_creds("rtsp://10.0.0.2:8554/ch2", "", "");
        let (_, res) = merge(Some(&bare), input("rtsp://10.0.0.9/ch2")).unwrap();
        assert!(!res.credentials_dropped);
    }

    #[test]
    fn host_change_with_a_new_password_keeps_the_login() {
        let prev = with_creds("rtsp://10.0.0.2:8554/ch2", USER, PASS);
        let mut i = input("rtsp://10.0.0.9:8554/ch2");
        i.password = Some("fresh".into());
        let (cfg, res) = merge(Some(&prev), i).unwrap();
        assert_eq!(cfg.username, USER);
        assert_eq!(cfg.password.expose(), "fresh");
        assert!(!res.credentials_dropped);
    }

    #[test]
    fn pasted_userinfo_moves_into_credentials() {
        let (cfg, res) = merge(None, input("rtsp://test_user:test_pw_x@10.0.0.2/ch2")).unwrap();
        assert_eq!(cfg, with_creds("rtsp://10.0.0.2/ch2", USER, PASS));
        assert!(res.credentials_moved);
        assert!(!cfg.url.contains('@'));
    }

    #[test]
    fn explicit_fields_win_over_pasted_userinfo() {
        let mut i = input("rtsp://pasted:pasted_pw@10.0.0.2/ch2");
        i.username = Some(USER.into());
        i.password = Some(PASS.into());
        let (cfg, res) = merge(None, i).unwrap();
        assert_eq!(cfg, with_creds("rtsp://10.0.0.2/ch2", USER, PASS));
        assert!(!res.credentials_moved, "nothing pasted was stored");
    }

    #[test]
    fn pasted_password_on_a_new_host_counts_as_a_new_password() {
        let prev = with_creds("rtsp://10.0.0.2/ch2", USER, PASS);
        let (cfg, res) = merge(Some(&prev), input("rtsp://u2:pw2@10.0.0.9/ch2")).unwrap();
        assert_eq!(cfg, with_creds("rtsp://10.0.0.9/ch2", "u2", "pw2"));
        assert!(res.credentials_moved && !res.credentials_dropped);
    }

    #[test]
    fn invalid_input_is_refused() {
        assert!(merge(None, input("http://h/x")).is_err());
        let mut i = input("rtsp://h/x");
        i.password = Some(PASS.into());
        assert_eq!(merge(None, i).err().as_deref(), Some(ERR_CREDENTIALS));
        let mut i = input("rtsp://h/x");
        i.username = Some("a".repeat(129));
        assert_eq!(merge(None, i).err().as_deref(), Some(ERR_CREDENTIALS));
        let mut i = input("rtsp://h/x");
        i.username = Some("a\u{7}b".into());
        assert!(merge(None, i).is_err());
        let mut i = input("rtsp://h/x");
        i.username = Some("a".into());
        i.password = Some("p\nq".into());
        assert!(merge(None, i).is_err());
    }

    #[test]
    fn status_reports_address_and_flags_only() {
        let none = to_status(None);
        assert!(!none.configured);
        assert_eq!(none.state, StreamState::NotConfigured);

        let cfg = with_creds("rtsp://192.168.0.5:8554/ch2", USER, PASS);
        let s = to_status(Some(&cfg));
        assert!(s.configured && s.credentials_set && s.has_username && s.has_password);
        assert_eq!(
            (s.host.as_str(), s.port, s.path.as_str()),
            ("192.168.0.5", 8554, "/ch2")
        );
        assert_eq!(s.state, StreamState::Idle);

        let no_pass = with_creds("rtsp://cam/x", USER, "");
        let s = to_status(Some(&no_pass));
        assert!(s.has_username && !s.has_password && !s.credentials_set);
        assert_eq!(s.port, 554);

        // A corrupt stored URL must not surface half-parsed pieces.
        let broken = with_creds("http://nope", USER, PASS);
        assert!(!to_status(Some(&broken)).configured);
    }

    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "widgetsack-camera-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn save_and_load_round_trip_through_secure_config() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("plugins").join("camera.json");
        assert_eq!(load_from(&path).unwrap(), None);

        let mut i = input("rtsp://10.0.0.2:8554/ch2");
        i.username = Some(USER.into());
        i.password = Some(PASS.into());
        assert_eq!(save_input(&path, i).unwrap(), SaveResult::default());

        let raw = std::fs::read_to_string(&path).unwrap();
        #[cfg(windows)]
        {
            assert!(
                raw.starts_with("widgetsack-dpapi-v1:"),
                "file must be encrypted"
            );
            assert!(!raw.contains(PASS) && !raw.contains(USER));
        }
        assert!(!raw.contains("rtsp://test_user"));
        let loaded = load_from(&path).unwrap().unwrap();
        assert_eq!(loaded, with_creds("rtsp://10.0.0.2:8554/ch2", USER, PASS));

        // A second save with blank secrets keeps them; a host change drops them.
        let res = save_input(&path, input("rtsp://10.0.0.2:8554/ch3")).unwrap();
        assert_eq!(res, SaveResult::default());
        assert_eq!(load_from(&path).unwrap().unwrap().password.expose(), PASS);
        let res = save_input(&path, input("rtsp://10.0.0.7:8554/ch3")).unwrap();
        assert!(res.credentials_dropped);
        assert!(load_from(&path).unwrap().unwrap().password.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_reports_a_fixed_error_and_can_be_repaired() {
        let dir = temp_dir("corrupt");
        let path = dir.join("plugins").join("camera.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{\"url\": 5, \"secret_marker_zz\"").unwrap();
        let err = load_from(&path).unwrap_err();
        assert_eq!(err, "camera config is corrupt");
        assert!(!err.contains("secret_marker_zz"));
        assert!(save_input(&path, input("rtsp://h/x")).is_ok());
        assert!(load_from(&path).unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
