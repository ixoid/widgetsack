// What the Camera widget shows: the wire state (plus decoder problems) folded into one view state,
// and the overlay copy per state. `live` has no text, the picture speaks.

import type { StatusMsg } from './camera-protocol';
import type { CameraWireState } from './camera-types';

export type CameraView =
	| 'connecting'
	| 'live'
	| 'noSignal'
	| 'authFailed'
	| 'unsupportedCodec'
	| 'notFound'
	| 'protocolError'
	| 'notConfigured'
	| 'decodeError'
	| 'unavailable';

export const VIEW_TEXT: Record<CameraView, string> = {
	connecting: 'connecting',
	live: '',
	noSignal: 'no signal',
	authFailed: 'auth failed — see Plugins → Camera',
	unsupportedCodec: 'unsupported codec',
	notFound: 'stream not found — check the address in Plugins → Camera',
	protocolError: 'protocol error — check the stream path',
	notConfigured: 'not configured',
	decodeError: 'decode error',
	unavailable: 'camera unavailable'
};

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
