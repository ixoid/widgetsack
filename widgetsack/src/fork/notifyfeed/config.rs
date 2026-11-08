//! `plugins/notify.json` — PLAIN JSON, not secure_config: the config holds no credentials and no
//! token-bearing URLs (ADR-002 reasoning, restated for notifyfeed in ADR `notifyfeed-source`; the
//! exclusion list is readable only by the owner's own account, which can read the notification
//! store itself far more directly). The file keys stay snake_case — the file never crosses the
//! bridge verbatim; `notify_config_status` re-exposes normalized values in camelCase.

use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use tauri::{AppHandle, Runtime};

/// Poll cadence guardrails (seconds) — agenda `MIN_INTERVAL`/`MAX_INTERVAL` const pattern.
pub const MIN_POLL_SECS: u64 = 2;
pub const MAX_POLL_SECS: u64 = 60;
pub const DEFAULT_POLL_SECS: u64 = 3;
/// Count-mode depth guardrails (items).
pub const MIN_DEPTH_COUNT: u64 = 10;
pub const MAX_DEPTH_COUNT: u64 = 200;
pub const DEFAULT_DEPTH_COUNT: u64 = 50;
/// Hours-mode depth guardrails.
pub const MIN_DEPTH_HOURS: u64 = 1;
pub const MAX_DEPTH_HOURS: u64 = 168;
pub const DEFAULT_DEPTH_HOURS: u64 = 24;
/// Exclusion list guardrails. Entries are matched as substrings, so length bounds what a
/// hand-crafted entry can match, not what it costs.
pub const MAX_EXCLUSIONS: usize = 64;
pub const MAX_EXCLUSION_CHARS: usize = 100;

/// How depth ages the ring: keep the newest N items, or everything younger than N hours.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DepthMode {
    #[default]
    Count,
    Hours,
}

impl DepthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Count => "count",
            Self::Hours => "hours",
        }
    }

    /// PURE: the wire/file word → the mode, with the contract's fixed error text.
    fn from_wire(s: &str) -> Result<Self, String> {
        match s.trim() {
            "count" => Ok(Self::Count),
            "hours" => Ok(Self::Hours),
            _ => Err("depth mode must be count or hours".into()),
        }
    }
}

impl Serialize for DepthMode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for DepthMode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::from_wire(&text).map_err(D::Error::custom)
    }
}

/// Server-side config. Every field defaults, so an absent file is a valid "defaults" config
/// (the feature works before the owner ever opens the pane).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NotifyConfig {
    // camelCase aliases accept a camelCase save payload from the webview while the FILE keeps
    // snake_case keys (serde serializes by the field name).
    #[serde(default = "default_poll_secs", alias = "pollSecs")]
    pub poll_secs: u64,
    #[serde(default, alias = "depthMode")]
    pub depth_mode: DepthMode,
    #[serde(default = "default_depth_count", alias = "depthCount")]
    pub depth_count: u64,
    #[serde(default = "default_depth_hours", alias = "depthHours")]
    pub depth_hours: u64,
    #[serde(default)]
    pub exclusions: Vec<String>,
}

impl Default for NotifyConfig {
    fn default() -> Self {
        Self {
            poll_secs: default_poll_secs(),
            depth_mode: DepthMode::Count,
            depth_count: default_depth_count(),
            depth_hours: default_depth_hours(),
            exclusions: Vec::new(),
        }
    }
}

fn default_poll_secs() -> u64 {
    DEFAULT_POLL_SECS
}
fn default_depth_count() -> u64 {
    DEFAULT_DEPTH_COUNT
}
fn default_depth_hours() -> u64 {
    DEFAULT_DEPTH_HOURS
}

/// Validate and normalise (pure; `server_check::validate_target` precedent). Errors name counts
/// and bounds only — they never echo the exclusion list's contents.
pub fn validate_config(cfg: &NotifyConfig) -> Result<NotifyConfig, String> {
    let trimmed: Vec<&str> = cfg.exclusions.iter().map(|s| s.trim()).collect();
    if trimmed.len() > MAX_EXCLUSIONS {
        return Err(format!("at most {MAX_EXCLUSIONS} exclusions"));
    }
    let mut exclusions = Vec::with_capacity(trimmed.len());
    let mut seen: HashSet<String> = HashSet::new();
    for entry in trimmed.into_iter().filter(|e| !e.is_empty()) {
        if entry.chars().count() > MAX_EXCLUSION_CHARS {
            return Err(format!(
                "each exclusion must be 1-{MAX_EXCLUSION_CHARS} characters"
            ));
        }
        // Dedup case-insensitively: "Telegram" and "telegram" exclude the same apps.
        if seen.insert(entry.to_lowercase()) {
            exclusions.push(entry.to_string());
        }
    }
    Ok(NotifyConfig {
        poll_secs: cfg.poll_secs.clamp(MIN_POLL_SECS, MAX_POLL_SECS),
        depth_mode: cfg.depth_mode,
        depth_count: cfg.depth_count.clamp(MIN_DEPTH_COUNT, MAX_DEPTH_COUNT),
        depth_hours: cfg.depth_hours.clamp(MIN_DEPTH_HOURS, MAX_DEPTH_HOURS),
        exclusions,
    })
}

/// What the webview learns about the config (camelCase; mirrors `notifyfeed-types.ts`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyStatus {
    pub configured: bool,
    pub poll_seconds: u64,
    pub depth_mode: DepthMode,
    pub depth_count: u64,
    pub depth_hours: u64,
    pub exclusions: Vec<String>,
}

/// PURE: a loaded file (or its absence) → the status the webview sees. A hand-edited file that
/// fails validation falls back to the defaults rather than erroring the whole pane.
pub fn status_of(cfg: Option<&NotifyConfig>) -> NotifyStatus {
    let defaults = || NotifyStatus {
        configured: false,
        poll_seconds: DEFAULT_POLL_SECS,
        depth_mode: DepthMode::Count,
        depth_count: DEFAULT_DEPTH_COUNT,
        depth_hours: DEFAULT_DEPTH_HOURS,
        exclusions: Vec::new(),
    };
    match cfg.map(validate_config) {
        Some(Ok(valid)) => NotifyStatus {
            configured: true,
            poll_seconds: valid.poll_secs,
            depth_mode: valid.depth_mode,
            depth_count: valid.depth_count,
            depth_hours: valid.depth_hours,
            exclusions: valid.exclusions,
        },
        _ => defaults(),
    }
}

pub fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = crate::file_io::config_root(app)?;
    Ok(dir.join("plugins").join("notify.json"))
}

/// Read the plain config file. `Ok(None)` = absent (defaults apply).
pub fn load_config<R: Runtime>(app: &AppHandle<R>) -> Result<Option<NotifyConfig>, String> {
    let path = config_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(txt) => serde_json::from_str(&txt)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_apply_on_an_absent_or_empty_file() {
        let cfg: NotifyConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(cfg, NotifyConfig::default());
        assert_eq!(cfg.poll_secs, 3);
        assert_eq!(cfg.depth_mode, DepthMode::Count);
        assert_eq!(cfg.depth_count, 50);
        assert_eq!(cfg.depth_hours, 24);
        assert!(cfg.exclusions.is_empty());
        // The CTO §4 example file round-trips with snake_case keys.
        let file = r#"{ "poll_secs": 3, "depth_mode": "count", "depth_count": 50, "depth_hours": 24, "exclusions": [] }"#;
        assert_eq!(serde_json::from_str::<NotifyConfig>(file).unwrap(), cfg);
        let written = serde_json::to_string(&cfg).unwrap();
        assert!(written.contains("\"poll_secs\""), "{written}");
        assert!(written.contains("\"depth_mode\""), "{written}");
    }

    #[test]
    fn validate_clamps_numbers_and_normalises_the_exclusion_list() {
        let cfg = NotifyConfig {
            poll_secs: 0,
            depth_count: 1000,
            depth_hours: 0,
            exclusions: vec![
                "  Telegram  ".into(),
                "telegram".into(),
                String::new(),
                "   ".into(),
                "Bank".into(),
            ],
            ..NotifyConfig::default()
        };
        let v = validate_config(&cfg).unwrap();
        assert_eq!(v.poll_secs, MIN_POLL_SECS);
        assert_eq!(v.depth_count, MAX_DEPTH_COUNT);
        assert_eq!(v.depth_hours, MIN_DEPTH_HOURS);
        assert_eq!(v.exclusions, ["Telegram".to_string(), "Bank".to_string()]);
        let high = validate_config(&NotifyConfig {
            poll_secs: 999,
            ..NotifyConfig::default()
        })
        .unwrap();
        assert_eq!(high.poll_secs, MAX_POLL_SECS);
    }

    #[test]
    fn validate_rejects_oversized_lists_and_entries_without_echoing_them() {
        let many = vec![String::from("x"); MAX_EXCLUSIONS + 1];
        let err = validate_config(&NotifyConfig {
            exclusions: many,
            ..NotifyConfig::default()
        })
        .unwrap_err();
        assert_eq!(err, format!("at most {MAX_EXCLUSIONS} exclusions"));

        let long = ["word".repeat(50), "zzz-marker".to_string()].concat();
        let err = validate_config(&NotifyConfig {
            exclusions: vec![long],
            ..NotifyConfig::default()
        })
        .unwrap_err();
        assert_eq!(err, "each exclusion must be 1-100 characters");
        assert!(
            !err.contains("marker"),
            "the entry text never enters the error"
        );
    }

    #[test]
    fn depth_mode_wires_as_the_two_words_and_rejects_anything_else() {
        assert_eq!(
            serde_json::from_str::<DepthMode>("\"daily\"")
                .unwrap_err()
                .to_string(),
            "depth mode must be count or hours"
        );
        assert_eq!(
            serde_json::from_str::<DepthMode>("\"hours\"").unwrap(),
            DepthMode::Hours
        );
        assert_eq!(
            serde_json::from_str::<DepthMode>("\" count \"").unwrap(),
            DepthMode::Count
        );
        assert_eq!(DepthMode::Hours.as_str(), "hours");
        assert_eq!(
            serde_json::to_value(DepthMode::Count).unwrap(),
            serde_json::json!("count")
        );
    }

    #[test]
    fn status_reports_defaults_when_absent_and_validated_values_when_present() {
        let absent = status_of(None);
        assert!(!absent.configured);
        assert_eq!(absent.poll_seconds, DEFAULT_POLL_SECS);
        assert!(absent.exclusions.is_empty());

        let cfg = NotifyConfig {
            poll_secs: 99,
            depth_mode: DepthMode::Hours,
            depth_hours: 999,
            exclusions: vec!["  Bank  ".into()],
            ..NotifyConfig::default()
        };
        let status = status_of(Some(&cfg));
        assert!(status.configured);
        // Normalised (clamped/trimmed) values cross, not the raw file values.
        assert_eq!(status.poll_seconds, MAX_POLL_SECS);
        assert_eq!(status.depth_mode, DepthMode::Hours);
        assert_eq!(status.depth_hours, MAX_DEPTH_HOURS);
        assert_eq!(status.exclusions, ["Bank".to_string()]);

        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["configured"], true);
        assert_eq!(json["pollSeconds"], MAX_POLL_SECS);
        assert_eq!(json["depthMode"], "hours");
        assert_eq!(json["depthHours"], MAX_DEPTH_HOURS);
    }
}
