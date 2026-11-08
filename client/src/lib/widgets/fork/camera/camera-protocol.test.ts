import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStatusMsg, parseMessage } from './camera-protocol';

// The same file the Rust framing tests assert byte-for-byte (R2 / T8).
// happy-dom makes import.meta.url non-file, so resolve from the vitest cwd (client/).
const GOLDEN = resolve(process.cwd(), '../widgetsack/src/fork/camera/testdata/framing-golden.hex');

function vectors(): Record<string, ArrayBuffer> {
	const out: Record<string, ArrayBuffer> = {};
	for (const line of readFileSync(GOLDEN, 'utf8').split(/\r?\n/)) {
		if (!line || line.startsWith('#')) continue;
		const [name, hex] = line.split('=');
		const bytes = Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
		out[name] = bytes.buffer;
	}
	return out;
}

const bytes = (...b: number[]) => Uint8Array.from(b).buffer;

describe('camera protocol golden vectors', () => {
	const v = vectors();

	it('loads the three vectors (a probe that loaded nothing must fail)', () => {
		expect(Object.keys(v).sort()).toEqual(['config', 'frame_delta', 'frame_key']);
	});

	it('parses the config vector', () => {
		const m = parseMessage(v.config);
		expect(m).toMatchObject({
			kind: 'config',
			seq: 0,
			width: 1920,
			height: 1080,
			codec: 'avc1.4d002a'
		});
		const hex = Array.from((m as { description: Uint8Array }).description, (b) =>
			b.toString(16).padStart(2, '0')
		).join('');
		expect(hex).toBe('014d002affe10004674d002a01000268ee');
	});

	it('parses the keyframe vector', () => {
		const m = parseMessage(v.frame_key);
		expect(m).toMatchObject({ kind: 'frame', seq: 0, keyframe: true, tsUs: 1_000_000 });
		expect(Array.from((m as { data: Uint8Array }).data)).toEqual([0, 0, 0, 3, 0x65, 0x88, 0x84]);
	});

	it('parses the delta vector', () => {
		const m = parseMessage(v.frame_delta);
		expect(m).toMatchObject({ kind: 'frame', seq: 1, keyframe: false, tsUs: 1_033_366 });
		expect(Array.from((m as { data: Uint8Array }).data)).toEqual([0, 0, 0, 2, 0x41, 0x9a]);
	});
});

describe('malformed messages', () => {
	it('rejects a buffer shorter than the header', () => {
		expect(() => parseMessage(bytes(1, 0, 0))).toThrow(/too short/);
	});
	it('rejects an unknown kind', () => {
		expect(() => parseMessage(bytes(9, 0, 0, 0, 0, 0, 0, 0))).toThrow(/unknown/);
	});
	it('rejects a truncated frame', () => {
		expect(() => parseMessage(bytes(2, 1, 0, 0, 0, 0, 0, 0, 1, 2))).toThrow(/frame too short/);
	});
	it('rejects a truncated config', () => {
		expect(() => parseMessage(bytes(1, 0, 0, 0, 0, 0, 0, 0, 1, 0))).toThrow(/config too short/);
	});
	it('rejects a zero or overlong codec length', () => {
		const head = [1, 0, 0, 0, 0, 0, 0, 0, 0x80, 0x07, 0x38, 0x04];
		expect(() => parseMessage(bytes(...head, 0, 1, 2))).toThrow(/bad codec/);
		expect(() => parseMessage(bytes(...head, 40, 0x61, 0x62))).toThrow(/bad codec/);
		// codec fits but no avcC follows
		expect(() => parseMessage(bytes(...head, 1, 0x61))).toThrow(/bad codec/);
	});
});

describe('isStatusMsg', () => {
	it('accepts a known status object', () => {
		expect(isStatusMsg({ kind: 'status', state: 'live', codec: 'avc1.4d002a' })).toBe(true);
	});
	it('rejects other shapes', () => {
		expect(isStatusMsg(null)).toBe(false);
		expect(isStatusMsg('status')).toBe(false);
		expect(isStatusMsg({ kind: 'other', state: 'live' })).toBe(false);
		expect(isStatusMsg({ kind: 'status', state: 'bogus' })).toBe(false);
		expect(isStatusMsg({ kind: 'status', state: 3 })).toBe(false);
	});
});
