//! Binary messages of the camera stream channel (pure, no IO). Media crosses the Tauri `Channel` as
//! `InvokeResponseBody::Raw`; the client parser (`camera-protocol.ts`) reads the same layout and is
//! pinned by the same golden vector (`testdata/framing-golden.hex`).
//!
//! Layout, all integers little-endian:
//! ```text
//! common header (8 B): u8 kind (1=CONFIG, 2=FRAME) | u8 flags | u16 reserved=0 | u32 seq
//! FRAME : flags bit0 = keyframe | u64 ts_us | payload (4-byte length-prefixed NALs, as retina
//!         emits with FrameFormat::MP4)
//! CONFIG: flags = 0, seq = the seq of the next FRAME | u16 width | u16 height | u8 codec_len |
//!         codec ASCII (RFC 6381, e.g. "avc1.4d002a") | avcC (rest of the message)
//! ```

pub const KIND_CONFIG: u8 = 1;
pub const KIND_FRAME: u8 = 2;
pub const FLAG_KEYFRAME: u8 = 0b0000_0001;
pub const HEADER_LEN: usize = 8;
/// Header + `ts_us`.
pub const FRAME_PREFIX_LEN: usize = HEADER_LEN + 8;

fn header(kind: u8, flags: u8, seq: u32, capacity: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(capacity);
    out.push(kind);
    out.push(flags);
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&seq.to_le_bytes());
    out
}

/// CONFIG message. `None` when the codec string cannot be framed (non-ASCII or longer than 255
/// bytes) — the caller treats that as a protocol error rather than sending a broken message.
/// Dimensions above `u16::MAX` are clamped (H.264 dimensions never get there).
pub fn encode_config(
    seq: u32,
    width: u32,
    height: u32,
    codec: &str,
    avcc: &[u8],
) -> Option<Vec<u8>> {
    if !codec.is_ascii() || codec.len() > usize::from(u8::MAX) {
        return None;
    }
    let clamp = |v: u32| u16::try_from(v).unwrap_or(u16::MAX);
    let mut out = header(
        KIND_CONFIG,
        0,
        seq,
        HEADER_LEN + 5 + codec.len() + avcc.len(),
    );
    out.extend_from_slice(&clamp(width).to_le_bytes());
    out.extend_from_slice(&clamp(height).to_le_bytes());
    out.push(codec.len() as u8);
    out.extend_from_slice(codec.as_bytes());
    out.extend_from_slice(avcc);
    Some(out)
}

/// FRAME message carrying one access unit.
pub fn encode_frame(seq: u32, ts_us: u64, is_keyframe: bool, nal_data: &[u8]) -> Vec<u8> {
    let flags = if is_keyframe { FLAG_KEYFRAME } else { 0 };
    let mut out = header(KIND_FRAME, flags, seq, FRAME_PREFIX_LEN + nal_data.len());
    out.extend_from_slice(&ts_us.to_le_bytes());
    out.extend_from_slice(nal_data);
    out
}

/// What an encoded message is, as far as the fan-out needs to know.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Config,
    Frame { key: bool },
}

/// Reads the kind (and keyframe flag) from the common header. `None` for anything that is not a
/// well-formed CONFIG/FRAME header; the fan-out drops such a message rather than guessing.
pub fn classify(message: &[u8]) -> Option<Kind> {
    if message.len() < HEADER_LEN {
        return None;
    }
    match message[0] {
        KIND_CONFIG => Some(Kind::Config),
        KIND_FRAME => Some(Kind::Frame {
            key: message[1] & FLAG_KEYFRAME != 0,
        }),
        _ => None,
    }
}

/// A copy of `message` with its header seq replaced. Seq numbering is per subscriber (see `flow`),
/// so the fan-out stamps each copy; the byte layout itself is unchanged.
pub fn with_seq(message: &[u8], seq: u32) -> Vec<u8> {
    let mut out = message.to_vec();
    if out.len() >= HEADER_LEN {
        out[4..8].copy_from_slice(&seq.to_le_bytes());
    }
    out
}

/// retina's `Timestamp::elapsed()` is in RTP clock ticks (90 kHz for video), not microseconds.
/// Negative values (a packet stamped before the stream start) clamp to 0; a zero clock rate yields 0.
pub fn ticks_to_us(elapsed_ticks: i64, clock_rate_hz: u32) -> u64 {
    if clock_rate_hz == 0 || elapsed_ticks <= 0 {
        return 0;
    }
    let us = (elapsed_ticks as u128) * 1_000_000 / u128::from(clock_rate_hz);
    u64::try_from(us).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN: &str = include_str!("testdata/framing-golden.hex");

    fn golden(name: &str) -> Vec<u8> {
        let line = GOLDEN
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .find_map(|l| l.strip_prefix(name).and_then(|rest| rest.strip_prefix('=')))
            .unwrap_or_else(|| panic!("golden vector {name} missing"));
        assert!(line.len() % 2 == 0, "odd hex length in {name}");
        (0..line.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&line[i..i + 2], 16).expect("hex"))
            .collect()
    }

    const AVCC: &[u8] = &[
        0x01, 0x4d, 0x00, 0x2a, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x4d, 0x00, 0x2a, 0x01, 0x00, 0x02,
        0x68, 0xee,
    ];

    #[test]
    fn config_matches_the_golden_vector() {
        let msg = encode_config(0, 1920, 1080, "avc1.4d002a", AVCC).expect("ascii codec");
        assert_eq!(msg, golden("config"));
    }

    #[test]
    fn keyframe_matches_the_golden_vector() {
        let ts = ticks_to_us(90_000, 90_000);
        let msg = encode_frame(0, ts, true, &[0, 0, 0, 3, 0x65, 0x88, 0x84]);
        assert_eq!(msg, golden("frame_key"));
    }

    #[test]
    fn delta_frame_matches_the_golden_vector() {
        let ts = ticks_to_us(93_003, 90_000);
        assert_eq!(ts, 1_033_366, "ticks convert with floor division");
        let msg = encode_frame(1, ts, false, &[0, 0, 0, 2, 0x41, 0x9a]);
        assert_eq!(msg, golden("frame_delta"));
    }

    #[test]
    fn frame_header_fields_sit_at_fixed_offsets() {
        let msg = encode_frame(0x0102_0304, 0x1122_3344_5566_7788, true, b"xy");
        assert_eq!(msg[0], KIND_FRAME);
        assert_eq!(msg[1], FLAG_KEYFRAME);
        assert_eq!(&msg[2..4], &[0, 0]);
        assert_eq!(
            u32::from_le_bytes(msg[4..8].try_into().unwrap()),
            0x0102_0304
        );
        assert_eq!(
            u64::from_le_bytes(msg[8..16].try_into().unwrap()),
            0x1122_3344_5566_7788
        );
        assert_eq!(&msg[FRAME_PREFIX_LEN..], b"xy");
        assert_eq!(encode_frame(0, 0, false, b"")[1], 0);
    }

    #[test]
    fn config_rejects_unframeable_codecs_and_clamps_dimensions() {
        assert!(encode_config(0, 1, 1, "avc1.é", &[]).is_none());
        assert!(encode_config(0, 1, 1, &"a".repeat(256), &[]).is_none());
        assert!(encode_config(0, 1, 1, &"a".repeat(255), &[]).is_some());
        let msg = encode_config(7, 70_000, 2, "c", &[9]).unwrap();
        assert_eq!(u32::from_le_bytes(msg[4..8].try_into().unwrap()), 7);
        assert_eq!(&msg[8..10], &u16::MAX.to_le_bytes());
        assert_eq!(&msg[10..12], &2u16.to_le_bytes());
        assert_eq!(msg[12], 1);
        assert_eq!(&msg[13..], b"c\x09");
    }

    #[test]
    fn classify_reads_kind_and_keyframe_flag() {
        assert_eq!(classify(&golden("config")), Some(Kind::Config));
        assert_eq!(
            classify(&golden("frame_key")),
            Some(Kind::Frame { key: true })
        );
        assert_eq!(
            classify(&golden("frame_delta")),
            Some(Kind::Frame { key: false })
        );
        assert_eq!(classify(&[2, 1, 0]), None, "shorter than a header");
        assert_eq!(classify(&[9, 0, 0, 0, 0, 0, 0, 0]), None, "unknown kind");
    }

    #[test]
    fn with_seq_rewrites_only_the_seq() {
        let key = golden("frame_key");
        let stamped = with_seq(&key, 0xdead_beef);
        assert_eq!(&stamped[4..8], &0xdead_beef_u32.to_le_bytes());
        assert_eq!(&stamped[..4], &key[..4]);
        assert_eq!(&stamped[8..], &key[8..]);
        assert_eq!(with_seq(&stamped, 0), key, "round trip to the golden seq 0");
        assert_eq!(with_seq(&[1, 2], 5), vec![1, 2], "too short: untouched");
    }

    #[test]
    fn ticks_convert_to_microseconds() {
        let table: &[(i64, u32, u64)] = &[
            (0, 90_000, 0),
            (90_000, 90_000, 1_000_000),
            (3_000, 90_000, 33_333),
            (1, 90_000, 11),
            (-5, 90_000, 0),
            (48_000, 48_000, 1_000_000),
            (10, 0, 0),
            (i64::MAX, 1, u64::MAX),
        ];
        for (ticks, rate, want) in table {
            assert_eq!(ticks_to_us(*ticks, *rate), *want, "{ticks} @ {rate}");
        }
    }
}
