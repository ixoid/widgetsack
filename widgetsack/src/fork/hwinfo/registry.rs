//! HWiNFO's gadget / "VSB" reporting: the readings the user ticked in HWiNFO's Sensors window are
//! mirrored into `HKCU\Software\HWiNFO64\VSB` as string values `Sensor<n>`, `Label<n>`, `Value<n>`
//! (formatted, e.g. `3,605.2 MHz`) and `ValueRaw<n>` (plain decimal). This is what the owner's
//! Rainmeter skins read, it is on by default for them, and the free edition puts no time limit on it.
//! The pure `parse_entries` is tested on value lists; `read_live` is the `winreg` edge (KEY_READ).

use std::collections::BTreeMap;

use super::model::{Reading, ReadingKind, cap_text};

/// Registry path of the gadget mirror (under HKEY_CURRENT_USER).
pub const VSB_SUBKEY: &str = r"Software\HWiNFO64\VSB";
/// Registry path of HWiNFO's sensor settings; `EnableVSB` (DWORD) says whether the mirror is on.
pub const SENSORS_SUBKEY: &str = r"Software\HWiNFO64\Sensors";
/// Index cap: HWiNFO lets the user tick at most a few dozen gadget readings.
pub const MAX_INDEX: usize = 512;

#[derive(Default)]
struct Slot {
    sensor: Option<String>,
    label: Option<String>,
    value: Option<String>,
    raw: Option<String>,
}

/// Split `Label12` into (`Label`, 12). `None` when the name has no numeric suffix.
fn split_indexed(name: &str) -> Option<(&str, usize)> {
    let digits_at = name.find(|c: char| c.is_ascii_digit())?;
    let (head, idx) = name.split_at(digits_at);
    let idx: usize = idx.parse().ok()?;
    Some((head, idx))
}

/// Parse a `ValueRaw` string: a plain decimal, tolerant of a decimal comma and whitespace.
fn parse_raw(raw: &str) -> Option<f64> {
    let t = raw.trim();
    let v = t
        .parse::<f64>()
        .or_else(|_| t.replace(',', ".").parse::<f64>())
        .ok()?;
    v.is_finite().then_some(v)
}

/// The unit of a formatted `Value`: the trailing token after the last space, when it is not a
/// number (`3,605.2 MHz` → `MHz`, `63.8 °C` → `°C`, `11.0 %` → `%`, `42` → ``).
fn unit_of(value: &str) -> String {
    let t = value.trim();
    match t.rsplit_once(char::is_whitespace) {
        Some((_, tail))
            if !tail.is_empty()
                && !tail
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == '.' || c == ',') =>
        {
            cap_text(tail)
        }
        _ => String::new(),
    }
}

/// Turn the key's `(name, data)` values into readings, ordered by HWiNFO's index. Entries without a
/// label or a parseable raw value are skipped. Pure.
pub fn parse_entries(values: &[(String, String)]) -> Vec<Reading> {
    let mut slots: BTreeMap<usize, Slot> = BTreeMap::new();
    for (name, data) in values {
        let Some((head, idx)) = split_indexed(name) else {
            continue;
        };
        if idx > MAX_INDEX {
            continue;
        }
        let slot = slots.entry(idx).or_default();
        match head {
            "Sensor" => slot.sensor = Some(cap_text(data)),
            "Label" => slot.label = Some(cap_text(data)),
            "Value" => slot.value = Some(cap_text(data)),
            "ValueRaw" => slot.raw = Some(data.clone()),
            _ => {}
        }
    }
    slots
        .into_values()
        .filter_map(|s| {
            let label = s.label.filter(|l| !l.is_empty())?;
            let value = parse_raw(s.raw.as_deref()?)?;
            let unit = s.value.as_deref().map(unit_of).unwrap_or_default();
            Some(Reading {
                sensor: s.sensor.unwrap_or_default(),
                label,
                kind: ReadingKind::from_unit(&unit),
                unit,
                value,
            })
        })
        .collect()
}

/// Read the VSB key. `Ok(empty)` when the key exists but holds nothing; `Err` when it is absent
/// (HWiNFO never ran with gadget reporting) or unreadable.
#[cfg(target_os = "windows")]
pub fn read_live() -> Result<Vec<Reading>, String> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::types::FromRegValue;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(VSB_SUBKEY, KEY_READ)
        .map_err(|e| format!("HWiNFO gadget key: {e}"))?;
    let mut values: Vec<(String, String)> = Vec::new();
    for item in key.enum_values() {
        let (name, data) = item.map_err(|e| format!("HWiNFO gadget key: {e}"))?;
        if let Ok(text) = String::from_reg_value(&data) {
            values.push((name, text));
        }
    }
    Ok(parse_entries(&values))
}

#[cfg(not(target_os = "windows"))]
pub fn read_live() -> Result<Vec<Reading>, String> {
    Err("HWiNFO gadget reporting is Windows-only".into())
}

/// HWiNFO's own `EnableVSB` flag, so the status line can tell "off" from "never configured".
/// `None` when HWiNFO has no settings key at all.
#[cfg(target_os = "windows")]
pub fn gadget_enabled() -> Option<bool> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu.open_subkey_with_flags(SENSORS_SUBKEY, KEY_READ).ok()?;
    let v: u32 = key.get_value("EnableVSB").ok()?;
    Some(v != 0)
}

#[cfg(not(target_os = "windows"))]
pub fn gadget_enabled() -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn parses_the_owners_gadget_key_shape() {
        let readings = parse_entries(&kv(&[
            ("Color0", "ff0000"),
            ("Sensor1", "CPU [#0]: AMD Ryzen 9 9950X3D: Enhanced"),
            ("Label1", "CPU (Tctl/Tdie)"),
            ("Value1", "63.8 \u{b0}C"),
            ("ValueRaw1", "63.8"),
            ("Sensor0", "CPU [#0]: AMD Ryzen 9 9950X3D"),
            ("Label0", "Core Clocks"),
            ("Value0", "3,605.2 MHz"),
            ("ValueRaw0", "3605.2"),
            ("Sensor2", "CPU [#0]: AMD Ryzen 9 9950X3D: Enhanced"),
            ("Label2", "CPU Package Power"),
            ("Value2", "99.511 W"),
            ("ValueRaw2", "99.511"),
            ("Label8", "GPU Memory Allocated"),
            ("Value8", "3,826 MB"),
            ("ValueRaw8", "3826"),
        ]));
        assert_eq!(readings.len(), 4);
        // Ordered by HWiNFO's index, not by registry enumeration order.
        assert_eq!(readings[0].label, "Core Clocks");
        assert_eq!(readings[0].unit, "MHz");
        assert_eq!(readings[0].kind, ReadingKind::Clock);
        assert_eq!(readings[0].value, 3605.2);
        assert_eq!(readings[0].sensor, "CPU [#0]: AMD Ryzen 9 9950X3D");
        assert_eq!(readings[1].label, "CPU (Tctl/Tdie)");
        assert_eq!(readings[1].unit, "\u{b0}C");
        assert_eq!(readings[1].kind, ReadingKind::Temp);
        assert_eq!(readings[2].value, 99.511);
        assert_eq!(readings[2].kind, ReadingKind::Power);
        assert_eq!(readings[3].unit, "MB");
        assert_eq!(readings[3].kind, ReadingKind::Other);
        assert_eq!(readings[3].sensor, "");
    }

    #[test]
    fn entries_without_label_or_raw_value_are_skipped() {
        let readings = parse_entries(&kv(&[
            ("Label0", "No raw"),
            ("Value0", "1 W"),
            ("ValueRaw1", "2"),
            ("Label2", ""),
            ("ValueRaw2", "3"),
            ("Label3", "Not a number"),
            ("ValueRaw3", "n/a"),
            ("Label4", "Infinite"),
            ("ValueRaw4", "inf"),
            ("Label5", "Comma"),
            ("ValueRaw5", "1,5"),
            ("Label999", "Past the cap"),
            ("ValueRaw999", "1"),
            ("NoIndex", "x"),
        ]));
        assert_eq!(readings.len(), 1);
        assert_eq!(readings[0].label, "Comma");
        assert_eq!(readings[0].value, 1.5);
    }

    #[test]
    fn unit_is_the_trailing_non_numeric_token() {
        assert_eq!(unit_of("3,605.2 MHz"), "MHz");
        assert_eq!(unit_of("63.8 \u{b0}C"), "\u{b0}C");
        assert_eq!(unit_of("11.0 %"), "%");
        assert_eq!(unit_of("42"), "");
        assert_eq!(unit_of("1 000"), "");
        assert_eq!(unit_of(""), "");
    }

    #[test]
    fn indexed_names_split() {
        assert_eq!(split_indexed("Label12"), Some(("Label", 12)));
        assert_eq!(split_indexed("ValueRaw0"), Some(("ValueRaw", 0)));
        assert_eq!(split_indexed("Color"), None);
        assert_eq!(split_indexed("Label99999999999999999999"), None);
    }

    /// Manual check against the real HWiNFO gadget key:
    /// `cargo test fork::hwinfo::registry::tests::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_gadget_key_parses() {
        println!("EnableVSB = {:?}", gadget_enabled());
        match read_live() {
            Ok(readings) => {
                for r in &readings {
                    println!("  [{}] {} = {} {}", r.sensor, r.label, r.value, r.unit);
                }
                assert!(!readings.is_empty());
            }
            Err(e) => println!("not available: {e}"),
        }
    }
}
