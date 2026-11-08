//! Layout gate for the camera stream. An overlay renders only the SAVED layout, so a non-studio
//! window may subscribe to (or probe) the camera only when the saved `widgets.json` contains a
//! Camera widget. The studio previews unsaved edits and bypasses the gate. Anything unreadable fails
//! closed. The layout JSON is frontend-owned, so the walk is generic and tolerant (same approach as
//! `layout_grants`, which this module deliberately does not edit).

use serde_json::Value;

/// Fixed refusal text; the client maps a refused subscribe to its `refused` state.
pub const ERR_NOT_GRANTED: &str =
    "camera stream is not granted: save a layout with a Camera widget in Studio";

/// True when any object anywhere in the layout has `"type": "camera"`. Rows, columns, grids,
/// floating layers and group children nest arbitrarily, so the walk is iterative (no recursion
/// depth to blow). Corrupt JSON or a non-object root counts as "no camera".
pub fn layout_has_camera(json: &str) -> bool {
    let Ok(doc) = serde_json::from_str::<Value>(json) else {
        return false;
    };
    if !doc.is_object() {
        return false;
    }
    let mut pending = vec![&doc];
    while let Some(value) = pending.pop() {
        match value {
            Value::Array(items) => pending.extend(items),
            Value::Object(obj) => {
                if obj.get("type").and_then(Value::as_str) == Some("camera") {
                    return true;
                }
                pending.extend(obj.values());
            }
            _ => {}
        }
    }
    false
}

/// PURE SEAM: the gate decision. `saved` is the result of reading `widgets.json` (`Ok(None)` =
/// missing); it is not consulted at all for the studio.
pub fn authorize(window_label: &str, saved: Result<Option<&str>, &str>) -> Result<(), String> {
    if window_label == "studio" {
        return Ok(());
    }
    match saved {
        Ok(Some(json)) if layout_has_camera(json) => Ok(()),
        // Missing, unreadable, corrupt or without a camera: all the same fixed refusal, so the
        // message never carries a path or an IO error text.
        _ => Err(ERR_NOT_GRANTED.to_string()),
    }
}

/// Command-side adapter: reads the saved layout only for non-studio windows.
pub async fn authorize_saved<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    window_label: &str,
) -> Result<(), String> {
    if window_label == "studio" {
        return Ok(());
    }
    let saved = crate::layout_grants::read_saved_layout(app).await;
    authorize(
        window_label,
        saved.as_ref().map(Option::as_deref).map_err(String::as_str),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn leaf(kind: &str) -> Value {
        json!({ "id": "w", "unit": { "id": "w", "type": kind, "config": {} } })
    }

    #[test]
    fn a_camera_widget_in_the_saved_layout_is_found() {
        let doc = json!({ "version": 2, "monitors": { "M1": {
            "root": { "id": "r", "kind": "row", "children": [leaf("text"), leaf("camera")] },
            "floating": []
        } } });
        assert!(layout_has_camera(&doc.to_string()));
        assert!(layout_has_camera(
            r#"{"widgets":[{"id":"a","type":"camera","rect":{}}]}"#
        ));
    }

    #[test]
    fn a_camera_nested_deep_in_groups_is_found() {
        let mut node = leaf("camera");
        for _ in 0..40 {
            node = json!({ "id": "g", "kind": "col", "children": [leaf("text"), node] });
        }
        assert!(layout_has_camera(
            &json!({ "monitors": { "M": { "root": node } } }).to_string()
        ));
    }

    #[test]
    fn a_layout_without_a_camera_is_not_granted() {
        let doc = json!({ "monitors": { "M1": { "root": { "children": [
            leaf("text"), leaf("servicehealth"),
            // the word alone is not a widget type
            { "unit": { "type": "text", "config": { "text": "camera", "kind": "camera" } } }
        ] } } } });
        assert!(!layout_has_camera(&doc.to_string()));
        assert!(!layout_has_camera(r#"{"widgets":[]}"#));
        assert!(!layout_has_camera(r#"{"type":"camerax"}"#));
        assert!(!layout_has_camera(r#"{"type":["camera"]}"#));
    }

    #[test]
    fn corrupt_or_odd_documents_grant_nothing() {
        for bad in [
            "",
            "{",
            "not json",
            "[]",
            "null",
            r#"[{"type":"camera"}]"#,
            "\"camera\"",
        ] {
            assert!(!layout_has_camera(bad), "{bad}");
        }
    }

    #[test]
    fn overlays_need_a_saved_camera_and_the_studio_bypasses_the_gate() {
        let with = r#"{"widgets":[{"type":"camera"}]}"#;
        let without = r#"{"widgets":[{"type":"text"}]}"#;
        assert!(authorize("overlay-1", Ok(Some(with))).is_ok());
        for saved in [
            Ok(Some(without)),
            Ok(Some("{ corrupt")),
            Ok(None),
            Err("could not read C:\\secret\\widgets.json"),
        ] {
            assert_eq!(authorize("overlay-1", saved).unwrap_err(), ERR_NOT_GRANTED);
        }
        // Not even a missing or broken layout stops the studio, and it never looks at the file.
        for saved in [Ok(None), Ok(Some(without)), Err("io")] {
            assert!(authorize("studio", saved).is_ok());
        }
        // Only the exact label "studio" is trusted.
        assert!(authorize("Studio", Ok(Some(without))).is_err());
        assert!(authorize("main", Ok(None)).is_err());
    }

    #[test]
    fn the_refusal_text_is_fixed() {
        assert_eq!(
            ERR_NOT_GRANTED,
            "camera stream is not granted: save a layout with a Camera widget in Studio"
        );
    }
}
