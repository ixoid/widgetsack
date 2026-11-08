//! Pure notification ring — the tested core of the notifyfeed source. Everything here is I/O-free:
//! the worker feeds it [`RawNotification`]s and reads back the `notify.list` payload, the
//! `notify.count` total and the change-detection plan. Caps, control-char stripping, dedup by
//! `key`, exclusion filtering, retro-purge, depth aging and the seen rules all live in this file
//! so they are unit-tested without WinRT, files or a clock (time arrives as explicit `now_ms`).

use std::collections::HashSet;

use serde::Serialize;

use super::RawNotification;
use super::config::DepthMode;

/// Hard ring cap in BOTH depth modes. Count mode is bounded by `depth_count` (≤ 200 by config
/// validation); hours mode can backfill more than 200 at once — the cap then drops the OLDEST
/// items even if they are inside the hours window (ADR `notifyfeed-source`: documented behavior,
/// not a bug).
pub const RING_CAP: usize = 200;
/// Per-field caps applied at INGEST (chars(), not bytes; no ellipsis marker).
pub const APP_CAP: usize = 80;
pub const APP_KEY_CAP: usize = 256;
pub const TITLE_CAP: usize = 160;
pub const BODY_CAP: usize = 480;
/// Keys are backend-shaped (`winrt-{id}` / `db-{row}`); the cap only bounds ring memory.
pub const KEY_CAP: usize = 64;

/// Strip control characters (newlines/tabs/NUL/…) and truncate on a `chars()` boundary. Pure.
pub fn clean_text(s: &str, max_chars: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .take(max_chars)
        .collect()
}

/// TRUE shared exclusion matcher (sync Q1): case-insensitive SUBSTRING against BOTH the app
/// display name and the app key (AUMID). Substring over-match is the privacy-safe direction
/// (drops more) and is owner-visible. Exactly two call sites must use this: ring ingest and
/// [`NotifyRing::apply_exclusions`], so ingest and purge can never diverge.
pub fn is_excluded(app: &str, app_key: &str, exclusions: &[String]) -> bool {
    exclusions.iter().any(|entry| {
        // An empty entry (only possible via an unvalidated path) must never match everything.
        let entry = entry.trim().to_lowercase();
        !entry.is_empty()
            && (app.to_lowercase().contains(&entry) || app_key.to_lowercase().contains(&entry))
    })
}

/// One ring item. `seen_stored` is the per-key seen state set by the auto-seen transition (the OS
/// removed the notification from the Action Center); `in_center` tracks presence in the latest
/// snapshot. Both are ring-internal and never cross the bridge on their own.
#[derive(Clone, Debug, PartialEq)]
pub struct RingEntry {
    pub key: String,
    pub app: String,
    pub app_key: String,
    pub title: String,
    pub body: String,
    pub ts_ms: u64,
    pub seen_stored: bool,
    pub in_center: bool,
    /// Monotonic insertion counter: a stable newest-first tiebreak for equal `ts_ms`.
    seq: u64,
}

/// What one ingest pass changed — counts only, for a log line. Titles/bodies never enter logs.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct IngestDelta {
    pub added: usize,
    pub auto_seen: usize,
    pub aged_out: usize,
}

#[derive(Default)]
pub struct NotifyRing {
    /// Newest first: `(ts_ms, seq)` descending.
    items: Vec<RingEntry>,
    next_seq: u64,
}

impl NotifyRing {
    pub fn len(&self) -> usize {
        self.items.len()
    }

    // Test-only accessors: the assertions inspect ring state directly. `is_empty` exists because
    // clippy requires it next to `len`.
    #[allow(
        dead_code,
        reason = "required by clippy's len_without_is_empty; tests use it"
    )]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    #[allow(
        dead_code,
        reason = "the ring's invariants are asserted in the co-located tests"
    )]
    pub fn items(&self) -> &[RingEntry] {
        &self.items
    }

    /// Ingest one source snapshot. Order: auto-seen transition over the OLD `in_center` flags →
    /// upsert of the non-excluded snapshot items (caps + dedup by key; stored seen survives an
    /// update) → newest-first sort → depth aging. Excluded items are never stored, counted or
    /// emitted. Pure.
    pub fn ingest(
        &mut self,
        raw: &[RawNotification],
        exclusions: &[String],
        mode: DepthMode,
        depth_count: usize,
        depth_hours: u64,
        now_ms: u64,
    ) -> IngestDelta {
        let mut delta = IngestDelta::default();
        // Auto-seen (owner decision 2026-11-08): an item we previously saw in the Action Center
        // that this snapshot no longer returns was dismissed/clicked/cleared at the OS level —
        // it loses unread highlighting but STAYS in the feed as history. The transition reads the
        // OLD in_center flags, so it must run before the upsert sets them for this snapshot.
        let present: HashSet<&str> = raw
            .iter()
            .filter(|r| !is_excluded(&r.app, &r.app_key, exclusions))
            .map(|r| r.key.as_str())
            .collect();
        for entry in &mut self.items {
            if entry.in_center && !present.contains(entry.key.as_str()) {
                entry.in_center = false;
                if !entry.seen_stored {
                    delta.auto_seen += 1;
                }
                entry.seen_stored = true;
            }
        }
        for item in raw {
            if is_excluded(&item.app, &item.app_key, exclusions) {
                continue; // excluded content is never stored, counted or emitted
            }
            let (key, app, app_key) = (
                clean_text(&item.key, KEY_CAP),
                clean_text(&item.app, APP_CAP),
                clean_text(&item.app_key, APP_KEY_CAP),
            );
            let title = clean_text(item.title.as_deref().unwrap_or(""), TITLE_CAP);
            let body = clean_text(item.body.as_deref().unwrap_or(""), BODY_CAP);
            match self.items.iter_mut().find(|e| e.key == key) {
                Some(entry) => {
                    entry.app = app;
                    entry.app_key = app_key;
                    entry.title = title;
                    entry.body = body;
                    entry.ts_ms = item.creation_ms;
                    entry.in_center = true;
                }
                None => {
                    self.items.push(RingEntry {
                        key,
                        app,
                        app_key,
                        title,
                        body,
                        ts_ms: item.creation_ms,
                        seen_stored: false,
                        in_center: true,
                        seq: self.next_seq,
                    });
                    self.next_seq += 1;
                    delta.added += 1;
                }
            }
        }
        self.items
            .sort_by_key(|e| (std::cmp::Reverse(e.ts_ms), std::cmp::Reverse(e.seq)));
        let before = self.items.len();
        match mode {
            DepthMode::Count => self.items.truncate(depth_count.min(RING_CAP)),
            DepthMode::Hours => {
                let window_ms = depth_hours.saturating_mul(3_600_000);
                self.items
                    .retain(|e| now_ms.saturating_sub(e.ts_ms) < window_ms);
                self.items.truncate(RING_CAP);
            }
        }
        delta.aged_out = before - self.items.len();
        delta
    }

    /// Retro-purge (sync Q1): remove every item whose `app` or `app_key` matches the exclusion
    /// list, regardless of seen state; returns the dropped count. The ring is NOT cleared on
    /// worker restart or config save — only this purge and depth aging remove items.
    pub fn apply_exclusions(&mut self, exclusions: &[String]) -> usize {
        let before = self.items.len();
        self.items
            .retain(|e| !is_excluded(&e.app, &e.app_key, exclusions));
        before - self.items.len()
    }

    /// The `notify.list` payload: `{version: 1, items: […]}` newest first. `seen` is computed
    /// here, in one place: `seen_stored || ts_ms <= last_mark_ms` (mark rule, Правило 3).
    pub fn list_payload(&self, last_mark_ms: u64) -> NotifyListPayload {
        NotifyListPayload {
            version: 1,
            items: self
                .items
                .iter()
                .map(|e| NotifyItemWire {
                    key: e.key.clone(),
                    app: e.app.clone(),
                    title: e.title.clone(),
                    body: e.body.clone(),
                    ts_ms: e.ts_ms,
                    seen: e.seen_stored || e.ts_ms <= last_mark_ms,
                })
                .collect(),
        }
    }
}

/// One wire item (camelCase; mirrors `notifyfeed-types.ts` — change both sides together).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyItemWire {
    pub key: String,
    pub app: String,
    pub title: String,
    pub body: String,
    pub ts_ms: u64,
    pub seen: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NotifyListPayload {
    pub version: u8,
    pub items: Vec<NotifyItemWire>,
}

/// Everything an emit decision needs, comparable for change detection: the payload plus the
/// `notify.count` total.
#[derive(Clone, Debug, PartialEq)]
pub struct EmitPlan {
    pub payload: NotifyListPayload,
    /// `notify.count` — the TOTAL ring length (owner decision 2026-11-08): what is in the feed
    /// after exclusions and aging. NOT the unseen count; does not reset on mark-all-seen.
    pub count: usize,
}

pub fn emit_plan(ring: &NotifyRing, last_mark_ms: u64) -> EmitPlan {
    EmitPlan {
        count: ring.len(),
        payload: ring.list_payload(last_mark_ms),
    }
}

/// The full batch for one emit: `notify.list` (Json), `notify.count` (Scalar), `notify.status`
/// (Text — kinds only, never bodies). Pure.
pub fn emit_samples(
    plan: &EmitPlan,
    status: &str,
    ts_ms: u64,
) -> Vec<crate::sensors::SensorSample> {
    use crate::sensors::{SensorSample, SensorValue};
    vec![
        SensorSample {
            sensor: "notify.list".into(),
            ts_ms,
            value: SensorValue::Json(serde_json::to_value(&plan.payload).unwrap_or_default()),
        },
        SensorSample::scalar("notify.count", ts_ms, plan.count as f64),
        SensorSample::text("notify.status", ts_ms, status),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(key: &str, app: &str, ts: u64) -> RawNotification {
        RawNotification {
            key: key.into(),
            app: app.into(),
            app_key: String::new(),
            title: None,
            body: None,
            creation_ms: ts,
        }
    }

    fn count_mode() -> (DepthMode, usize, u64) {
        (DepthMode::Count, 50, 24)
    }

    #[test]
    fn clean_text_strips_controls_and_truncates_on_chars_boundaries() {
        assert_eq!(clean_text("a\nb\tc\u{0}d", 100), "abcd");
        // Truncate counts CHARS, not bytes: 200 'é' (2 bytes each) → 80 chars / 160 bytes.
        let capped = clean_text(&"é".repeat(200), APP_CAP);
        assert_eq!(capped.chars().count(), APP_CAP);
        assert_eq!(capped.len(), APP_CAP * 2);
        assert_eq!(clean_text("", 10), "");
        // No ellipsis marker is appended.
        assert_eq!(
            clean_text(&"x".repeat(TITLE_CAP + 5), TITLE_CAP),
            "x".repeat(TITLE_CAP)
        );
    }

    #[test]
    fn is_excluded_matches_substrings_case_insensitively_on_app_and_app_key() {
        let ex = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_excluded(
            "Telegram",
            "org.telegram.win64",
            &ex(&["telegram"])
        ));
        assert!(
            is_excluded("WeChat", "CN=Bank.App.mumble", &ex(&["bank"])),
            "app_key matches"
        );
        assert!(
            is_excluded("My Bank app", "com.other", &ex(&["BANK"])),
            "app display name matches"
        );
        assert!(!is_excluded(
            "Telegram",
            "org.telegram.win64",
            &ex(&["signal"])
        ));
        assert!(
            !is_excluded("Whatever", "whatever", &ex(&[""])),
            "an empty entry never excludes everything"
        );
        assert!(
            is_excluded("xSpotifyx", "x", &ex(&["SPOTIFY"])),
            "substring, not equality"
        );
    }

    #[test]
    fn ingest_dedups_by_key_and_refreshes_fields_but_keeps_stored_seen() {
        let mut ring = NotifyRing::default();
        let (m, c, h) = count_mode();
        ring.ingest(&[raw("k1", "Telegram", 100)], &[], m, c, h, 1_000);
        let d = ring.ingest(
            &[RawNotification {
                key: "k1".into(),
                app: "Telegram".into(),
                app_key: "org.telegram".into(),
                title: Some("second edition".into()),
                body: Some("new body".into()),
                creation_ms: 100,
            }],
            &[],
            m,
            c,
            h,
            2_000,
        );
        assert_eq!(d.added, 0, "the same key is an update, not a new item");
        assert_eq!(ring.len(), 1);
        let item = &ring.items()[0];
        assert_eq!(item.title, "second edition");
        assert_eq!(item.body, "new body");
        assert!(item.in_center);
        // Auto-seen survives a refresh: dismiss then re-appear keeps the item seen.
        ring.ingest(&[], &[], m, c, h, 3_000);
        assert!(ring.items()[0].seen_stored);
        ring.ingest(&[raw("k1", "Telegram", 100)], &[], m, c, h, 4_000);
        assert!(
            ring.items()[0].seen_stored,
            "stored seen is per key, not per snapshot"
        );
        assert!(ring.items()[0].in_center);
    }

    #[test]
    fn ingest_applies_caps_and_never_stores_excluded_items() {
        let mut ring = NotifyRing::default();
        let (m, c, h) = count_mode();
        let long = RawNotification {
            key: "k".repeat(KEY_CAP + 10),
            app: "a".repeat(APP_CAP + 50),
            app_key: "p".repeat(APP_KEY_CAP + 50),
            title: Some("t".repeat(TITLE_CAP + 50)),
            body: Some("b".repeat(BODY_CAP + 50)),
            creation_ms: 5,
        };
        ring.ingest(&[long], &[], m, c, h, 10);
        let item = &ring.items()[0];
        assert_eq!(item.key.chars().count(), KEY_CAP);
        assert_eq!(item.app.chars().count(), APP_CAP);
        assert_eq!(item.app_key.chars().count(), APP_KEY_CAP);
        assert_eq!(item.title.chars().count(), TITLE_CAP);
        assert_eq!(item.body.chars().count(), BODY_CAP);

        let exclusions = ["bank"].map(String::from).to_vec();
        ring.ingest(
            &[raw("e1", "MyBank", 20), raw("ok", "News", 21)],
            &exclusions,
            m,
            c,
            h,
            30,
        );
        assert_eq!(ring.len(), 2, "excluded items are never stored");
        assert!(ring.items().iter().all(|e| e.key != "e1"));
        assert!(ring.items().iter().any(|e| e.key == "ok"));
    }

    #[test]
    fn auto_seen_marks_items_that_left_the_action_center_and_keeps_them() {
        let mut ring = NotifyRing::default();
        let (m, c, h) = count_mode();
        ring.ingest(
            &[raw("a", "Telegram", 100), raw("b", "Mail", 200)],
            &[],
            m,
            c,
            h,
            1_000,
        );
        // The next snapshot no longer contains "a": dismissed/clicked/cleared in Windows.
        let d = ring.ingest(&[raw("b", "Mail", 200)], &[], m, c, h, 2_000);
        assert_eq!(d.auto_seen, 1);
        assert_eq!(ring.len(), 2, "the item stays in the feed as history");
        let a = ring.items().iter().find(|e| e.key == "a").unwrap();
        assert!(a.seen_stored);
        assert!(!a.in_center);
        // The emit rule sees it even though its ts is newer than the mark.
        let payload = ring.list_payload(0);
        let wire = payload.items.iter().find(|i| i.key == "a").unwrap();
        assert!(wire.seen);
        let b = payload.items.iter().find(|i| i.key == "b").unwrap();
        assert!(!b.seen, "a still-present item stays unread");
    }

    #[test]
    fn unseen_follows_the_mark_rule_and_stored_seen_wins() {
        let mut ring = NotifyRing::default();
        let (m, c, h) = count_mode();
        ring.ingest(
            &[raw("old", "Mail", 100), raw("new", "Mail", 300)],
            &[],
            m,
            c,
            h,
            1_000,
        );
        // Mark-all at 200: ts <= 200 is seen; ts > 200 stays unread.
        let payload = ring.list_payload(200);
        let seen = |key: &str| payload.items.iter().find(|i| i.key == key).unwrap().seen;
        assert!(seen("old"));
        assert!(!seen("new"));
        // A late backfill older than the mark is seen the moment it first appears (Правило 3).
        ring.ingest(&[raw("late", "Mail", 50)], &[], m, c, h, 1_500);
        let payload = ring.list_payload(200);
        assert!(payload.items.iter().find(|i| i.key == "late").unwrap().seen);
    }

    #[test]
    fn count_mode_keeps_the_newest_depth_count_items() {
        let mut ring = NotifyRing::default();
        let batch: Vec<RawNotification> = (0..60)
            .map(|i| raw(&format!("k{i}"), "App", 1_000 + i))
            .collect();
        let d = ring.ingest(&batch, &[], DepthMode::Count, 50, 24, 2_000);
        assert_eq!(d.aged_out, 10);
        assert_eq!(ring.len(), 50);
        // Newest first, and the 50 kept are the newest 50.
        assert_eq!(ring.items()[0].key, "k59");
        assert_eq!(ring.items()[49].key, "k10");
    }

    #[test]
    fn hours_mode_ages_with_an_explicit_now() {
        let mut ring = NotifyRing::default();
        // now = 10_000_000; window (1 h) = 3_600_000 ms.
        let batch = [
            raw("fresh", "App", 6_500_000), // 3.5 h old → kept
            raw("edge", "App", 6_400_000),  // exactly the window old → dropped
            raw("old", "App", 1_000_000),   // far outside → dropped
        ];
        let d = ring.ingest(&batch, &[], DepthMode::Hours, 50, 1, 10_000_000);
        assert_eq!(d.aged_out, 2);
        assert_eq!(ring.len(), 1);
        assert_eq!(ring.items()[0].key, "fresh");
    }

    #[test]
    fn the_hard_cap_truncates_hours_mode_backfill_oldest_first() {
        let mut ring = NotifyRing::default();
        let batch: Vec<RawNotification> = (0..RING_CAP + 50)
            .map(|i| raw(&format!("k{i:03}"), "App", 5_000_000 + i as u64))
            .collect();
        let d = ring.ingest(&batch, &[], DepthMode::Hours, 200, 24, 10_000_000);
        assert_eq!(ring.len(), RING_CAP);
        assert_eq!(d.aged_out, 50, "the oldest items go even inside the window");
        assert_eq!(ring.items()[0].key, "k249");
        assert_eq!(ring.items()[RING_CAP - 1].key, "k050");
    }

    #[test]
    fn mark_all_seen_flips_seen_but_count_is_the_total_and_never_resets() {
        let mut ring = NotifyRing::default();
        let (m, c, h) = count_mode();
        ring.ingest(
            &[
                raw("a", "Mail", 100),
                raw("b", "Mail", 200),
                raw("c", "News", 300),
            ],
            &[],
            m,
            c,
            h,
            1_000,
        );
        let before = emit_plan(&ring, 0);
        assert_eq!(
            before.count, 3,
            "notify.count is the TOTAL after exclusions and aging"
        );
        let all_unread = before.payload.items.iter().filter(|i| !i.seen).count();
        assert_eq!(all_unread, 3);
        // Mark all seen at 1_000: seen flags flip; the count does not reset (owner decision 7).
        let after = emit_plan(&ring, 1_000);
        assert_eq!(after.count, 3);
        assert!(after.payload.items.iter().all(|i| i.seen));
    }

    #[test]
    fn the_payload_serializes_the_camel_case_wire_shape_newest_first() {
        let mut ring = NotifyRing::default();
        let (m, c, h) = count_mode();
        ring.ingest(
            &[
                RawNotification {
                    key: "winrt-7".into(),
                    app: "Telegram".into(),
                    app_key: "org.telegram.win64".into(),
                    title: Some("Hi".into()),
                    body: Some("Body text".into()),
                    creation_ms: 100,
                },
                raw("winrt-8", "Mail", 200),
            ],
            &[],
            m,
            c,
            h,
            1_000,
        );
        let plan = emit_plan(&ring, 150);
        let json = serde_json::to_value(&plan.payload).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "version": 1,
                "items": [
                    { "key": "winrt-8", "app": "Mail", "title": "", "body": "", "tsMs": 200, "seen": false },
                    { "key": "winrt-7", "app": "Telegram", "title": "Hi", "body": "Body text", "tsMs": 100, "seen": true },
                ]
            })
        );
        let samples = emit_samples(&plan, "granted", 5);
        assert_eq!(samples[0].sensor, "notify.list");
        assert_eq!(samples[1].sensor, "notify.count");
        assert_eq!(samples[2].sensor, "notify.status");
        let wire = serde_json::to_value(&samples[0].value).unwrap();
        assert_eq!(wire["kind"], "json");
        assert_eq!(wire["value"]["items"][0]["tsMs"], 200);
    }

    #[test]
    fn emit_plans_change_only_when_payload_or_count_change() {
        let mut ring = NotifyRing::default();
        let (m, c, h) = count_mode();
        ring.ingest(&[raw("a", "Mail", 100)], &[], m, c, h, 1_000);
        let p1 = emit_plan(&ring, 0);
        let p2 = emit_plan(&ring, 0);
        assert_eq!(p1, p2, "an unchanged ring and mark emit the same plan");
        assert_ne!(
            p1,
            emit_plan(&ring, 1_000),
            "the mark crossing items changes the plan"
        );
        ring.ingest(&[raw("b", "Mail", 200)], &[], m, c, h, 1_100);
        assert_ne!(p1, emit_plan(&ring, 0), "a new item changes the plan");
    }

    #[test]
    fn apply_exclusions_purges_seen_and_unseen_items_of_the_matching_apps() {
        let mut ring = NotifyRing::default();
        let (m, c, h) = count_mode();
        ring.ingest(
            &[
                raw("a-seen", "Alpha", 100),
                raw("a-new", "Alpha", 300),
                raw("b-new", "Beta", 400),
            ],
            &[],
            m,
            c,
            h,
            1_000,
        );
        // "a-seen" disappears from the Action Center first, so it carries per-key seen state.
        ring.ingest(
            &[raw("a-new", "Alpha", 300), raw("b-new", "Beta", 400)],
            &[],
            m,
            c,
            h,
            2_000,
        );
        assert!(
            ring.items()
                .iter()
                .find(|e| e.key == "a-seen")
                .unwrap()
                .seen_stored
        );
        assert!(
            !ring
                .items()
                .iter()
                .find(|e| e.key == "a-new")
                .unwrap()
                .seen_stored
        );

        let exclusions = ["alpha"].map(String::from).to_vec();
        let dropped = ring.apply_exclusions(&exclusions);
        assert_eq!(dropped, 2, "both seen states of the excluded app go");
        assert_eq!(ring.len(), 1);
        assert_eq!(ring.items()[0].key, "b-new");
        // notify.count re-derives: the unseen Alpha item no longer counts.
        assert_eq!(emit_plan(&ring, 0).count, 1);
        assert_eq!(
            ring.apply_exclusions(&exclusions),
            0,
            "a second apply is a no-op"
        );
        // The matcher agrees with ingest on the same fixture: what ingest drops is what purge drops.
        let beta = ("Beta", "beta.app");
        assert!(!is_excluded(beta.0, beta.1, &exclusions));
        let mut fresh = NotifyRing::default();
        fresh.ingest(&[raw("x", beta.0, 10)], &exclusions, m, c, h, 20);
        assert_eq!(fresh.len(), 1, "ingest keeps exactly what purge keeps");
        let mut twin = NotifyRing::default();
        twin.ingest(&[raw("x", beta.0, 10)], &[], m, c, h, 20);
        assert_eq!(twin.apply_exclusions(&exclusions), 0);
    }

    #[test]
    fn apply_exclusions_matches_the_app_key_too() {
        let mut ring = NotifyRing::default();
        let (m, c, h) = count_mode();
        ring.ingest(
            &[RawNotification {
                key: "k".into(),
                app: "Friendly".into(),
                app_key: "CN=Secret.Banker".into(),
                title: None,
                body: None,
                creation_ms: 10,
            }],
            &[],
            m,
            c,
            h,
            20,
        );
        assert_eq!(ring.apply_exclusions(&[String::from("banker")]), 1);
    }
}
