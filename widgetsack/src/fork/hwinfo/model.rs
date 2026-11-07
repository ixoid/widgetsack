//! Pure domain for the HWiNFO source: the backend-neutral `Reading`, stable slugs for the catalog,
//! and the label heuristics that derive the well-known `hw.cpu.*` ids. No Windows, no I/O — both the
//! shared-memory and the registry parser produce `Reading`s and everything downstream is tested here.

use serde::Serialize;

use crate::sensors::SensorSample;

/// HWiNFO's `SENSOR_READING_TYPE`. The registry gadget carries no type, so `from_unit` infers it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadingKind {
    None,
    Temp,
    Volt,
    Fan,
    Current,
    Power,
    Clock,
    Usage,
    Other,
}

impl ReadingKind {
    /// The SDK enum value (shared memory). Unknown values map to `Other`, never panic.
    pub fn from_sdk(raw: u32) -> Self {
        match raw {
            0 => Self::None,
            1 => Self::Temp,
            2 => Self::Volt,
            3 => Self::Fan,
            4 => Self::Current,
            5 => Self::Power,
            6 => Self::Clock,
            7 => Self::Usage,
            _ => Self::Other,
        }
    }

    /// Best-effort kind from a unit string (`°C`, `MHz`, `W`, …) for the registry path.
    pub fn from_unit(unit: &str) -> Self {
        match unit.trim() {
            "°C" | "C" | "°F" | "F" => Self::Temp,
            "V" | "mV" => Self::Volt,
            "RPM" => Self::Fan,
            "A" | "mA" => Self::Current,
            "W" | "mW" => Self::Power,
            "MHz" | "GHz" => Self::Clock,
            "%" => Self::Usage,
            "" => Self::None,
            _ => Self::Other,
        }
    }
}

/// One HWiNFO reading, as either backend reports it. `sensor` is the owning device line
/// ("CPU [#0]: AMD Ryzen 9 9950X3D: Enhanced"), `label` the reading name ("CPU (Tctl/Tdie)").
#[derive(Clone, Debug, PartialEq)]
pub struct Reading {
    pub sensor: String,
    pub label: String,
    pub unit: String,
    pub kind: ReadingKind,
    pub value: f64,
}

/// A catalog row for the settings pane: the reading plus its stable `hw.<slug>` id. camelCase on
/// the wire (`HwinfoStatus.readings` ↔ `hwinfo-types.ts`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub slug: String,
    pub id: String,
    pub label: String,
    pub sensor: String,
    pub unit: String,
    pub value: f64,
}

/// Longest string we keep from HWiNFO (its own buffers are 128 chars; the cap also bounds slugs).
pub const MAX_TEXT_LEN: usize = 128;
/// Longest slug the config accepts back from the webview (a slug is derived from a ≤128-char label
/// plus at most a short sensor prefix and a numeric suffix).
pub const MAX_SLUG_LEN: usize = 160;
/// Enabled-list size cap: more than this is a bug or a hostile payload, not a dashboard.
pub const MAX_ENABLED: usize = 256;

pub const MIN_POLL_SECS: u64 = 1;
pub const MAX_POLL_SECS: u64 = 60;
pub const DEFAULT_POLL_SECS: u64 = 2;

pub const STATUS_ID: &str = "hw.status";
pub const CPU_TEMP_ID: &str = "hw.cpu.temp";
pub const CPU_CLOCK_MAX_ID: &str = "hw.cpu.clock.max";
pub const CPU_POWER_ID: &str = "hw.cpu.power";
/// Prefix for the per-core clocks: `hw.cpu.clock.core.<n>`.
pub const CPU_CLOCK_CORE_PREFIX: &str = "hw.cpu.clock.core.";

/// Clamp a configured poll period into the supported range.
pub fn clamp_poll(secs: u64) -> u64 {
    secs.clamp(MIN_POLL_SECS, MAX_POLL_SECS)
}

/// Trim + cap text that came from HWiNFO (or from the webview) so it can never blow up a sample
/// batch or a slug. Counts chars, not bytes, so a multi-byte `°` is not split.
pub fn cap_text(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= MAX_TEXT_LEN {
        t.to_string()
    } else {
        t.chars().take(MAX_TEXT_LEN).collect()
    }
}

/// Lower-case ASCII slug: alphanumerics kept, every other run collapsed to one `-`, no leading or
/// trailing dash. `"CPU (Tctl/Tdie)"` → `cpu-tctl-tdie`. An empty result becomes `reading`.
pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut dash = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "reading".to_string()
    } else {
        out
    }
}

/// The device part of a HWiNFO sensor line, slugged: `"CPU [#0]: AMD Ryzen 9 9950X3D: Enhanced"` →
/// `cpu-0`. Used as a prefix only when a label repeats across sensors.
pub fn short_sensor(sensor: &str) -> String {
    let head = sensor.split(':').next().unwrap_or(sensor);
    slugify(head)
}

/// Whether a slug coming back from the webview is one we could have produced (so the enabled list
/// can never smuggle arbitrary text into a sensor id).
pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= MAX_SLUG_LEN
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Build the catalog: one entry per reading with a unique, deterministic slug. A label that occurs
/// once is its own slug; a label shared by several sensors is prefixed with the sensor's short name;
/// anything still colliding (same label twice under one sensor) gets `-2`, `-3`, … in input order.
pub fn catalog(readings: &[Reading]) -> Vec<CatalogEntry> {
    let bases: Vec<String> = readings.iter().map(|r| slugify(&r.label)).collect();
    let mut by_base: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for b in &bases {
        *by_base.entry(b.as_str()).or_insert(0) += 1;
    }
    let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(readings.len());
    for (r, base) in readings.iter().zip(bases.iter()) {
        let mut slug = if by_base[base.as_str()] > 1 {
            format!("{}-{}", short_sensor(&r.sensor), base)
        } else {
            base.clone()
        };
        if taken.contains(&slug) {
            let mut n = 2;
            while taken.contains(&format!("{slug}-{n}")) {
                n += 1;
            }
            slug = format!("{slug}-{n}");
        }
        taken.insert(slug.clone());
        out.push(CatalogEntry {
            id: format!("hw.{slug}"),
            slug,
            label: r.label.clone(),
            sensor: r.sensor.clone(),
            unit: r.unit.clone(),
            value: r.value,
        });
    }
    out
}

/// Samples for the catalog entries whose slug the user enabled. Order follows the catalog.
pub fn enabled_samples(catalog: &[CatalogEntry], enabled: &[String], ts: u64) -> Vec<SensorSample> {
    catalog
        .iter()
        .filter(|e| enabled.iter().any(|s| s == &e.slug))
        .map(|e| SensorSample::scalar(e.id.clone(), ts, e.value))
        .collect()
}

fn eq_label(r: &Reading, want: &str) -> bool {
    r.label.eq_ignore_ascii_case(want)
}

/// First reading matching any label in `labels` (in that priority order) with the wanted kind, or
/// — for the registry path, where the kind is inferred — any kind when `kind` is `None`.
fn pick<'a>(readings: &'a [Reading], labels: &[&str], kind: ReadingKind) -> Option<&'a Reading> {
    labels.iter().find_map(|want| {
        readings
            .iter()
            .find(|r| eq_label(r, want) && (r.kind == kind || r.kind == ReadingKind::None))
    })
}

/// What a per-core clock label says: `Core 3 T1 Effective Clock` → effective clock of core 3;
/// `Core 3 Clock (perf #2/16)` → perf clock of core 3. Anything else → `None`.
#[derive(Debug, PartialEq)]
enum CoreClock {
    Effective(usize),
    Perf(usize),
}

fn core_clock_of(label: &str) -> Option<CoreClock> {
    let rest = label.strip_prefix("Core ")?;
    let digits_end = rest.find(|c: char| !c.is_ascii_digit())?;
    let core: usize = rest[..digits_end].parse().ok()?;
    let tail = &rest[digits_end..];
    if tail.starts_with(" T") && tail.ends_with(" Effective Clock") {
        let thread = &tail[2..tail.len() - " Effective Clock".len()];
        if !thread.is_empty() && thread.chars().all(|c| c.is_ascii_digit()) {
            return Some(CoreClock::Effective(core));
        }
        return None;
    }
    if tail == " Effective Clock" {
        return Some(CoreClock::Effective(core));
    }
    if tail.starts_with(" Clock") {
        return Some(CoreClock::Perf(core));
    }
    None
}

/// Per-core clocks in MHz, by core index: effective clocks when HWiNFO exposes them (the max over
/// a core's SMT threads), else the perf clocks. Sorted by core.
fn core_clocks(readings: &[Reading]) -> Vec<(usize, f64)> {
    let mut effective: std::collections::BTreeMap<usize, f64> = Default::default();
    let mut perf: std::collections::BTreeMap<usize, f64> = Default::default();
    for r in readings {
        if !matches!(r.kind, ReadingKind::Clock | ReadingKind::None) || !r.value.is_finite() {
            continue;
        }
        match core_clock_of(&r.label) {
            Some(CoreClock::Effective(c)) => {
                let e = effective.entry(c).or_insert(f64::MIN);
                *e = e.max(r.value);
            }
            Some(CoreClock::Perf(c)) => {
                let e = perf.entry(c).or_insert(f64::MIN);
                *e = e.max(r.value);
            }
            None => {}
        }
    }
    let chosen = if effective.is_empty() {
        perf
    } else {
        effective
    };
    chosen.into_iter().collect()
}

/// The well-known `hw.cpu.*` samples derivable from `readings` by HWiNFO's English labels. Missing
/// readings are skipped, never fabricated. Pure.
pub fn well_known_samples(readings: &[Reading], ts: u64) -> Vec<SensorSample> {
    let mut out = Vec::new();
    if let Some(t) = pick(
        readings,
        &[
            "CPU (Tctl/Tdie)",
            "CPU Tctl/Tdie",
            "CPU Die (average)",
            "CPU CCD1 (Tdie)",
            "CPU Package",
            "CPU Temperature",
            "CPU",
        ],
        ReadingKind::Temp,
    ) && t.value.is_finite()
    {
        out.push(SensorSample::scalar(CPU_TEMP_ID, ts, t.value));
    }
    if let Some(p) = pick(
        readings,
        &["CPU Package Power", "CPU PPT", "CPU Power", "Package Power"],
        ReadingKind::Power,
    ) && p.value.is_finite()
    {
        out.push(SensorSample::scalar(CPU_POWER_ID, ts, p.value));
    }
    let cores = core_clocks(readings);
    let mut max = cores
        .iter()
        .map(|(_, v)| *v)
        .fold(None, |acc: Option<f64>, v| {
            Some(acc.map_or(v, |a| a.max(v)))
        });
    for (core, mhz) in &cores {
        out.push(SensorSample::scalar(
            format!("{CPU_CLOCK_CORE_PREFIX}{core}"),
            ts,
            *mhz,
        ));
    }
    if max.is_none()
        && let Some(c) = pick(
            readings,
            &[
                "Core Effective Clocks",
                "Core Clocks",
                "Average Effective Clock",
            ],
            ReadingKind::Clock,
        )
        && c.value.is_finite()
    {
        max = Some(c.value);
    }
    if let Some(m) = max {
        out.push(SensorSample::scalar(CPU_CLOCK_MAX_ID, ts, m));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sensors::SensorValue;

    fn r(sensor: &str, label: &str, unit: &str, kind: ReadingKind, value: f64) -> Reading {
        Reading {
            sensor: sensor.into(),
            label: label.into(),
            unit: unit.into(),
            kind,
            value,
        }
    }

    fn scalar(samples: &[SensorSample], id: &str) -> Option<f64> {
        samples
            .iter()
            .find(|s| s.sensor == id)
            .map(|s| match s.value {
                SensorValue::Scalar(v) => v,
                _ => panic!("not a scalar"),
            })
    }

    #[test]
    fn slugify_collapses_punctuation_and_never_returns_empty() {
        assert_eq!(slugify("CPU (Tctl/Tdie)"), "cpu-tctl-tdie");
        assert_eq!(
            slugify("  Core 0 T1 Effective Clock "),
            "core-0-t1-effective-clock"
        );
        assert_eq!(slugify("GPU Memory Usage %"), "gpu-memory-usage");
        assert_eq!(slugify("°C"), "c");
        assert_eq!(slugify("///"), "reading");
        assert_eq!(slugify(""), "reading");
    }

    #[test]
    fn short_sensor_keeps_the_device_part_only() {
        assert_eq!(
            short_sensor("CPU [#0]: AMD Ryzen 9 9950X3D: Enhanced"),
            "cpu-0"
        );
        assert_eq!(
            short_sensor("GPU [#0]: NVIDIA GeForce RTX 5090: Palit GeForce RTX 5090"),
            "gpu-0"
        );
        assert_eq!(short_sensor("Memory Timings"), "memory-timings");
    }

    #[test]
    fn valid_slug_accepts_our_shape_and_rejects_the_rest() {
        assert!(valid_slug("cpu-tctl-tdie"));
        assert!(valid_slug("gpu-0-gpu-power-2"));
        assert!(!valid_slug(""));
        assert!(!valid_slug("-leading"));
        assert!(!valid_slug("trailing-"));
        assert!(!valid_slug("Upper"));
        assert!(!valid_slug("has space"));
        assert!(!valid_slug("dots.are.ids"));
        assert!(!valid_slug(&"a".repeat(MAX_SLUG_LEN + 1)));
    }

    #[test]
    fn cap_text_trims_and_limits_by_chars() {
        assert_eq!(cap_text("  CPU  "), "CPU");
        let long = "°".repeat(MAX_TEXT_LEN + 5);
        assert_eq!(cap_text(&long).chars().count(), MAX_TEXT_LEN);
    }

    #[test]
    fn clamp_poll_bounds_the_period() {
        assert_eq!(clamp_poll(0), MIN_POLL_SECS);
        assert_eq!(clamp_poll(2), 2);
        assert_eq!(clamp_poll(10_000), MAX_POLL_SECS);
    }

    #[test]
    fn catalog_slugs_are_unique_and_prefixed_only_on_collision() {
        let cpu = "CPU [#0]: AMD Ryzen 9 9950X3D: Enhanced";
        let gpu = "GPU [#0]: NVIDIA GeForce RTX 5090";
        let readings = vec![
            r(cpu, "CPU (Tctl/Tdie)", "°C", ReadingKind::Temp, 63.8),
            r(cpu, "Temperature", "°C", ReadingKind::Temp, 50.0),
            r(gpu, "Temperature", "°C", ReadingKind::Temp, 30.7),
            r(gpu, "Temperature", "°C", ReadingKind::Temp, 31.0),
        ];
        let cat = catalog(&readings);
        let slugs: Vec<&str> = cat.iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(
            slugs,
            vec![
                "cpu-tctl-tdie",
                "cpu-0-temperature",
                "gpu-0-temperature",
                "gpu-0-temperature-2"
            ]
        );
        assert_eq!(cat[0].id, "hw.cpu-tctl-tdie");
        assert_eq!(cat[3].value, 31.0);
        assert!(cat.iter().all(|e| valid_slug(&e.slug)));
    }

    #[test]
    fn enabled_samples_follow_the_catalog_order_and_skip_unknown_slugs() {
        let cat = catalog(&[
            r("CPU", "A", "W", ReadingKind::Power, 1.0),
            r("CPU", "B", "W", ReadingKind::Power, 2.0),
        ]);
        let enabled = vec!["b".to_string(), "zzz".to_string(), "a".to_string()];
        let s = enabled_samples(&cat, &enabled, 7);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].sensor, "hw.a");
        assert_eq!(s[1].sensor, "hw.b");
        assert_eq!(s[0].ts_ms, 7);
    }

    #[test]
    fn core_clock_labels_are_classified() {
        assert_eq!(
            core_clock_of("Core 3 T1 Effective Clock"),
            Some(CoreClock::Effective(3))
        );
        assert_eq!(
            core_clock_of("Core 12 T0 Effective Clock"),
            Some(CoreClock::Effective(12))
        );
        assert_eq!(
            core_clock_of("Core 0 Effective Clock"),
            Some(CoreClock::Effective(0))
        );
        assert_eq!(
            core_clock_of("Core 5 Clock (perf #3/16)"),
            Some(CoreClock::Perf(5))
        );
        assert_eq!(core_clock_of("Core 5 Clock"), Some(CoreClock::Perf(5)));
        assert_eq!(core_clock_of("Core Clocks"), None);
        assert_eq!(core_clock_of("Core 1 Tx Effective Clock"), None);
        assert_eq!(core_clock_of("Core 1 VID"), None);
        assert_eq!(core_clock_of("Uncore Clock"), None);
    }

    #[test]
    fn well_known_from_a_shared_memory_style_catalog() {
        let cpu = "CPU [#0]: AMD Ryzen 9 9950X3D: Enhanced";
        let readings = vec![
            r(cpu, "CPU (Tctl/Tdie)", "°C", ReadingKind::Temp, 63.8),
            r(cpu, "CPU Package", "°C", ReadingKind::Temp, 60.0),
            r(cpu, "CPU Package Power", "W", ReadingKind::Power, 92.7),
            r(
                cpu,
                "Core 0 T0 Effective Clock",
                "MHz",
                ReadingKind::Clock,
                4800.0,
            ),
            r(
                cpu,
                "Core 0 T1 Effective Clock",
                "MHz",
                ReadingKind::Clock,
                4900.0,
            ),
            r(
                cpu,
                "Core 1 T0 Effective Clock",
                "MHz",
                ReadingKind::Clock,
                3000.0,
            ),
            r(
                cpu,
                "Core 1 T1 Effective Clock",
                "MHz",
                ReadingKind::Clock,
                2900.0,
            ),
            r(
                cpu,
                "Core 0 Clock (perf #1/16)",
                "MHz",
                ReadingKind::Clock,
                5700.0,
            ),
            r(cpu, "Core Clocks", "MHz", ReadingKind::Clock, 5700.0),
        ];
        let s = well_known_samples(&readings, 1);
        assert_eq!(scalar(&s, CPU_TEMP_ID), Some(63.8));
        assert_eq!(scalar(&s, CPU_POWER_ID), Some(92.7));
        // Effective clocks win over perf clocks; a core's value is the max over its threads.
        assert_eq!(scalar(&s, "hw.cpu.clock.core.0"), Some(4900.0));
        assert_eq!(scalar(&s, "hw.cpu.clock.core.1"), Some(3000.0));
        assert_eq!(scalar(&s, CPU_CLOCK_MAX_ID), Some(4900.0));
        assert_eq!(s.len(), 5);
    }

    #[test]
    fn well_known_from_the_registry_gadget_subset() {
        // Exactly what the owner's HWiNFO exposes via the VSB key (kinds inferred from units).
        let cpu = "CPU [#0]: AMD Ryzen 9 9950X3D: Enhanced";
        let readings = vec![
            r(
                "CPU [#0]: AMD Ryzen 9 9950X3D",
                "Core Clocks",
                "MHz",
                ReadingKind::Clock,
                3605.2,
            ),
            r(cpu, "CPU (Tctl/Tdie)", "°C", ReadingKind::Temp, 63.8),
            r(cpu, "CPU Package Power", "W", ReadingKind::Power, 99.511),
            r(
                "GPU [#0]: NVIDIA",
                "GPU Temperature",
                "°C",
                ReadingKind::Temp,
                30.7,
            ),
        ];
        let s = well_known_samples(&readings, 1);
        assert_eq!(scalar(&s, CPU_TEMP_ID), Some(63.8));
        assert_eq!(scalar(&s, CPU_POWER_ID), Some(99.511));
        assert_eq!(scalar(&s, CPU_CLOCK_MAX_ID), Some(3605.2));
        assert!(scalar(&s, "hw.cpu.clock.core.0").is_none());
        assert_eq!(s.len(), 3);
    }

    #[test]
    fn well_known_falls_back_to_perf_clocks_and_skips_non_finite() {
        let cpu = "CPU [#0]";
        let readings = vec![
            r(
                cpu,
                "Core 0 Clock (perf #1/2)",
                "MHz",
                ReadingKind::Clock,
                5000.0,
            ),
            r(
                cpu,
                "Core 1 Clock (perf #2/2)",
                "MHz",
                ReadingKind::Clock,
                f64::NAN,
            ),
            r(
                cpu,
                "CPU (Tctl/Tdie)",
                "°C",
                ReadingKind::Temp,
                f64::INFINITY,
            ),
            // Right label, wrong kind: a "CPU Package Power" voltage must not become the power.
            r(cpu, "CPU Package Power", "V", ReadingKind::Volt, 1.2),
        ];
        let s = well_known_samples(&readings, 1);
        assert_eq!(scalar(&s, "hw.cpu.clock.core.0"), Some(5000.0));
        assert!(scalar(&s, "hw.cpu.clock.core.1").is_none());
        assert_eq!(scalar(&s, CPU_CLOCK_MAX_ID), Some(5000.0));
        assert!(scalar(&s, CPU_TEMP_ID).is_none());
        assert!(scalar(&s, CPU_POWER_ID).is_none());
    }

    #[test]
    fn well_known_is_empty_without_cpu_readings() {
        let readings = vec![r(
            "GPU [#0]",
            "GPU Temperature",
            "°C",
            ReadingKind::Temp,
            30.0,
        )];
        assert!(well_known_samples(&readings, 1).is_empty());
        assert!(well_known_samples(&[], 1).is_empty());
    }

    #[test]
    fn reading_kind_from_sdk_and_unit() {
        assert_eq!(ReadingKind::from_sdk(1), ReadingKind::Temp);
        assert_eq!(ReadingKind::from_sdk(6), ReadingKind::Clock);
        assert_eq!(ReadingKind::from_sdk(99), ReadingKind::Other);
        assert_eq!(ReadingKind::from_unit("°C"), ReadingKind::Temp);
        assert_eq!(ReadingKind::from_unit(" MHz "), ReadingKind::Clock);
        assert_eq!(ReadingKind::from_unit("W"), ReadingKind::Power);
        assert_eq!(ReadingKind::from_unit("%"), ReadingKind::Usage);
        assert_eq!(ReadingKind::from_unit("RPM"), ReadingKind::Fan);
        assert_eq!(ReadingKind::from_unit("V"), ReadingKind::Volt);
        assert_eq!(ReadingKind::from_unit("A"), ReadingKind::Current);
        assert_eq!(ReadingKind::from_unit("MB"), ReadingKind::Other);
        assert_eq!(ReadingKind::from_unit(""), ReadingKind::None);
    }
}
