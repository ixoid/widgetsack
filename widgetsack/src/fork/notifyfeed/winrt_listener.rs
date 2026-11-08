//! A1 backend: `Windows.UI.Notifications.Management.UserNotificationListener` — the official
//! toast listener, used UNPACKAGED (the ADR `notifyfeed-source` decision, probe-gated). ALL WinRT
//! calls are blocking (`Async::join`) and run on the blocking pool via the worker's
//! `spawn_blocking` — never on an async worker thread (camera `load_blocking` precedent). Errors
//! cross as `SourceError` kinds ONLY: a WinRT error's Display text is never formatted, logged or
//! forwarded (camera `error_map` precedent). Read-only: `RemoveNotification`/`ClearNotifications`
//! exist on the listener and are NOT called; no `NotificationChanged` subscription either.

use super::RawNotification;

/// WinRT-shaped primitives of one `UserNotification`, as the extractor fills them. Synthetic
/// fixtures of this struct drive the pure mapper tests — tests never read real notification data
/// (project boundary).
pub struct WinrtNotificationData {
    pub id: u32,
    pub display_name: Option<String>,
    pub app_user_model_id: Option<String>,
    /// `Foundation::DateTime.UniversalTime`: 100-ns ticks since 1601-01-01 UTC.
    pub creation_ticks_100ns: i64,
    /// `GetTextElements()` output in binding order: the first element is the title, the rest the body.
    pub texts: Vec<String>,
}

/// 100-ns ticks since 1601-01-01 → epoch ms; pre-1970 values saturate at 0. Pure.
pub fn ticks_to_unix_ms(ticks: i64) -> u64 {
    const TICKS_PER_MS: i64 = 10_000;
    /// Milliseconds between 1601-01-01 and 1970-01-01 (11_644_473_600 s).
    const EPOCH_OFFSET_MS: i64 = 11_644_473_600_000;
    (ticks.div_euclid(TICKS_PER_MS) - EPOCH_OFFSET_MS).max(0) as u64
}

/// PURE SEAM: WinRT-shaped data → the backend-agnostic DTO. First text element is the title, the
/// rest join into the body with single spaces; a missing AppInfo degrades to empty identity
/// strings instead of dropping the item. Caps/control-strip are NOT applied here — they live at
/// ring ingest so every backend gets the same treatment.
pub fn map_notification(data: &WinrtNotificationData) -> RawNotification {
    let mut texts = data.texts.iter().map(String::as_str);
    let title = texts.next().unwrap_or("").trim().to_string();
    let body = texts.collect::<Vec<_>>().join(" ").trim().to_string();
    RawNotification {
        key: format!("winrt-{}", data.id),
        app: data.display_name.clone().unwrap_or_default(),
        app_key: data.app_user_model_id.clone().unwrap_or_default(),
        title: (!title.is_empty()).then_some(title),
        body: (!body.is_empty()).then_some(body),
        creation_ms: ticks_to_unix_ms(data.creation_ticks_100ns),
    }
}

#[cfg(target_os = "windows")]
mod winrt {
    use windows::UI::Notifications::Management::UserNotificationListener;
    use windows::UI::Notifications::Management::UserNotificationListenerAccessStatus;
    use windows::UI::Notifications::{
        KnownNotificationBindings, NotificationKinds, UserNotification,
    };
    // `.join()` below is the crate's inherent blocking wait on IAsyncOperation — no trait import.

    use super::super::{NotifySource, RawNotification, SourceError};
    use super::{WinrtNotificationData, map_notification};

    /// The listener itself. `Clone` is a COM ref-count bump, used to hand each poll cycle to
    /// `spawn_blocking` without moving the worker's copy.
    #[derive(Clone)]
    pub struct WinrtListener {
        listener: UserNotificationListener,
    }

    impl WinrtListener {
        pub fn new() -> Result<Self, SourceError> {
            let listener =
                UserNotificationListener::Current().map_err(|_| SourceError::Unavailable)?;
            Ok(Self { listener })
        }

        /// The documented OS-prompt trigger, run ONCE per worker start; per-cycle re-checks use
        /// `GetAccessStatus` only (repeat requests instantly return Denied). Blocking; the worker
        /// fires it detached because the prompt may wait for the owner indefinitely.
        pub fn request_access_once(&self) -> Result<(), SourceError> {
            let status = self
                .listener
                .RequestAccessAsync()
                .map_err(|_| SourceError::Unavailable)?
                .join()
                .map_err(|_| SourceError::Unavailable)?;
            match status {
                UserNotificationListenerAccessStatus::Allowed => {
                    eprintln!("notifyfeed: access granted");
                    Ok(())
                }
                _ => {
                    eprintln!("notifyfeed: access denied");
                    Err(SourceError::Denied)
                }
            }
        }
    }

    impl NotifySource for WinrtListener {
        fn name(&self) -> &'static str {
            "winrt"
        }

        fn poll_once(&mut self) -> Result<Vec<RawNotification>, SourceError> {
            // Revoked access silently returns an EMPTY list on read; GetAccessStatus is the
            // discriminator (MS docs / ADR evidence chain), so check it before every read.
            let access = self
                .listener
                .GetAccessStatus()
                .map_err(|_| SourceError::Unavailable)?;
            if access != UserNotificationListenerAccessStatus::Allowed {
                return Err(SourceError::Denied);
            }
            let view = self
                .listener
                .GetNotificationsAsync(NotificationKinds::Toast)
                .map_err(|_| SourceError::Unavailable)?
                .join()
                .map_err(|_| SourceError::Unavailable)?;
            let size = view.Size().map_err(|_| SourceError::Unavailable)?;
            let mut out = Vec::new();
            for i in 0..size {
                let Ok(item) = view.GetAt(i) else {
                    continue;
                };
                if let Some(data) = extract(&item) {
                    out.push(map_notification(&data));
                }
            }
            Ok(out)
        }
    }

    /// WinRT edge → the pure mapper's input. An item without a usable id/notification is skipped
    /// (`None`); missing AppInfo or text elements degrade to empty strings. No WinRT error text
    /// leaves this function — every failure path is a skip or a kind.
    fn extract(n: &UserNotification) -> Option<WinrtNotificationData> {
        let id = n.Id().ok()?;
        let notification = n.Notification().ok()?;
        let visual = notification.Visual().ok()?;
        let mut texts = Vec::new();
        if let Ok(binding_name) = KnownNotificationBindings::ToastGeneric()
            && let Ok(binding) = visual.GetBinding(&binding_name)
            && let Ok(elements) = binding.GetTextElements()
            && let Ok(size) = elements.Size()
        {
            for i in 0..size {
                if let Ok(element) = elements.GetAt(i)
                    && let Ok(text) = element.Text()
                {
                    texts.push(text.to_string());
                }
            }
        }
        let (display_name, app_user_model_id) = match n.AppInfo() {
            Ok(app_info) => (
                app_info
                    .DisplayInfo()
                    .ok()
                    .and_then(|info| info.DisplayName().ok())
                    .map(|name| name.to_string()),
                app_info
                    .AppUserModelId()
                    .ok()
                    .map(|aumid| aumid.to_string()),
            ),
            Err(_) => (None, None),
        };
        let creation_ticks_100ns = n.CreationTime().map(|dt| dt.UniversalTime).unwrap_or(0);
        Some(WinrtNotificationData {
            id,
            display_name,
            app_user_model_id,
            creation_ticks_100ns,
            texts,
        })
    }
}

#[cfg(target_os = "windows")]
pub use winrt::WinrtListener;

#[cfg(test)]
mod tests {
    use super::*;

    // The probe harness below (windows-only) needs the raw listener API; the mapper tests above
    // stay platform-free.
    #[cfg(target_os = "windows")]
    use windows::UI::Notifications::Management::UserNotificationListener;
    #[cfg(target_os = "windows")]
    use windows::UI::Notifications::Management::UserNotificationListenerAccessStatus;
    #[cfg(target_os = "windows")]
    use windows::UI::Notifications::NotificationKinds;

    // 2026-01-01T00:00:00Z = 1_767_225_600_000 ms; UniversalTime = (1_767_225_600 + 11_644_473_600) × 10⁷.
    const T_2026_01_01: i64 = 134_116_992_000_000_000;
    const T_1970_01_01: i64 = 116_444_736_000_000_000;

    #[test]
    fn ticks_convert_to_epoch_ms_and_pre_epoch_saturates() {
        assert_eq!(ticks_to_unix_ms(T_2026_01_01), 1_767_225_600_000);
        assert_eq!(ticks_to_unix_ms(T_1970_01_01), 0);
        assert_eq!(
            ticks_to_unix_ms(0),
            0,
            "1601-01-01 saturates at the epoch floor"
        );
        assert_eq!(ticks_to_unix_ms(-5_000_000), 0);
        assert_eq!(
            ticks_to_unix_ms(T_1970_01_01 + 10_000),
            1,
            "a 100-ns tick floors to 1 ms"
        );
    }

    #[test]
    fn mapper_takes_the_first_text_as_title_and_joins_the_rest() {
        let data = WinrtNotificationData {
            id: 42,
            display_name: Some("Telegram".into()),
            app_user_model_id: Some("org.telegram.win64".into()),
            creation_ticks_100ns: T_2026_01_01,
            texts: vec![
                "Message from Ann".into(),
                "are you there?".into(),
                "ping".into(),
            ],
        };
        let raw = map_notification(&data);
        assert_eq!(raw.key, "winrt-42");
        assert_eq!(raw.app, "Telegram");
        assert_eq!(raw.app_key, "org.telegram.win64");
        assert_eq!(raw.title.as_deref(), Some("Message from Ann"));
        assert_eq!(raw.body.as_deref(), Some("are you there? ping"));
        assert_eq!(raw.creation_ms, 1_767_225_600_000);
    }

    #[test]
    fn mapper_handles_zero_one_and_whitespace_only_texts() {
        let base = |texts: Vec<&str>| WinrtNotificationData {
            id: 7,
            display_name: Some("News".into()),
            app_user_model_id: None,
            creation_ticks_100ns: 0,
            texts: texts.into_iter().map(String::from).collect(),
        };
        let zero = map_notification(&base(vec![]));
        assert_eq!(zero.title, None);
        assert_eq!(zero.body, None);
        assert_eq!(
            zero.creation_ms, 0,
            "a failed CreationTime saturates, not panics"
        );
        let one = map_notification(&base(vec!["Only a title"]));
        assert_eq!(one.title.as_deref(), Some("Only a title"));
        assert_eq!(one.body, None);
        let blank = map_notification(&base(vec!["   "]));
        assert_eq!(blank.title, None, "whitespace-only text degrades to empty");
    }

    #[test]
    fn mapper_survives_a_missing_app_info() {
        let raw = map_notification(&WinrtNotificationData {
            id: 1,
            display_name: None,
            app_user_model_id: None,
            creation_ticks_100ns: T_1970_01_01,
            texts: vec!["t".into()],
        });
        assert_eq!(raw.app, "");
        assert_eq!(raw.app_key, "");
        assert_eq!(raw.title.as_deref(), Some("t"));
    }

    // ---- persistent probe harness (ADR `notifyfeed-source`) ----
    //
    // Doubles as the feature's one-time probe and as the documented recovery command for a
    // suspected silent-death build: rerun manually with
    // `cargo test probe_live_listener -- --ignored` (add `-- --ignored --nocapture` to see the
    // evidence lines). It reads the REAL Action Center of this machine into this process — that
    // is why it stays #[ignore]d and may only run with the owner's word (project boundary).
    // Evidence lines carry the `notifyfeed-probe:` prefix and show app names and counts ONLY —
    // never titles or bodies. Every failure path is a kind word; no WinRT error is ever formatted.

    /// The access status as a stable kind word (no Debug formatting of the WinRT value).
    #[cfg(target_os = "windows")]
    fn access_kind(status: UserNotificationListenerAccessStatus) -> &'static str {
        match status {
            UserNotificationListenerAccessStatus::Allowed => "allowed",
            UserNotificationListenerAccessStatus::Denied => "denied",
            UserNotificationListenerAccessStatus::Unspecified => "unspecified",
            // The WinRT enum is a bare i32 newtype: an OS update can return a value with no name.
            // Report it as a kind word; the != Allowed check below still fails the probe.
            _ => "other",
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "live probe: reads the owner's Action Center into this process; run manually per ADR notifyfeed-source — cargo test probe_live_listener -- --ignored"]
    fn probe_live_listener() {
        use std::sync::mpsc;
        use std::time::Duration;

        // Run blocking WinRT work on a spawned thread behind a wall-clock cap: `Ok(..)` carries
        // the work's own result, `Err(())` means the cap fired. A timed-out thread stays parked
        // until the process exits — the "must report, not hang" behavior the OS access prompt
        // needs (a human may never click it).
        fn with_cap<T: Send + 'static>(
            seconds: u64,
            work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
        ) -> Result<Result<T, &'static str>, ()> {
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(work());
            });
            rx.recv_timeout(Duration::from_secs(seconds))
                .map_err(|_| ())
        }

        let listener = UserNotificationListener::Current()
            .map_err(|_| ())
            .expect("notifyfeed-probe: listener unavailable");

        // 1. RequestAccessAsync — the documented OS-prompt trigger, run ONCE. The prompt may
        //    wait for the owner's click, hence the 90 s cap.
        let probe = listener.clone();
        let access = with_cap(90, move || {
            probe
                .RequestAccessAsync()
                .map_err(|_| "access request failed")?
                .join()
                .map_err(|_| "access request join failed")
        });
        let access = match access {
            // A prompt timeout is EVIDENCE (the prompt is up, waiting for the owner), not a FAIL.
            Err(()) => {
                println!("notifyfeed-probe: prompt-timeout");
                println!("notifyfeed-probe: done");
                return;
            }
            Ok(Err(kind)) => panic!("notifyfeed-probe: {kind}"),
            Ok(Ok(status)) => status,
        };
        println!("notifyfeed-probe: access {}", access_kind(access));
        if access != UserNotificationListenerAccessStatus::Allowed {
            panic!(
                "notifyfeed-probe: access {} (probe FAIL)",
                access_kind(access)
            );
        }

        // 2. Read the Toast snapshot: the total count plus at most the first 10 app display
        //    names (names only). A healthy read returns in milliseconds; hitting the 30 s cap
        //    means the read never completed.
        let probe = listener.clone();
        let snapshot = with_cap(30, move || {
            let view = probe
                .GetNotificationsAsync(NotificationKinds::Toast)
                .map_err(|_| "read request failed")?
                .join()
                .map_err(|_| "read join failed")?;
            let size = view.Size().map_err(|_| "size read failed")?;
            let mut names: Vec<String> = Vec::new();
            for i in 0..size {
                let Ok(item) = view.GetAt(i) else {
                    continue;
                };
                let name = item
                    .AppInfo()
                    .ok()
                    .and_then(|app| app.DisplayInfo().ok())
                    .and_then(|info| info.DisplayName().ok())
                    .map(|name| name.to_string())
                    .unwrap_or_else(|| "(no app name)".into());
                if names.len() < 10 {
                    names.push(name);
                }
            }
            Ok((size, names))
        });
        let (size, names) = match snapshot {
            Ok(Ok(read)) => read,
            Ok(Err(kind)) => panic!("notifyfeed-probe: {kind}"),
            Err(()) => panic!("notifyfeed-probe: read timed out"),
        };
        println!("notifyfeed-probe: notifications {size}");
        println!("notifyfeed-probe: apps {}", names.join(", "));
        println!("notifyfeed-probe: done");
    }
}
