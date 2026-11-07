//! HWiNFO shared memory (`Global\HWiNFO_SENS_SM2`, the layout HWiNFO's SDK and the Rainmeter plugin
//! use). The segment is a `#pragma pack(1)` header followed by a sensor table and a reading table
//! whose offsets, element sizes and counts the header declares — so the parser trusts nothing it
//! has not bounds-checked against the bytes it was given. The pure `parse_snapshot` is tested on
//! synthetic buffers; the Win32 edge (`read_live`) maps the segment read-only and copies it out.
//!
//! Reader notes: HWiNFO rewrites the values in place at its own poll rate; we copy the whole region
//! once per tick and parse the copy, so at worst one tick sees a torn double (one bad sample, the
//! next tick heals it). The SDK's `Global\HWiNFO_SM2_MUTEX` is deliberately not taken: a reader that
//! blocks on HWiNFO's mutex can stall the writer, and a single torn sample is the cheaper failure.

use super::model::{Reading, ReadingKind, cap_text};

/// `"HWiS"` as the little-endian DWORD HWiNFO writes (bytes `48 57 69 53`).
pub const SIGNATURE: u32 = 0x5369_5748;
/// The same four letters stored the other way round — accepted so a byte-order slip in the SDK
/// header never reads a live segment as garbage.
pub const SIGNATURE_SWAPPED: u32 = 0x4857_6953;
/// HWiNFO stamps this while it shuts down: the tables may be half-torn down.
pub const SIGNATURE_DEAD: u32 = 0xDEAD;

pub const HEADER_LEN: usize = 44;
/// `dwSensorID + dwSensorInst + szSensorNameOrig[128] + szSensorNameUser[128]`.
pub const MIN_SENSOR_ELEM: usize = 4 + 4 + 128 + 128;
/// `tReading + dwSensorIndex + dwReadingID + szLabelOrig[128] + szLabelUser[128] + szUnit[16] +
/// Value + ValueMin + ValueMax + ValueAvg`.
pub const MIN_READING_ELEM: usize = 4 + 4 + 4 + 128 + 128 + 16 + 4 * 8;
/// Element-count caps: HWiNFO on a big workstation has a few hundred sensors and a few thousand
/// readings; anything beyond this is a corrupt header, not hardware.
pub const MAX_SENSORS: usize = 4096;
pub const MAX_READINGS: usize = 16384;
/// Biggest region we will copy (caps the memcpy even if the header lies about counts).
pub const MAX_REGION: usize = 64 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum SnapshotError {
    /// Fewer bytes than a header.
    TooShort,
    BadSignature(u32),
    /// HWiNFO is shutting down (signature `0xDEAD`).
    ShuttingDown,
    /// A declared offset/size/count does not fit the buffer or the SDK minimums.
    BadLayout(&'static str),
}

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooShort => write!(f, "shared memory shorter than its header"),
            Self::BadSignature(s) => write!(f, "shared memory signature 0x{s:08x} is not HWiS"),
            Self::ShuttingDown => write!(f, "HWiNFO is shutting down"),
            Self::BadLayout(what) => write!(f, "shared memory layout rejected: {what}"),
        }
    }
}

/// A parsed segment.
#[derive(Debug, PartialEq)]
pub struct Snapshot {
    pub version: u32,
    pub revision: u32,
    /// HWiNFO's own poll timestamp (`__time64_t`, seconds).
    pub poll_time: i64,
    pub readings: Vec<Reading>,
}

fn u32_at(buf: &[u8], at: usize) -> Option<u32> {
    buf.get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

fn i64_at(buf: &[u8], at: usize) -> Option<i64> {
    buf.get(at..at + 8).map(|b| {
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        i64::from_le_bytes(a)
    })
}

fn f64_at(buf: &[u8], at: usize) -> Option<f64> {
    buf.get(at..at + 8).map(|b| {
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        f64::from_le_bytes(a)
    })
}

/// A fixed-width, NUL-terminated C string from HWiNFO: stop at the first NUL, decode lossily
/// (HWiNFO writes the ANSI code page; `°` lands as U+FFFD at worst), trim and cap.
fn cstr_at(buf: &[u8], at: usize, width: usize) -> Option<String> {
    let field = buf.get(at..at + width)?;
    let end = field.iter().position(|&b| b == 0).unwrap_or(width);
    Some(cap_text(&String::from_utf8_lossy(&field[..end])))
}

/// The user-renamed string when the user set one, else the original.
fn user_or_orig(user: String, orig: String) -> String {
    if user.is_empty() { orig } else { user }
}

/// Validate that `count` elements of `size` bytes starting at `offset` lie inside `len`.
fn section_fits(offset: u32, size: u32, count: u32, len: usize) -> bool {
    let end = (offset as usize).saturating_add((size as usize).saturating_mul(count as usize));
    end <= len
}

/// Parse a copy of the shared-memory segment. Every offset the header declares is checked against
/// `buf.len()` before use; a header that does not add up is rejected as a whole (fail closed).
pub fn parse_snapshot(buf: &[u8]) -> Result<Snapshot, SnapshotError> {
    if buf.len() < HEADER_LEN {
        return Err(SnapshotError::TooShort);
    }
    let sig = u32_at(buf, 0).ok_or(SnapshotError::TooShort)?;
    if sig == SIGNATURE_DEAD {
        return Err(SnapshotError::ShuttingDown);
    }
    if sig != SIGNATURE && sig != SIGNATURE_SWAPPED {
        return Err(SnapshotError::BadSignature(sig));
    }
    let version = u32_at(buf, 4).unwrap_or(0);
    let revision = u32_at(buf, 8).unwrap_or(0);
    let poll_time = i64_at(buf, 12).unwrap_or(0);
    let sens_off = u32_at(buf, 20).unwrap_or(0);
    let sens_size = u32_at(buf, 24).unwrap_or(0);
    let sens_n = u32_at(buf, 28).unwrap_or(0);
    let read_off = u32_at(buf, 32).unwrap_or(0);
    let read_size = u32_at(buf, 36).unwrap_or(0);
    let read_n = u32_at(buf, 40).unwrap_or(0);

    if (sens_size as usize) < MIN_SENSOR_ELEM {
        return Err(SnapshotError::BadLayout("sensor element too small"));
    }
    if (read_size as usize) < MIN_READING_ELEM {
        return Err(SnapshotError::BadLayout("reading element too small"));
    }
    if sens_n as usize > MAX_SENSORS {
        return Err(SnapshotError::BadLayout("too many sensors"));
    }
    if read_n as usize > MAX_READINGS {
        return Err(SnapshotError::BadLayout("too many readings"));
    }
    if (sens_off as usize) < HEADER_LEN || !section_fits(sens_off, sens_size, sens_n, buf.len()) {
        return Err(SnapshotError::BadLayout(
            "sensor section outside the buffer",
        ));
    }
    if (read_off as usize) < HEADER_LEN || !section_fits(read_off, read_size, read_n, buf.len()) {
        return Err(SnapshotError::BadLayout(
            "reading section outside the buffer",
        ));
    }

    let mut sensors: Vec<String> = Vec::with_capacity(sens_n as usize);
    for i in 0..sens_n as usize {
        let at = sens_off as usize + i * sens_size as usize;
        let orig = cstr_at(buf, at + 8, 128).ok_or(SnapshotError::TooShort)?;
        let user = cstr_at(buf, at + 136, 128).ok_or(SnapshotError::TooShort)?;
        sensors.push(user_or_orig(user, orig));
    }

    let mut readings = Vec::with_capacity(read_n as usize);
    for i in 0..read_n as usize {
        let at = read_off as usize + i * read_size as usize;
        let kind = ReadingKind::from_sdk(u32_at(buf, at).ok_or(SnapshotError::TooShort)?);
        let sensor_index = u32_at(buf, at + 4).ok_or(SnapshotError::TooShort)? as usize;
        let label_orig = cstr_at(buf, at + 12, 128).ok_or(SnapshotError::TooShort)?;
        let label_user = cstr_at(buf, at + 140, 128).ok_or(SnapshotError::TooShort)?;
        let unit = cstr_at(buf, at + 268, 16).ok_or(SnapshotError::TooShort)?;
        let value = f64_at(buf, at + 284).ok_or(SnapshotError::TooShort)?;
        if !value.is_finite() {
            continue;
        }
        let label = user_or_orig(label_user, label_orig);
        if label.is_empty() {
            continue;
        }
        let sensor = sensors
            .get(sensor_index)
            .cloned()
            .unwrap_or_else(|| "?".to_string());
        readings.push(Reading {
            sensor,
            label,
            unit,
            kind,
            value,
        });
    }
    Ok(Snapshot {
        version,
        revision,
        poll_time,
        readings,
    })
}

/// Why a live read produced nothing.
#[derive(Debug, PartialEq, Eq)]
pub enum LiveError {
    /// The segment does not exist: HWiNFO is not running or Shared Memory Support is off.
    NotFound,
    /// Another Win32 failure (access denied, mapping failed), with the error code.
    Os(u32),
    Parse(SnapshotError),
}

impl std::fmt::Display for LiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "HWiNFO shared memory not found"),
            Self::Os(code) => write!(f, "HWiNFO shared memory: Win32 error {code}"),
            Self::Parse(e) => write!(f, "{e}"),
        }
    }
}

/// Map the segment read-only, copy it, unmap, parse. Never writes, never blocks on HWiNFO.
#[cfg(target_os = "windows")]
pub fn read_live() -> Result<Snapshot, LiveError> {
    use windows::Win32::Foundation::{CloseHandle, ERROR_FILE_NOT_FOUND};
    use windows::Win32::System::Memory::{
        FILE_MAP_READ, MEMORY_BASIC_INFORMATION, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile,
        VirtualQuery,
    };
    use windows::core::w;

    // SAFETY: plain Win32 calls with valid arguments; the handle and view are released below on
    // every path.
    let handle = unsafe { OpenFileMappingW(FILE_MAP_READ.0, false, w!("Global\\HWiNFO_SENS_SM2")) }
        .map_err(|e| {
            if e.code() == ERROR_FILE_NOT_FOUND.to_hresult() {
                LiveError::NotFound
            } else {
                LiveError::Os(e.code().0 as u32)
            }
        })?;
    let view = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0) };
    if view.Value.is_null() {
        let code = windows::core::Error::from_thread().code().0 as u32;
        let _ = unsafe { CloseHandle(handle) };
        return Err(LiveError::Os(code));
    }
    let mut info = MEMORY_BASIC_INFORMATION::default();
    let got = unsafe {
        VirtualQuery(
            Some(view.Value.cast_const()),
            &mut info,
            std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
        )
    };
    let region = if got == 0 {
        0
    } else {
        info.RegionSize.min(MAX_REGION)
    };
    // SAFETY: `view` is a readable mapping of at least `region` bytes (VirtualQuery reported the
    // committed region starting at the view base); we copy it out before unmapping.
    let bytes: Vec<u8> = if region == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(view.Value.cast::<u8>().cast_const(), region) }.to_vec()
    };
    let _ = unsafe { UnmapViewOfFile(view) };
    let _ = unsafe { CloseHandle(handle) };
    parse_snapshot(&bytes).map_err(LiveError::Parse)
}

#[cfg(not(target_os = "windows"))]
pub fn read_live() -> Result<Snapshot, LiveError> {
    Err(LiveError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a segment the way HWiNFO lays it out, with the given sensors and readings.
    /// `readings`: (type, sensor_index, label, unit, value).
    pub(super) fn build(
        sig: u32,
        sensors: &[&str],
        readings: &[(u32, u32, &str, &str, f64)],
    ) -> Vec<u8> {
        let sens_size = MIN_SENSOR_ELEM;
        let read_size = MIN_READING_ELEM;
        let sens_off = HEADER_LEN;
        let read_off = sens_off + sens_size * sensors.len();
        let mut buf = vec![0u8; read_off + read_size * readings.len()];
        buf[0..4].copy_from_slice(&sig.to_le_bytes());
        buf[4..8].copy_from_slice(&2u32.to_le_bytes());
        buf[8..12].copy_from_slice(&7u32.to_le_bytes());
        buf[12..20].copy_from_slice(&1_762_540_000i64.to_le_bytes());
        buf[20..24].copy_from_slice(&(sens_off as u32).to_le_bytes());
        buf[24..28].copy_from_slice(&(sens_size as u32).to_le_bytes());
        buf[28..32].copy_from_slice(&(sensors.len() as u32).to_le_bytes());
        buf[32..36].copy_from_slice(&(read_off as u32).to_le_bytes());
        buf[36..40].copy_from_slice(&(read_size as u32).to_le_bytes());
        buf[40..44].copy_from_slice(&(readings.len() as u32).to_le_bytes());
        for (i, name) in sensors.iter().enumerate() {
            let at = sens_off + i * sens_size;
            buf[at..at + 4].copy_from_slice(&(100 + i as u32).to_le_bytes());
            let b = name.as_bytes();
            buf[at + 8..at + 8 + b.len()].copy_from_slice(b);
        }
        for (i, (kind, sidx, label, unit, value)) in readings.iter().enumerate() {
            let at = read_off + i * read_size;
            buf[at..at + 4].copy_from_slice(&kind.to_le_bytes());
            buf[at + 4..at + 8].copy_from_slice(&sidx.to_le_bytes());
            buf[at + 8..at + 12].copy_from_slice(&(i as u32).to_le_bytes());
            let b = label.as_bytes();
            buf[at + 12..at + 12 + b.len()].copy_from_slice(b);
            let u = unit.as_bytes();
            buf[at + 268..at + 268 + u.len()].copy_from_slice(u);
            buf[at + 284..at + 292].copy_from_slice(&value.to_le_bytes());
        }
        buf
    }

    #[test]
    fn parses_a_well_formed_segment() {
        let buf = build(
            SIGNATURE,
            &[
                "CPU [#0]: AMD Ryzen 9 9950X3D: Enhanced",
                "GPU [#0]: NVIDIA",
            ],
            &[
                (1, 0, "CPU (Tctl/Tdie)", "\u{b0}C", 63.8),
                (5, 0, "CPU Package Power", "W", 92.7),
                (6, 0, "Core 0 T0 Effective Clock", "MHz", 4877.5),
                (1, 1, "GPU Temperature", "\u{b0}C", 30.4),
            ],
        );
        let snap = parse_snapshot(&buf).unwrap();
        assert_eq!(snap.version, 2);
        assert_eq!(snap.revision, 7);
        assert_eq!(snap.poll_time, 1_762_540_000);
        assert_eq!(snap.readings.len(), 4);
        assert_eq!(
            snap.readings[0].sensor,
            "CPU [#0]: AMD Ryzen 9 9950X3D: Enhanced"
        );
        assert_eq!(snap.readings[0].label, "CPU (Tctl/Tdie)");
        assert_eq!(snap.readings[0].unit, "\u{b0}C");
        assert_eq!(snap.readings[0].kind, ReadingKind::Temp);
        assert_eq!(snap.readings[0].value, 63.8);
        assert_eq!(snap.readings[2].kind, ReadingKind::Clock);
        assert_eq!(snap.readings[3].sensor, "GPU [#0]: NVIDIA");
    }

    #[test]
    fn user_labels_override_originals_and_bad_sensor_index_is_tolerated() {
        let mut buf = build(
            SIGNATURE,
            &["CPU"],
            &[(1, 0, "Orig", "C", 1.0), (1, 9, "X", "C", 2.0)],
        );
        // Write a user label + user sensor name into the second string of each element.
        let sens_at = HEADER_LEN + 136;
        buf[sens_at..sens_at + 5].copy_from_slice(b"MyCPU");
        let read_at = HEADER_LEN + MIN_SENSOR_ELEM + 140;
        buf[read_at..read_at + 4].copy_from_slice(b"Mine");
        let snap = parse_snapshot(&buf).unwrap();
        assert_eq!(snap.readings[0].sensor, "MyCPU");
        assert_eq!(snap.readings[0].label, "Mine");
        assert_eq!(snap.readings[1].sensor, "?");
    }

    #[test]
    fn swapped_signature_is_accepted_and_dead_or_foreign_is_not() {
        let ok = build(SIGNATURE_SWAPPED, &["CPU"], &[(1, 0, "T", "C", 1.0)]);
        assert_eq!(parse_snapshot(&ok).unwrap().readings.len(), 1);
        let dead = build(SIGNATURE_DEAD, &["CPU"], &[]);
        assert_eq!(parse_snapshot(&dead), Err(SnapshotError::ShuttingDown));
        let foreign = build(0x1234_5678, &["CPU"], &[]);
        assert_eq!(
            parse_snapshot(&foreign),
            Err(SnapshotError::BadSignature(0x1234_5678))
        );
    }

    #[test]
    fn short_buffers_are_rejected_not_read_past() {
        assert_eq!(parse_snapshot(&[]), Err(SnapshotError::TooShort));
        assert_eq!(
            parse_snapshot(&[0u8; HEADER_LEN - 1]),
            Err(SnapshotError::TooShort)
        );
        // A valid header whose reading table is cut off by one byte.
        let full = build(SIGNATURE, &["CPU"], &[(1, 0, "T", "C", 1.0)]);
        let cut = &full[..full.len() - 1];
        assert_eq!(
            parse_snapshot(cut),
            Err(SnapshotError::BadLayout(
                "reading section outside the buffer"
            ))
        );
    }

    #[test]
    fn lying_headers_are_rejected() {
        let mut buf = build(SIGNATURE, &["CPU"], &[(1, 0, "T", "C", 1.0)]);
        // Sensor element smaller than the SDK struct.
        buf[24..28].copy_from_slice(&100u32.to_le_bytes());
        assert_eq!(
            parse_snapshot(&buf),
            Err(SnapshotError::BadLayout("sensor element too small"))
        );
        let mut buf = build(SIGNATURE, &["CPU"], &[(1, 0, "T", "C", 1.0)]);
        buf[36..40].copy_from_slice(&100u32.to_le_bytes());
        assert_eq!(
            parse_snapshot(&buf),
            Err(SnapshotError::BadLayout("reading element too small"))
        );
        // Counts past the caps, and a count that overflows the arithmetic.
        let mut buf = build(SIGNATURE, &["CPU"], &[(1, 0, "T", "C", 1.0)]);
        buf[28..32].copy_from_slice(&(MAX_SENSORS as u32 + 1).to_le_bytes());
        assert_eq!(
            parse_snapshot(&buf),
            Err(SnapshotError::BadLayout("too many sensors"))
        );
        let mut buf = build(SIGNATURE, &["CPU"], &[(1, 0, "T", "C", 1.0)]);
        buf[40..44].copy_from_slice(&(MAX_READINGS as u32 + 1).to_le_bytes());
        assert_eq!(
            parse_snapshot(&buf),
            Err(SnapshotError::BadLayout("too many readings"))
        );
        // Offsets pointing into the header or past the end.
        let mut buf = build(SIGNATURE, &["CPU"], &[(1, 0, "T", "C", 1.0)]);
        buf[20..24].copy_from_slice(&4u32.to_le_bytes());
        assert_eq!(
            parse_snapshot(&buf),
            Err(SnapshotError::BadLayout(
                "sensor section outside the buffer"
            ))
        );
        let mut buf = build(SIGNATURE, &["CPU"], &[(1, 0, "T", "C", 1.0)]);
        buf[32..36].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(
            parse_snapshot(&buf),
            Err(SnapshotError::BadLayout(
                "reading section outside the buffer"
            ))
        );
    }

    #[test]
    fn non_finite_values_and_empty_labels_are_dropped() {
        let buf = build(
            SIGNATURE,
            &["CPU"],
            &[
                (1, 0, "T", "C", f64::NAN),
                (1, 0, "", "C", 1.0),
                (1, 0, "Keep", "C", 2.0),
            ],
        );
        let snap = parse_snapshot(&buf).unwrap();
        assert_eq!(snap.readings.len(), 1);
        assert_eq!(snap.readings[0].label, "Keep");
    }

    #[test]
    fn strings_stop_at_nul_and_decode_lossily() {
        let mut buf = build(SIGNATURE, &["CPU"], &[(1, 0, "Label", "C", 1.0)]);
        // Overwrite the unit with an ANSI degree sign (0xB0) that is not valid UTF-8.
        let unit_at = HEADER_LEN + MIN_SENSOR_ELEM + 268;
        buf[unit_at] = 0xB0;
        buf[unit_at + 1] = b'C';
        buf[unit_at + 2] = 0;
        buf[unit_at + 3] = b'!';
        let snap = parse_snapshot(&buf).unwrap();
        assert_eq!(snap.readings[0].unit, "\u{FFFD}C");
        assert_eq!(cstr_at(&[b'a', b'b', 0, b'c'], 0, 4), Some("ab".into()));
        assert_eq!(cstr_at(b"a", 0, 4), None);
    }

    #[test]
    fn errors_display_for_the_status_line() {
        assert_eq!(
            SnapshotError::BadSignature(0x10).to_string(),
            "shared memory signature 0x00000010 is not HWiS"
        );
        assert_eq!(
            LiveError::NotFound.to_string(),
            "HWiNFO shared memory not found"
        );
        assert_eq!(
            LiveError::Os(5).to_string(),
            "HWiNFO shared memory: Win32 error 5"
        );
        assert_eq!(
            LiveError::Parse(SnapshotError::ShuttingDown).to_string(),
            "HWiNFO is shutting down"
        );
        assert!(SnapshotError::TooShort.to_string().contains("shorter"));
        assert!(SnapshotError::BadLayout("x").to_string().contains("x"));
    }

    /// Manual check against the real HWiNFO (needs HWiNFO64 running with Shared Memory Support on):
    /// `cargo test fork::hwinfo::shared_mem::tests::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_segment_parses() {
        match read_live() {
            Ok(snap) => {
                println!(
                    "HWiNFO v{} rev{} poll_time={} readings={}",
                    snap.version,
                    snap.revision,
                    snap.poll_time,
                    snap.readings.len()
                );
                for r in snap.readings.iter().take(20) {
                    println!("  [{}] {} = {} {}", r.sensor, r.label, r.value, r.unit);
                }
                assert!(!snap.readings.is_empty());
            }
            Err(e) => println!("not available: {e}"),
        }
    }
}
