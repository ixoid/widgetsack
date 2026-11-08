// Wire format of the camera Channel (widgetsack/src/fork/camera/framing.rs), little-endian:
//   header 8 B : u8 kind (1 CONFIG, 2 FRAME) | u8 flags | u16 reserved | u32 seq
//   FRAME      : flags bit0 = keyframe | u64 ts_us | AVC length-prefixed NAL payload
//   CONFIG     : u16 width | u16 height | u8 codec_len | codec ASCII | avcC (rest)
// Raw payloads arrive as ArrayBuffer; status updates arrive as JSON objects.

import type { CameraWireState } from './camera-types';

export type ConfigMsg = {
	kind: 'config';
	seq: number;
	width: number;
	height: number;
	codec: string;
	/** avcC record, handed to `VideoDecoder.configure({ description })` as is. */
	description: Uint8Array;
};

export type FrameMsg = {
	kind: 'frame';
	seq: number;
	keyframe: boolean;
	tsUs: number;
	data: Uint8Array;
};

export type StatusMsg = {
	kind: 'status';
	state: CameraWireState;
	codec?: string;
	error?: string;
	retryInMs?: number;
};

const KIND_CONFIG = 1;
const KIND_FRAME = 2;
const HEADER = 8;
const FRAME_HEADER = HEADER + 8;
const CONFIG_FIXED = HEADER + 5;

/** Parse one raw message; throws on a malformed buffer (the caller drops it). */
export function parseMessage(buf: ArrayBuffer): ConfigMsg | FrameMsg {
	if (buf.byteLength < HEADER) throw new Error('camera message too short');
	const view = new DataView(buf);
	const kind = view.getUint8(0);
	const flags = view.getUint8(1);
	const seq = view.getUint32(4, true);
	if (kind === KIND_FRAME) {
		if (buf.byteLength < FRAME_HEADER) throw new Error('camera frame too short');
		return {
			kind: 'frame',
			seq,
			keyframe: (flags & 1) === 1,
			tsUs: Number(view.getBigUint64(8, true)),
			data: new Uint8Array(buf, FRAME_HEADER)
		};
	}
	if (kind === KIND_CONFIG) {
		if (buf.byteLength < CONFIG_FIXED) throw new Error('camera config too short');
		const codecLen = view.getUint8(HEADER + 4);
		const descAt = CONFIG_FIXED + codecLen;
		if (codecLen === 0 || descAt >= buf.byteLength) throw new Error('camera config bad codec');
		return {
			kind: 'config',
			seq,
			width: view.getUint16(HEADER, true),
			height: view.getUint16(HEADER + 2, true),
			codec: String.fromCharCode(...new Uint8Array(buf, CONFIG_FIXED, codecLen)),
			description: new Uint8Array(buf, descAt)
		};
	}
	throw new Error('unknown camera message kind');
}

const WIRE_STATES: ReadonlySet<string> = new Set<CameraWireState>([
	'notConfigured',
	'idle',
	'connecting',
	'live',
	'retrying',
	'authFailed',
	'unsupportedCodec'
]);

/** Type guard for the JSON status objects (anything else on the channel is ignored). */
export function isStatusMsg(x: unknown): x is StatusMsg {
	if (typeof x !== 'object' || x === null) return false;
	const m = x as Record<string, unknown>;
	return m.kind === 'status' && typeof m.state === 'string' && WIRE_STATES.has(m.state);
}
