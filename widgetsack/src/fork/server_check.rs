//! Server check source (fork stage 1) — "are my servers up?". A PEER to rss.rs / agenda.rs: an
//! app-owned `IntegrationTask` polls the configured targets on their own intervals and forwards the
//! results over the EXISTING `telemetry` event, so the unchanged frontend hub ingests them like any
//! other sensor. Three probe kinds: ICMP echo (the `IcmpSendEcho` helper ping.rs already has), a TCP
//! connect, and an HTTP GET (status and/or body keyword). Per target it emits
//! `srv.<id>.up` (1/0), `srv.<id>.ms`, `srv.<id>.status` (text), `srv.<id>.lastDown` (epoch ms, 0
//! while up); for the card widget one `srv.list` JSON array carrying each target's latest result and
//! its last `HISTORY_LEN` latencies (history is kept here, not in the hub, because the list is one
//! JSON sample — the hub only rings scalars); plus `srv.status` for the Plugins list dot.
//!
//! Demand-gated (default OFF): nothing is probed while no window consumes an `srv.*` sensor. The
//! config holds no secrets (hosts, ports, URLs without credentials — enforced by `validate_target`),
//! so it is plain JSON like `rss.json` (ADR-002). Pure seams (`validate_target`, `TargetRun::apply`,
//! `target_samples`, `list_sample`) are unit-tested without network; the TCP/HTTP probes are tested
//! against a local listener on 127.0.0.1:0, as `service_health.rs` does.

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::sensors::{ActiveSensors, SensorSample, SensorValue, TELEMETRY_EVENT};

/// Poll cadence guardrails (seconds). A LAN host can be probed often; the floor keeps a typo from
/// hammering a VPS.
pub const MIN_INTERVAL_SECS: u64 = 5;
pub const MAX_INTERVAL_SECS: u64 = 3600;
/// Per-probe timeout guardrails (milliseconds).
pub const MIN_TIMEOUT_MS: u64 = 200;
pub const MAX_TIMEOUT_MS: u64 = 30_000;
pub const MAX_TARGETS: usize = 32;
/// Latency samples kept per target for the card's sparkline.
pub const HISTORY_LEN: usize = 20;
/// Body cap for an HTTP keyword probe — a health page is a few KiB; never buffer an unbounded body.
const HTTP_BODY_CAP: usize = 256 * 1024;
const IDLE_RECHECK: Duration = Duration::from_secs(5);
const SENSOR_PREFIX: &str = "srv.";

fn default_interval() -> u64 {
    30
}
fn default_timeout() -> u64 {
    3000
}

/// How a target is probed. Lowercase on the wire and in the config file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckKind {
    Icmp,
    Tcp,
    Http,
}

/// One configured target. The same struct is the config-file row and the bridge shape (camelCase;
/// mirrors `ServerCheckTarget` in `client/src/lib/widgets/fork/server-check/server-check-types.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub name: String,
    pub kind: CheckKind,
    /// icmp / tcp: host name or IPv4 literal.
    #[serde(default)]
    pub host: String,
    /// tcp only.
    #[serde(default)]
    pub port: u16,
    /// http only: `http(s)://host[:port]/path`, no embedded credentials.
    #[serde(default)]
    pub url: String,
    /// http: the exact status that counts as up; `None` = any 2xx/3xx.
    #[serde(default)]
    pub expect_status: Option<u16>,
    /// http: a substring the body must contain (empty = don't read the body).
    #[serde(default)]
    pub expect_keyword: String,
    #[serde(default = "default_interval")]
    pub interval_secs: u64,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}

/// Server-side config (`plugins/server-check.json`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ServerCheckConfig {
    #[serde(default)]
    pub targets: Vec<Target>,
}

/// What the webview learns about the config. Nothing here is secret (see `validate_target`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCheckStatus {
    pub configured: bool,
    pub targets: Vec<Target>,
}

/// Managed state: the running poll task + the latest batch for late-mounting windows.
#[derive(Default)]
pub struct ServerCheckState {
    task: crate::integration_task::IntegrationTask,
    latest: crate::sample_cache::SampleCache,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- pure seams: validation ----

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A bare host: no whitespace, no scheme, no path, no credentials — the probe must not be steerable
/// into a URL-ish string. IPv4 literals and DNS names both pass.
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && !host
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '/' | '@' | ':' | '?' | '#' | '\\'))
}

/// Validate and normalise one target (trim strings, clamp numbers). The error is shown in the
/// settings pane verbatim, so it names the target but never echoes its URL.
pub fn validate_target(t: &Target) -> Result<Target, String> {
    let id = t.id.trim().to_string();
    if !valid_id(&id) {
        return Err("target id must be 1–40 chars of a-z, 0-9 or '-'".into());
    }
    let mut name = t.name.trim().to_string();
    if name.chars().count() > 60 {
        return Err(format!("target «{id}»: name is longer than 60 characters"));
    }
    let host = t.host.trim().to_string();
    let url = t.url.trim().to_string();
    let label = if name.is_empty() {
        id.clone()
    } else {
        name.clone()
    };
    match t.kind {
        CheckKind::Icmp | CheckKind::Tcp => {
            if !valid_host(&host) {
                return Err(format!(
                    "target «{label}»: enter a bare host name or IPv4 address (no scheme, path or port)"
                ));
            }
            if t.kind == CheckKind::Tcp && t.port == 0 {
                return Err(format!("target «{label}»: TCP port must be 1–65535"));
            }
            if name.is_empty() {
                name = host.clone();
            }
        }
        CheckKind::Http => {
            let parsed = reqwest::Url::parse(&url)
                .map_err(|_| format!("target «{label}»: enter a valid http(s):// URL"))?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err(format!(
                    "target «{label}»: use http or https without embedded credentials"
                ));
            }
            if let Some(s) = t.expect_status
                && !(100..=599).contains(&s)
            {
                return Err(format!("target «{label}»: expected status must be 100–599"));
            }
            if t.expect_keyword.trim().chars().count() > 200 {
                return Err(format!(
                    "target «{label}»: keyword is longer than 200 characters"
                ));
            }
            if name.is_empty() {
                name = parsed.host_str().unwrap_or(&id).to_string();
            }
        }
    }
    Ok(Target {
        id,
        name,
        kind: t.kind,
        host: if t.kind == CheckKind::Http {
            String::new()
        } else {
            host
        },
        port: if t.kind == CheckKind::Tcp { t.port } else { 0 },
        url: if t.kind == CheckKind::Http {
            url
        } else {
            String::new()
        },
        expect_status: if t.kind == CheckKind::Http {
            t.expect_status
        } else {
            None
        },
        expect_keyword: if t.kind == CheckKind::Http {
            t.expect_keyword.trim().to_string()
        } else {
            String::new()
        },
        interval_secs: t.interval_secs.clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS),
        timeout_ms: t.timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    })
}

/// Validate a whole target list: each row, the count cap, and id uniqueness.
pub fn validate_targets(targets: &[Target]) -> Result<Vec<Target>, String> {
    if targets.len() > MAX_TARGETS {
        return Err(format!("at most {MAX_TARGETS} targets"));
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(targets.len());
    for t in targets {
        let v = validate_target(t)?;
        if !seen.insert(v.id.clone()) {
            return Err(format!("duplicate target id «{}»", v.id));
        }
        out.push(v);
    }
    Ok(out)
}

// ---- pure seams: results → samples ----

/// One probe's result. `reason` is human-readable and never contains the URL.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Up { ms: f64 },
    Down { reason: String },
}

/// Per-target running state: the latency ring for the sparkline (`None` = a down sample), the last
/// known reachability, and when the current outage began.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TargetRun {
    pub history: VecDeque<Option<f64>>,
    pub up: Option<bool>,
    pub down_since_ms: Option<u64>,
    pub last_reason: String,
}

impl TargetRun {
    /// Fold one outcome in: up→down stamps `down_since_ms`, down→up clears it, the ring is capped.
    pub fn apply(&mut self, outcome: &Outcome, ts_ms: u64) {
        match outcome {
            Outcome::Up { ms } => {
                self.history.push_back(Some(*ms));
                self.up = Some(true);
                self.down_since_ms = None;
                self.last_reason.clear();
            }
            Outcome::Down { reason } => {
                self.history.push_back(None);
                if self.up != Some(false) {
                    self.down_since_ms = Some(ts_ms);
                }
                self.up = Some(false);
                self.last_reason = reason.clone();
            }
        }
        while self.history.len() > HISTORY_LEN {
            self.history.pop_front();
        }
    }
}

/// The per-target scalar/text samples for one outcome (bindable by Text / Gauge / Sparkline).
pub fn target_samples(
    id: &str,
    run: &TargetRun,
    outcome: &Outcome,
    ts_ms: u64,
) -> Vec<SensorSample> {
    let base = format!("{SENSOR_PREFIX}{id}");
    let mut out = Vec::with_capacity(4);
    match outcome {
        Outcome::Up { ms } => {
            out.push(SensorSample::scalar(format!("{base}.up"), ts_ms, 1.0));
            out.push(SensorSample::scalar(format!("{base}.ms"), ts_ms, *ms));
            out.push(SensorSample::text(format!("{base}.status"), ts_ms, "up"));
        }
        Outcome::Down { reason } => {
            out.push(SensorSample::scalar(format!("{base}.up"), ts_ms, 0.0));
            out.push(SensorSample::text(
                format!("{base}.status"),
                ts_ms,
                format!("down: {reason}"),
            ));
        }
    }
    out.push(SensorSample::scalar(
        format!("{base}.lastDown"),
        ts_ms,
        run.down_since_ms.unwrap_or(0) as f64,
    ));
    out
}

/// The `srv.list` JSON sample: every target's latest state for the card widget. Mirrors
/// `ServerCheckRow` on the client. Targets not yet probed appear with `up: null`.
pub fn list_sample(targets: &[Target], runs: &[TargetRun], ts_ms: u64) -> SensorSample {
    let rows: Vec<serde_json::Value> = targets
        .iter()
        .zip(runs)
        .map(|(t, r)| {
            let last_ms = r.history.back().copied().flatten();
            serde_json::json!({
                "id": t.id,
                "name": t.name,
                "kind": t.kind,
                "up": r.up,
                "ms": last_ms,
                "reason": r.last_reason,
                "downSince": r.down_since_ms,
                "history": r.history.iter().copied().collect::<Vec<Option<f64>>>(),
            })
        })
        .collect();
    SensorSample {
        sensor: format!("{SENSOR_PREFIX}list"),
        ts_ms,
        value: SensorValue::Json(serde_json::Value::Array(rows)),
    }
}

// ---- probes (edge; the TCP/HTTP ones are tested against a local listener) ----

#[cfg(target_os = "windows")]
fn ping_blocking(host: &str, timeout_ms: u32) -> Option<f64> {
    crate::ping::icmp_ping(crate::ping::resolve_ipv4(host)?, timeout_ms)
}
#[cfg(not(target_os = "windows"))]
fn ping_blocking(_host: &str, _timeout_ms: u32) -> Option<f64> {
    None
}

async fn probe_icmp(host: String, timeout: Duration) -> Outcome {
    let timeout_ms = timeout.as_millis().min(u32::MAX as u128) as u32;
    match tokio::task::spawn_blocking(move || ping_blocking(&host, timeout_ms)).await {
        Ok(Some(ms)) => Outcome::Up { ms },
        Ok(None) => Outcome::Down {
            reason: "no echo reply".into(),
        },
        Err(_) => Outcome::Down {
            reason: "probe failed".into(),
        },
    }
}

/// A connect error's kind, not its message: std's text can embed the address we dialled.
fn io_reason(err: &std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::ConnectionRefused => "connection refused".into(),
        std::io::ErrorKind::TimedOut => "timed out".into(),
        kind => format!("{kind:?}"),
    }
}

async fn probe_tcp(host: String, port: u16, timeout: Duration) -> Outcome {
    let start = Instant::now();
    match tokio::time::timeout(
        timeout,
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    {
        Ok(Ok(_stream)) => Outcome::Up {
            ms: start.elapsed().as_secs_f64() * 1000.0,
        },
        Ok(Err(err)) => Outcome::Down {
            reason: io_reason(&err),
        },
        Err(_) => Outcome::Down {
            reason: "timed out".into(),
        },
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // A redirect to another host would leave the configured endpoint; report the 3xx instead.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("widgetsack/server-check")
        .build()
        .map_err(|e| e.to_string())
}

/// Whether `status` counts as up: the configured exact status, else anything below 400.
fn status_ok(status: u16, expected: Option<u16>) -> bool {
    match expected {
        Some(want) => status == want,
        None => status < 400,
    }
}

async fn probe_http(
    client: &reqwest::Client,
    url: String,
    expect_status: Option<u16>,
    keyword: String,
    timeout: Duration,
) -> Outcome {
    let start = Instant::now();
    let response = match client.get(&url).timeout(timeout).send().await {
        Ok(r) => r,
        Err(err) => {
            return Outcome::Down {
                reason: crate::http_response::request_error(err),
            };
        }
    };
    let status = response.status().as_u16();
    if !status_ok(status, expect_status) {
        return Outcome::Down {
            reason: format!("HTTP {status}"),
        };
    }
    if !keyword.is_empty() {
        // The body read shares the probe's budget: a server that trickles bytes is "down".
        let remaining = timeout.saturating_sub(start.elapsed());
        let body = match tokio::time::timeout(
            remaining,
            crate::http_response::read_body(response, HTTP_BODY_CAP),
        )
        .await
        {
            Ok(Ok(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
            Ok(Err(err)) => return Outcome::Down { reason: err },
            Err(_) => {
                return Outcome::Down {
                    reason: "timed out reading the body".into(),
                };
            }
        };
        if !body.contains(&keyword) {
            return Outcome::Down {
                reason: "keyword not found".into(),
            };
        }
    }
    Outcome::Up {
        ms: start.elapsed().as_secs_f64() * 1000.0,
    }
}

async fn probe(client: &reqwest::Client, t: &Target) -> Outcome {
    let timeout = Duration::from_millis(t.timeout_ms);
    match t.kind {
        CheckKind::Icmp => probe_icmp(t.host.clone(), timeout).await,
        CheckKind::Tcp => probe_tcp(t.host.clone(), t.port, timeout).await,
        CheckKind::Http => {
            probe_http(
                client,
                t.url.clone(),
                t.expect_status,
                t.expect_keyword.clone(),
                timeout,
            )
            .await
        }
    }
}

// ---- config I/O (server-side) ----

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = crate::file_io::config_root(app)?;
    Ok(dir.join("plugins").join("server-check.json"))
}

pub fn load_config<R: Runtime>(app: &AppHandle<R>) -> Result<Option<ServerCheckConfig>, String> {
    let path = config_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(txt) => serde_json::from_str(&txt)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

// ---- telemetry emission + demand gate ----

fn emit_status<R: Runtime>(app: &AppHandle<R>, status: &str) {
    emit_batch(
        app,
        &[SensorSample::text(
            format!("{SENSOR_PREFIX}status"),
            now_ms(),
            status,
        )],
    );
}

fn emit_batch<R: Runtime>(app: &AppHandle<R>, batch: &[SensorSample]) {
    if let Some(state) = app.try_state::<ServerCheckState>() {
        state.latest.remember(batch);
    }
    let _ = app.emit(TELEMETRY_EVENT, batch);
}

/// Send `window` the cached `srv.*` samples among the ids it just started consuming.
pub fn prime_window<R: Runtime>(window: &tauri::WebviewWindow<R>, added: &[String]) {
    if let Some(state) = window.app_handle().try_state::<ServerCheckState>() {
        crate::sample_cache::prime_window(window, &state.latest, added);
    }
}

/// True while any window consumes an `srv.*` sensor. Default OFF: an all-empty active map must
/// not probe anything.
fn wanted<R: Runtime>(app: &AppHandle<R>) -> bool {
    let active: State<ActiveSensors> = app.state();
    let guard = active.0.lock().unwrap_or_else(|e| e.into_inner());
    if guard.values().all(|ids| ids.is_empty()) {
        return false;
    }
    crate::sensors::any_wanted(&guard, |id| id.starts_with(SENSOR_PREFIX))
}

// ---- poll task ----

/// Probe the configured targets on their intervals, emitting `srv.*` telemetry. Demand-gated.
pub async fn run_server_check<R: Runtime>(app: AppHandle<R>, cfg: ServerCheckConfig) {
    if let Some(state) = app.try_state::<ServerCheckState>() {
        state.latest.clear();
    }
    let targets = match validate_targets(&cfg.targets) {
        Ok(t) => t,
        Err(err) => {
            eprintln!("server-check: invalid config: {err}");
            emit_status(&app, "error");
            return;
        }
    };
    if targets.is_empty() {
        emit_status(&app, "unconfigured");
        return;
    }
    let client = match http_client() {
        Ok(c) => c,
        Err(err) => {
            eprintln!("server-check: client build failed: {err}");
            emit_status(&app, "error");
            return;
        }
    };
    let timings = app.state::<crate::timings::SubsystemTimings>();
    let mut runs: Vec<TargetRun> = vec![TargetRun::default(); targets.len()];
    let mut due_at: Vec<Instant> = vec![Instant::now(); targets.len()];
    let mut idle = true;

    loop {
        if !wanted(&app) {
            idle = true;
            tokio::time::sleep(IDLE_RECHECK).await;
            continue;
        }
        if idle {
            emit_status(&app, "connecting");
            idle = false;
            // Coming back from idle, probe everything now rather than waiting out stale deadlines.
            let now = Instant::now();
            due_at.iter_mut().for_each(|d| *d = now);
        }
        let now = Instant::now();
        let due: Vec<usize> = (0..targets.len()).filter(|&i| due_at[i] <= now).collect();
        if due.is_empty() {
            let next = due_at.iter().min().copied().unwrap_or(now);
            // Cap the nap so the demand gate is re-read even on long intervals.
            tokio::time::sleep(next.saturating_duration_since(now).min(IDLE_RECHECK)).await;
            continue;
        }
        let outcomes =
            futures_util::future::join_all(due.iter().map(|&i| probe(&client, &targets[i]))).await;
        let ts = now_ms();
        let mut batch = Vec::new();
        {
            let _t = timings.start("plugin.server-check");
            for (&i, outcome) in due.iter().zip(&outcomes) {
                runs[i].apply(outcome, ts);
                batch.extend(target_samples(&targets[i].id, &runs[i], outcome, ts));
                due_at[i] = Instant::now() + Duration::from_secs(targets[i].interval_secs);
            }
            batch.push(list_sample(&targets, &runs, ts));
            batch.push(SensorSample::text(
                format!("{SENSOR_PREFIX}status"),
                ts,
                "connected",
            ));
        }
        emit_batch(&app, &batch);
    }
}

// ---- Tauri commands ----

/// Persist `plugins/server-check.json` (creates `plugins/`). Studio-window-guarded like the other
/// plugin configs; every row is validated first so a bad save never reaches disk.
#[tauri::command]
pub async fn save_server_check_config(
    window: tauri::WebviewWindow,
    app: AppHandle,
    targets: Vec<Target>,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("save_server_check_config is only allowed from the studio window".into());
    }
    let targets = validate_targets(&targets)?;
    let path = config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let txt =
        serde_json::to_string_pretty(&ServerCheckConfig { targets }).map_err(|e| e.to_string())?;
    crate::file_io::atomic_write(&path, &txt)
}

#[tauri::command]
pub async fn server_check_config_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<ServerCheckStatus, String> {
    let cfg = tokio::task::spawn_blocking(move || load_config(&app))
        .await
        .map_err(|e| e.to_string())??;
    let targets = cfg.map(|c| c.targets).unwrap_or_default();
    Ok(ServerCheckStatus {
        configured: !targets.is_empty(),
        targets,
    })
}

/// Start the poll task if not already running. Idempotent + demand-gated; `restart` (studio only)
/// swaps in the saved config.
#[tauri::command]
pub async fn server_check_connect<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    app: AppHandle<R>,
    state: State<'_, ServerCheckState>,
    restart: Option<bool>,
) -> Result<(), String> {
    let restart = restart.unwrap_or(false);
    if restart && window.label() != "studio" {
        return Err("integration restart is only allowed from the studio window".into());
    }
    state
        .task
        .start(restart, || {
            let cfg = load_config(&app)?.unwrap_or_default();
            let app_for_task = app.clone();
            Ok(Some(async move {
                run_server_check(app_for_task, cfg).await;
            }))
        })
        .await
}

#[tauri::command]
pub async fn server_check_disconnect(state: State<'_, ServerCheckState>) -> Result<(), String> {
    state.task.stop().await;
    state.latest.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tcp(id: &str, host: &str, port: u16) -> Target {
        Target {
            id: id.into(),
            name: String::new(),
            kind: CheckKind::Tcp,
            host: host.into(),
            port,
            url: String::new(),
            expect_status: None,
            expect_keyword: String::new(),
            interval_secs: 30,
            timeout_ms: 3000,
        }
    }

    fn http(id: &str, url: &str) -> Target {
        Target {
            kind: CheckKind::Http,
            url: url.into(),
            host: String::new(),
            port: 0,
            ..tcp(id, "", 0)
        }
    }

    fn val(s: &SensorSample) -> serde_json::Value {
        serde_json::to_value(s).unwrap()["value"]["value"].clone()
    }

    #[test]
    fn validate_normalises_and_fills_the_name() {
        let mut t = tcp("vps", "  example.org ", 22);
        t.interval_secs = 1;
        t.timeout_ms = 999_999;
        let v = validate_target(&t).unwrap();
        assert_eq!(v.host, "example.org");
        assert_eq!(v.name, "example.org");
        assert_eq!(v.interval_secs, MIN_INTERVAL_SECS);
        assert_eq!(v.timeout_ms, MAX_TIMEOUT_MS);

        let mut i = tcp("lan", "192.168.1.10", 0);
        i.kind = CheckKind::Icmp;
        i.url = "http://ignored".into();
        let v = validate_target(&i).unwrap();
        assert_eq!(v.port, 0);
        assert_eq!(v.url, "", "non-http kinds drop the url");

        let h = http("site", "https://example.org/health?x=1 ");
        let v = validate_target(&h).unwrap();
        assert_eq!(v.url, "https://example.org/health?x=1");
        assert_eq!(v.name, "example.org");
        assert_eq!(v.host, "", "http drops the host");
    }

    #[test]
    fn validate_rejects_bad_ids_hosts_ports_and_credentialed_urls() {
        assert!(validate_target(&tcp("", "h", 1)).is_err());
        assert!(validate_target(&tcp("Bad_Id", "h", 1)).is_err());
        assert!(validate_target(&tcp("x", "", 1)).is_err());
        assert!(validate_target(&tcp("x", "host name", 1)).is_err());
        assert!(validate_target(&tcp("x", "http://host", 1)).is_err());
        assert!(validate_target(&tcp("x", "host:22", 1)).is_err());
        assert!(validate_target(&tcp("x", "user@host", 1)).is_err());
        assert!(validate_target(&tcp("x", "host", 0)).is_err());
        for bad in [
            "ftp://nas",
            "https://user:pass@example.com",
            "example.com",
            "",
        ] {
            let err = validate_target(&http("s", bad)).unwrap_err();
            assert!(!err.contains("pass"), "{err}");
        }
        let mut h = http("s", "https://example.com");
        h.expect_status = Some(42);
        assert!(validate_target(&h).is_err());
        h.expect_status = Some(204);
        h.expect_keyword = "k".repeat(201);
        assert!(validate_target(&h).is_err());
        let mut long = tcp("n", "h", 1);
        long.name = "n".repeat(61);
        assert!(validate_target(&long).is_err());
    }

    #[test]
    fn validate_targets_caps_count_and_rejects_duplicates() {
        let dup = vec![tcp("a", "h", 1), tcp("a", "h2", 2)];
        assert!(validate_targets(&dup).unwrap_err().contains("duplicate"));
        let many: Vec<Target> = (0..=MAX_TARGETS)
            .map(|i| tcp(&format!("t{i}"), "h", 1))
            .collect();
        assert!(validate_targets(&many).is_err());
        assert_eq!(validate_targets(&[]).unwrap().len(), 0);
    }

    #[test]
    fn run_apply_tracks_transitions_and_caps_history() {
        let mut run = TargetRun::default();
        run.apply(&Outcome::Up { ms: 10.0 }, 100);
        assert_eq!(run.up, Some(true));
        assert_eq!(run.down_since_ms, None);
        run.apply(
            &Outcome::Down {
                reason: "timed out".into(),
            },
            200,
        );
        assert_eq!(run.down_since_ms, Some(200));
        run.apply(
            &Outcome::Down {
                reason: "timed out".into(),
            },
            300,
        );
        assert_eq!(
            run.down_since_ms,
            Some(200),
            "an ongoing outage keeps its start"
        );
        assert_eq!(run.last_reason, "timed out");
        run.apply(&Outcome::Up { ms: 5.0 }, 400);
        assert_eq!(run.down_since_ms, None);
        assert_eq!(run.last_reason, "");
        for i in 0..(HISTORY_LEN * 2) {
            run.apply(&Outcome::Up { ms: i as f64 }, 500 + i as u64);
        }
        assert_eq!(run.history.len(), HISTORY_LEN);
        assert_eq!(
            run.history.back().copied().flatten(),
            Some((HISTORY_LEN * 2 - 1) as f64)
        );
    }

    #[test]
    fn target_samples_and_list_have_the_wire_shape() {
        let t = validate_target(&tcp("vps", "example.org", 22)).unwrap();
        let mut run = TargetRun::default();
        let up = Outcome::Up { ms: 12.5 };
        run.apply(&up, 1);
        let s = target_samples(&t.id, &run, &up, 1);
        let ids: Vec<&str> = s.iter().map(|x| x.sensor.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "srv.vps.up",
                "srv.vps.ms",
                "srv.vps.status",
                "srv.vps.lastDown"
            ]
        );
        assert_eq!(val(&s[0]), 1.0);
        assert_eq!(val(&s[1]), 12.5);
        assert_eq!(val(&s[2]), "up");
        assert_eq!(val(&s[3]), 0.0);

        let down = Outcome::Down {
            reason: "HTTP 503".into(),
        };
        run.apply(&down, 2);
        let s = target_samples(&t.id, &run, &down, 2);
        assert_eq!(s.len(), 3, "no ms sample while down");
        assert_eq!(val(&s[1]), "down: HTTP 503");
        assert_eq!(val(&s[2]), 2.0, "lastDown carries the outage start");

        let list = list_sample(std::slice::from_ref(&t), std::slice::from_ref(&run), 3);
        assert_eq!(list.sensor, "srv.list");
        let json = serde_json::to_value(&list.value).unwrap();
        assert_eq!(json["kind"], "json");
        let row = &json["value"][0];
        assert_eq!(row["id"], "vps");
        assert_eq!(row["kind"], "tcp");
        assert_eq!(row["up"], false);
        assert_eq!(row["ms"], serde_json::Value::Null);
        assert_eq!(row["reason"], "HTTP 503");
        assert_eq!(row["downSince"], 2);
        assert_eq!(row["history"], serde_json::json!([12.5, null]));

        // An unprobed target reports null reachability.
        let fresh = list_sample(&[t], &[TargetRun::default()], 4);
        let json = serde_json::to_value(&fresh.value).unwrap();
        assert_eq!(json["value"][0]["up"], serde_json::Value::Null);
    }

    #[test]
    fn status_ok_uses_exact_or_below_400() {
        assert!(status_ok(200, None));
        assert!(status_ok(302, None));
        assert!(!status_ok(404, None));
        assert!(status_ok(404, Some(404)));
        assert!(!status_ok(200, Some(204)));
    }

    #[test]
    fn io_reason_never_echoes_an_address() {
        let refused = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "to 10.0.0.1:22");
        assert_eq!(io_reason(&refused), "connection refused");
        let other = std::io::Error::new(std::io::ErrorKind::NotFound, "10.0.0.1");
        assert_eq!(io_reason(&other), "NotFound");
    }

    #[test]
    fn config_round_trips_camel_case_and_defaults() {
        let txt = r#"{"targets":[{"id":"a","name":"A","kind":"http","url":"https://x/","expectStatus":200}]}"#;
        let cfg: ServerCheckConfig = serde_json::from_str(txt).unwrap();
        assert_eq!(cfg.targets[0].expect_status, Some(200));
        assert_eq!(cfg.targets[0].interval_secs, 30);
        assert_eq!(cfg.targets[0].timeout_ms, 3000);
        let json = serde_json::to_value(&cfg.targets[0]).unwrap();
        assert_eq!(json["expectKeyword"], "");
        assert_eq!(json["intervalSecs"], 30);
        let status = serde_json::to_value(ServerCheckStatus {
            configured: true,
            targets: cfg.targets.clone(),
        })
        .unwrap();
        assert_eq!(status["configured"], true);
        assert_eq!(status["targets"][0]["kind"], "http");
    }

    #[tokio::test]
    async fn tcp_probe_reports_up_refused_and_timeout() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let up = probe_tcp("127.0.0.1".into(), port, Duration::from_secs(2)).await;
        assert!(matches!(up, Outcome::Up { ms } if ms >= 0.0), "{up:?}");
        drop(listener);
        // The port we just released refuses connections (nothing listens there now).
        let down = probe_tcp("127.0.0.1".into(), port, Duration::from_secs(2)).await;
        match down {
            Outcome::Down { reason } => assert!(!reason.contains("127.0.0.1"), "{reason}"),
            other => panic!("expected down, got {other:?}"),
        }
        // An unroutable-looking name that can't resolve is down, not a panic.
        let bad = probe_tcp("nonexistent.invalid".into(), 80, Duration::from_millis(500)).await;
        assert!(matches!(bad, Outcome::Down { .. }), "{bad:?}");
    }

    async fn serve_once(wire: &'static str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf).await;
            sock.write_all(wire.as_bytes()).await.unwrap();
        });
        format!("http://{addr}/health?token=probe-secret")
    }

    #[tokio::test]
    async fn http_probe_checks_status_and_keyword_without_leaking_the_url() {
        let client = http_client().unwrap();
        let t = Duration::from_secs(2);

        let url = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nstatus: ok!",
        )
        .await;
        let r = probe_http(&client, url, None, String::new(), t).await;
        assert!(matches!(r, Outcome::Up { .. }), "{r:?}");

        let url = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nstatus: ok!",
        )
        .await;
        let r = probe_http(&client, url, None, "ok!".into(), t).await;
        assert!(matches!(r, Outcome::Up { .. }), "{r:?}");

        let url = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nstatus: ok!",
        )
        .await;
        let r = probe_http(&client, url, None, "degraded".into(), t).await;
        assert_eq!(
            r,
            Outcome::Down {
                reason: "keyword not found".into()
            }
        );

        let url = serve_once(
            "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        let r = probe_http(&client, url, None, String::new(), t).await;
        assert_eq!(
            r,
            Outcome::Down {
                reason: "HTTP 503".into()
            }
        );

        let url = serve_once("HTTP/1.1 302 Found\r\nLocation: http://elsewhere/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
        let r = probe_http(&client, url, Some(200), String::new(), t).await;
        assert_eq!(
            r,
            Outcome::Down {
                reason: "HTTP 302".into()
            }
        );

        // Oversized body in keyword mode is "down", with the cap named and no URL.
        let url =
            serve_once("HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\nConnection: close\r\n\r\n")
                .await;
        let r = probe_http(&client, url, None, "x".into(), t).await;
        match r {
            Outcome::Down { reason } => {
                assert!(reason.contains("too large"), "{reason}");
                assert!(!reason.contains("probe-secret"), "{reason}");
            }
            other => panic!("expected down, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn http_probe_times_out_and_refused_errors_hide_the_url() {
        let client = http_client().unwrap();
        // Accept but never answer: the request-level timeout fires.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hold = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(sock);
        });
        let r = probe_http(
            &client,
            format!("http://{addr}/slow?token=probe-secret"),
            None,
            String::new(),
            Duration::from_millis(300),
        )
        .await;
        match r {
            Outcome::Down { reason } => {
                assert!(!reason.contains("probe-secret"), "{reason}");
                assert!(!reason.contains(&addr.to_string()), "{reason}");
            }
            other => panic!("expected down, got {other:?}"),
        }
        hold.abort();

        // Nothing listening: a connect error, also URL-free.
        let dead = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = dead.local_addr().unwrap();
        drop(dead);
        let r = probe_http(
            &client,
            format!("http://{addr}/x?token=probe-secret"),
            None,
            String::new(),
            Duration::from_secs(2),
        )
        .await;
        match r {
            Outcome::Down { reason } => assert!(!reason.contains("probe-secret"), "{reason}"),
            other => panic!("expected down, got {other:?}"),
        }
    }
}
