// The Camera widget's state logic, pure (no Channel, no DOM, no timers): every input is an event
// with the caller's clock reading, so tests drive a fake clock. The session feeds it wire status,
// stream activity and decoder problems; the widget shows `viewOf(model)` and `stateText(view)`.

import type { StatusMsg } from './camera-protocol';
import type { CameraStatus, CameraWireState } from './camera-types';

export type CameraView =
	| 'connecting'
	| 'live'
	| 'noSignal'
	| 'authFailed'
	| 'unsupportedCodec'
	| 'notFound'
	| 'protocolError'
	| 'notConfigured'
	| 'credentialsMissing'
	| 'decoderUnavailable'
	| 'decodeError'
	| 'refused'
	| 'unavailable';

/** Problems only the decoder can report. They stay until something provably fixes them. */
export type DecoderProblem = 'unsupportedCodec' | 'decodeError' | 'decoderUnavailable';

/** Silence longer than this (connecting without a keyframe, live without a frame) is no signal. */
export const WATCHDOG_MS = 10_000;
/** A decodeError may clear on a draw only this long after it was raised (the burst window). */
export const DECODE_ERROR_HOLD_MS = 10_000;

/** The one place all user-facing copy lives. `live` has no text, the picture speaks. */
export const VIEW_TEXT: Record<CameraView, string> = {
	connecting: 'Connecting',
	live: '',
	noSignal: 'No signal, retrying',
	authFailed:
		'Wrong login or password. If you toggled RTSP LAN Preview in the Aqara Home app, the credentials were regenerated. Enter the new ones in Plugins → Camera.',
	unsupportedCodec:
		'Unsupported codec: the camera must send H.264. Change the stream in Plugins → Camera.',
	notFound: 'Stream not found. Check the address in Plugins → Camera.',
	protocolError: 'Protocol error. Check the stream path in Plugins → Camera.',
	notConfigured: 'Camera not set up. Open Plugins → Camera in Studio.',
	credentialsMissing: 'Login or password not set. Enter them in Plugins → Camera.',
	decoderUnavailable: 'Video decoder unavailable',
	decodeError: 'Decode error',
	refused: 'Save the layout in Studio',
	unavailable: 'Camera unavailable — check Plugins → Camera'
};

/** The codec name is shown when known (a wire name like H265 or the CONFIG string; never a secret). */
export const stateText = (v: CameraView, codec: string | null = null): string =>
	v === 'unsupportedCodec' && codec
		? `Unsupported codec (${codec}): the camera must send H.264. Change the stream in Plugins → Camera.`
		: VIEW_TEXT[v];

const FROM_WIRE: Record<CameraWireState, CameraView> = {
	notConfigured: 'notConfigured',
	idle: 'connecting',
	connecting: 'connecting',
	live: 'live',
	retrying: 'noSignal',
	authFailed: 'authFailed',
	unsupportedCodec: 'unsupportedCodec'
};

export const viewFromWire = (s: CameraWireState): CameraView => FROM_WIRE[s];

/**
 * A status message as a view. `retrying` WITHOUT retryInMs means the worker parked after a
 * non-transient error (notFound / protocol) and waits for a config save: actionable, not "reconnecting".
 */
export function viewFromStatus(m: StatusMsg): CameraView {
	if (m.state === 'retrying' && m.retryInMs === undefined) {
		if (m.error === 'notFound') return 'notFound';
		if (m.error === 'protocol') return 'protocolError';
	}
	return viewFromWire(m.state);
}

/** The fixed error `camera_subscribe` rejects with for an overlay whose layout has no Camera widget. */
export const REFUSED_ERROR =
	'camera stream is not granted: save a layout with a Camera widget in Studio';

export function isRefusedError(e: unknown): boolean {
	const text = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
	return text.includes(REFUSED_ERROR);
}

export type ModelState = {
	/** Latest view told by the backend (subscribe result, then status messages). */
	wire: CameraView;
	/** A status message has been heard: the slower subscribe result must not overwrite it. */
	heard: boolean;
	/**
	 * Subscribe said an address is saved without a login/password (turns authFailed into a hint).
	 * Not sticky: a status other than the connecting/authFailed run replaces it (see `status`).
	 */
	credsMissing: boolean;
	/** Last codec name heard (status or CONFIG), for the unsupported-codec text. */
	codec: string | null;
	problem: DecoderProblem | null;
	problemAt: number;
	/** The watchdog fired; cleared by a status message, a CONFIG or a keyframe. */
	stalled: boolean;
	/** Last sign of life: start, status, CONFIG, frame. */
	progressAt: number;
};

export type ModelEvent =
	| {
			type: 'subscribed';
			status: Pick<CameraStatus, 'state' | 'configured' | 'credentialsSet' | 'codec'>;
	  }
	| { type: 'subscribeFailed'; refused: boolean }
	| { type: 'status'; msg: StatusMsg }
	| { type: 'config'; codec: string }
	| { type: 'frame'; keyframe: boolean }
	| { type: 'problem'; problem: DecoderProblem }
	| { type: 'drawn' }
	| { type: 'tick' };

export const initialModel = (nowMs: number): ModelState => ({
	wire: 'connecting',
	heard: false,
	credsMissing: false,
	codec: null,
	problem: null,
	problemAt: 0,
	stalled: false,
	progressAt: nowMs
});

export function reduce(s: ModelState, e: ModelEvent, nowMs: number): ModelState {
	switch (e.type) {
		case 'subscribed':
			return {
				...s,
				wire: s.heard ? s.wire : viewFromWire(e.status.state),
				// the result races the first statuses: it still counts while they are only
				// connecting/authFailed, but never overrides a later state (live, a retry, ...)
				credsMissing:
					s.heard && s.wire !== 'connecting' && s.wire !== 'authFailed'
						? s.credsMissing
						: e.status.configured && !e.status.credentialsSet,
				codec: s.codec ?? e.status.codec
			};
		case 'subscribeFailed':
			// Terminal either way (no client retry): the layout gate has its own text, any other
			// rejection (unreadable config, bad key) is "unavailable", never a false "retrying".
			return { ...s, heard: true, wire: e.refused ? 'refused' : 'unavailable' };
		case 'status': {
			const wire = viewFromStatus(e.msg);
			return {
				...s,
				heard: true,
				// The hint survives only the status run that leads up to the first authFailed
				// (connecting, authFailed). Anything else, notably a `connecting` after an
				// authFailed (the worker restarted on a Studio save), replaces it.
				credsMissing:
					s.credsMissing &&
					(wire === 'authFailed' || (wire === 'connecting' && s.wire !== 'authFailed')),
				codec: e.msg.codec ?? s.codec,
				wire,
				stalled: false,
				progressAt: nowMs
			};
		}
		case 'config':
			return { ...s, codec: e.codec, stalled: false, progressAt: nowMs };
		case 'frame':
			return { ...s, stalled: e.keyframe ? false : s.stalled, progressAt: nowMs };
		case 'problem':
			return { ...s, problem: e.problem, problemAt: nowMs };
		case 'drawn':
			// The decoder rebuilds only on a keyframe >= the hold after the burst, so a draw this late
			// comes from the rebuilt decoder; an earlier one is a leftover pending frame.
			return s.problem === 'decodeError' && nowMs - s.problemAt >= DECODE_ERROR_HOLD_MS
				? { ...s, problem: null }
				: s;
		case 'tick': {
			const waiting = s.wire === 'connecting' || s.wire === 'live';
			return !s.stalled && waiting && nowMs - s.progressAt > WATCHDOG_MS
				? { ...s, stalled: true }
				: s;
		}
	}
}

export const codecOf = (s: ModelState): string | null => s.codec;

export function viewOf(s: ModelState): CameraView {
	if (s.problem) return s.problem;
	if (s.wire === 'authFailed' && s.credsMissing) return 'credentialsMissing';
	if (s.stalled && (s.wire === 'connecting' || s.wire === 'live')) return 'noSignal';
	return s.wire;
}
