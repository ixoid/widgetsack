import { describe, expect, it } from 'vitest';
import {
	codecOf,
	initialModel,
	isRefusedError,
	reduce,
	REFUSED_ERROR,
	stateText,
	viewFromStatus,
	viewFromWire,
	viewOf,
	VIEW_TEXT,
	WATCHDOG_MS,
	type CameraView,
	type ModelEvent
} from './camera-model';
import type { CameraWireState } from './camera-types';

// A fake clock: every step carries its own timestamp, no timers anywhere.
type Step = [ModelEvent, number];
const run = (steps: Step[], start = 0) =>
	steps.reduce((m, [e, at]) => reduce(m, e, at), initialModel(start));
const view = (steps: Step[], start = 0): CameraView => viewOf(run(steps, start));

const status = (state: CameraWireState, extra: { error?: string; retryInMs?: number } = {}) =>
	({ type: 'status', msg: { kind: 'status', state, ...extra } }) as const;
const subscribed = (state: CameraWireState, configured = true, credentialsSet = true) =>
	({ type: 'subscribed', status: { state, configured, credentialsSet, codec: null } }) as const;

describe('unsupported codec text', () => {
	it('names the codec when it is known, from the wire or from CONFIG', () => {
		expect(stateText('unsupportedCodec', 'H265')).toBe(
			'Unsupported codec (H265): the camera must send H.264. Change the stream in Plugins → Camera.'
		);
		const wire = run([
			[{ type: 'status', msg: { kind: 'status', state: 'unsupportedCodec', codec: 'H265' } }, 1]
		]);
		expect(codecOf(wire)).toBe('H265');
		const sub = reduce(
			initialModel(0),
			{
				type: 'subscribed',
				status: { state: 'idle', configured: true, credentialsSet: true, codec: 'H264' }
			},
			1
		);
		expect(codecOf(sub)).toBe('H264');
		expect(codecOf(run([[{ type: 'config', codec: 'hvc1.1.6.L93' }, 1]]))).toBe('hvc1.1.6.L93');
	});

	it('falls back to the plain text without a codec', () => {
		expect(stateText('unsupportedCodec')).toBe(VIEW_TEXT.unsupportedCodec);
		expect(stateText('unsupportedCodec', null)).toBe(VIEW_TEXT.unsupportedCodec);
		expect(stateText('noSignal', 'H265')).toBe('No signal, retrying');
	});
});

describe('codec name sanitising', () => {
	const plain =
		'Unsupported codec: the camera must send H.264. Change the stream in Plugins → Camera.';
	it('caps a 1 000-char name at 32 characters', () => {
		expect(stateText('unsupportedCodec', 'A'.repeat(1000))).toBe(
			`Unsupported codec (${'A'.repeat(32)}): the camera must send H.264. Change the stream in Plugins → Camera.`
		);
	});
	it('omits a name with control or non-ASCII characters', () => {
		expect(stateText('unsupportedCodec', 'H2\u0000\n65')).toBe(plain);
		expect(stateText('unsupportedCodec', 'H\u00e9')).toBe(plain);
		expect(stateText('unsupportedCodec', '')).toBe(plain);
	});
});

describe('copy', () => {
	// Literal strings for every state: a wrong word fails here, not through VIEW_TEXT itself.
	const EXPECTED: Record<CameraView, string> = {
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

	it.each(Object.entries(EXPECTED))('%s has its literal text', (v, text) => {
		expect(VIEW_TEXT[v as CameraView]).toBe(text);
		expect(stateText(v as CameraView)).toBe(text);
	});

	it('covers exactly the declared states', () => {
		expect(Object.keys(VIEW_TEXT).sort()).toEqual(Object.keys(EXPECTED).sort());
	});

	it('authFailed carries the ADD E sentence', () => {
		expect(VIEW_TEXT.authFailed).toContain(
			'If you toggled RTSP LAN Preview in the Aqara Home app, the credentials were regenerated.'
		);
	});
});

describe('wire mapping', () => {
	it.each([
		['notConfigured', 'notConfigured'],
		['idle', 'connecting'],
		['connecting', 'connecting'],
		['live', 'live'],
		['retrying', 'noSignal'],
		['authFailed', 'authFailed'],
		['unsupportedCodec', 'unsupportedCodec']
	] as [CameraWireState, CameraView][])('%s -> %s', (wire, expected) => {
		expect(viewFromWire(wire)).toBe(expected);
	});

	it('parked retrying (no retryInMs) with a known error is actionable', () => {
		const m = (error?: string, retryInMs?: number) =>
			viewFromStatus({ kind: 'status', state: 'retrying', error, retryInMs });
		expect(m('notFound')).toBe('notFound');
		expect(m('protocol')).toBe('protocolError');
		expect(m('notFound', 2000)).toBe('noSignal'); // transient: still retrying
		expect(m('streamLost')).toBe('noSignal');
		expect(m()).toBe('noSignal');
		expect(viewFromStatus({ kind: 'status', state: 'live' })).toBe('live');
	});
});

describe('transitions', () => {
	const cases: [string, Step[], CameraView][] = [
		['starts connecting', [], 'connecting'],
		[
			'subscribe result: notConfigured',
			[[subscribed('notConfigured', false, false), 1]],
			'notConfigured'
		],
		['subscribe result: connecting', [[subscribed('connecting'), 1]], 'connecting'],
		['status live', [[status('live'), 1]], 'live'],
		[
			'status after subscribe wins',
			[
				[status('live'), 1],
				[subscribed('connecting'), 2]
			],
			'live'
		],
		[
			'retrying',
			[
				[status('live'), 1],
				[status('retrying', { retryInMs: 2000 }), 2]
			],
			'noSignal'
		],
		[
			'retrying then connecting',
			[
				[status('retrying', { retryInMs: 2000 }), 1],
				[status('connecting'), 2]
			],
			'connecting'
		],
		[
			'authFailed with credentials',
			[
				[subscribed('connecting'), 1],
				[status('authFailed'), 2]
			],
			'authFailed'
		],
		[
			'authFailed with an address but no credentials',
			[
				[subscribed('connecting', true, false), 1],
				[status('authFailed'), 2]
			],
			'credentialsMissing'
		],
		['unsupportedCodec on the wire', [[status('unsupportedCodec'), 1]], 'unsupportedCodec'],
		['parked notFound', [[status('retrying', { error: 'notFound' }), 1]], 'notFound'],
		['parked protocol', [[status('retrying', { error: 'protocol' }), 1]], 'protocolError'],
		['refused subscribe', [[{ type: 'subscribeFailed', refused: true }, 1]], 'refused'],
		['other subscribe failure', [[{ type: 'subscribeFailed', refused: false }, 1]], 'unavailable'],
		[
			'credentials hint: connecting then authFailed keeps it',
			[
				[subscribed('connecting', true, false), 1],
				[status('connecting'), 2],
				[status('authFailed'), 3]
			],
			'credentialsMissing'
		],
		[
			'credentials hint: a restart after the failure (Studio save) drops it',
			[
				[subscribed('connecting', true, false), 1],
				[status('authFailed'), 2],
				[status('connecting'), 3],
				[status('authFailed'), 4]
			],
			'authFailed'
		],
		[
			'credentials hint: live replaces it',
			[
				[subscribed('connecting', true, false), 1],
				[status('live'), 2],
				[status('authFailed'), 3]
			],
			'authFailed'
		],
		[
			'credentials hint: a late subscribe result does not resurrect it after live',
			[
				[status('live'), 1],
				[subscribed('connecting', true, false), 2],
				[status('authFailed'), 3]
			],
			'authFailed'
		],
		[
			'credentials hint: a subscribe result after the first statuses still counts',
			[
				[status('connecting'), 1],
				[subscribed('connecting', true, false), 2],
				[status('authFailed'), 3]
			],
			'credentialsMissing'
		],
		[
			'decoder problem: unsupportedCodec',
			[
				[status('live'), 1],
				[{ type: 'problem', problem: 'unsupportedCodec' }, 2]
			],
			'unsupportedCodec'
		],
		[
			'decoder problem: decodeError',
			[
				[status('live'), 1],
				[{ type: 'problem', problem: 'decodeError' }, 2]
			],
			'decodeError'
		],
		[
			'decoder problem: decoderUnavailable',
			[[{ type: 'problem', problem: 'decoderUnavailable' }, 2]],
			'decoderUnavailable'
		],
		[
			'a later live status does not hide a decoder problem',
			[
				[{ type: 'problem', problem: 'decodeError' }, 1],
				[status('live'), 2]
			],
			'decodeError'
		],
		[
			'a new CONFIG does not clear authFailed',
			[
				[status('authFailed'), 1],
				[{ type: 'config', codec: 'avc1.64001f' }, 2],
				[{ type: 'frame', keyframe: true }, 3]
			],
			'authFailed'
		],
		[
			'a new CONFIG does not clear unsupportedCodec',
			[
				[{ type: 'problem', problem: 'unsupportedCodec' }, 1],
				[{ type: 'config', codec: 'avc1.64001f' }, 2]
			],
			'unsupportedCodec'
		],
		[
			'a new CONFIG does not clear decodeError',
			[
				[{ type: 'problem', problem: 'decodeError' }, 1],
				[{ type: 'config', codec: 'avc1.64001f' }, 2]
			],
			'decodeError'
		]
	];
	it.each(cases)('%s', (_name, steps, expected) => {
		expect(view(steps)).toBe(expected);
	});
});

describe('watchdogs (fake clock)', () => {
	it('connecting for exactly 10 s is still connecting, past 10 s is noSignal', () => {
		let m = initialModel(0);
		m = reduce(m, { type: 'tick' }, WATCHDOG_MS);
		expect(viewOf(m)).toBe('connecting');
		m = reduce(m, { type: 'tick' }, WATCHDOG_MS + 1);
		expect(viewOf(m)).toBe('noSignal');
	});

	it('a status change restarts the connecting clock', () => {
		let m = initialModel(0);
		m = reduce(m, status('connecting'), 9000);
		m = reduce(m, { type: 'tick' }, 18_000);
		expect(viewOf(m)).toBe('connecting');
		m = reduce(m, { type: 'tick' }, 19_001);
		expect(viewOf(m)).toBe('noSignal');
	});

	it('a keyframe while still connecting counts as progress', () => {
		let m = initialModel(0);
		m = reduce(m, { type: 'config', codec: 'avc1.64001f' }, 5000);
		m = reduce(m, { type: 'frame', keyframe: true }, 9000);
		m = reduce(m, { type: 'tick' }, 18_000);
		expect(viewOf(m)).toBe('connecting');
	});

	it('live with no frame for more than 10 s is noSignal', () => {
		let m = reduce(initialModel(0), status('live'), 1000);
		m = reduce(m, { type: 'frame', keyframe: true }, 2000);
		m = reduce(m, { type: 'frame', keyframe: false }, 3000);
		m = reduce(m, { type: 'tick' }, 13_000);
		expect(viewOf(m)).toBe('live');
		m = reduce(m, { type: 'tick' }, 13_001);
		expect(viewOf(m)).toBe('noSignal');
	});

	it('a keyframe clears the stall, a delta alone does not', () => {
		let m = reduce(initialModel(0), status('live'), 0);
		m = reduce(m, { type: 'tick' }, 11_000);
		expect(viewOf(m)).toBe('noSignal');
		m = reduce(m, { type: 'frame', keyframe: false }, 11_500);
		expect(viewOf(m)).toBe('noSignal');
		m = reduce(m, { type: 'frame', keyframe: true }, 12_000);
		expect(viewOf(m)).toBe('live');
	});

	it('a new CONFIG clears the stall', () => {
		let m = reduce(initialModel(0), { type: 'tick' }, 11_000);
		expect(viewOf(m)).toBe('noSignal');
		m = reduce(m, { type: 'config', codec: 'avc1.64001f' }, 11_500);
		expect(viewOf(m)).toBe('connecting');
	});

	it('a status message clears the stall', () => {
		let m = reduce(initialModel(0), { type: 'tick' }, 11_000);
		m = reduce(m, status('live'), 11_100);
		expect(viewOf(m)).toBe('live');
	});

	it('does not run on terminal wire states or on a decoder problem', () => {
		for (const s of ['authFailed', 'notConfigured', 'unsupportedCodec'] as CameraWireState[]) {
			const m = reduce(reduce(initialModel(0), status(s), 0), { type: 'tick' }, 60_000);
			expect(viewOf(m)).toBe(viewFromWire(s));
		}
		const p = reduce(initialModel(0), { type: 'problem', problem: 'decodeError' }, 0);
		expect(viewOf(reduce(p, { type: 'tick' }, 60_000))).toBe('decodeError');
	});

	it('ticks that change nothing return the same state object', () => {
		const m = initialModel(0);
		expect(reduce(m, { type: 'tick' }, 5000)).toBe(m);
		const stalled = reduce(m, { type: 'tick' }, 11_000);
		expect(reduce(stalled, { type: 'tick' }, 12_000)).toBe(stalled);
	});
});

describe('decodeError recovery', () => {
	const errored = () =>
		run([
			[status('live'), 0],
			[{ type: 'problem', problem: 'decodeError' }, 1000]
		]);

	it('a draw inside the burst window keeps it', () => {
		const m = reduce(errored(), { type: 'drawn' }, 10_999);
		expect(viewOf(m)).toBe('decodeError');
	});

	it('a draw after the burst window clears it back to the wire state', () => {
		const m = reduce(errored(), { type: 'drawn' }, 11_000);
		expect(viewOf(m)).toBe('live');
	});

	it('a draw does not clear other problems or change a healthy model', () => {
		const u = run([[{ type: 'problem', problem: 'unsupportedCodec' }, 0]]);
		expect(reduce(u, { type: 'drawn' }, 99_000)).toBe(u);
		const h = initialModel(0);
		expect(reduce(h, { type: 'drawn' }, 99_000)).toBe(h);
	});
});

describe('refused error text', () => {
	it('recognises the fixed backend string in strings and Errors', () => {
		expect(isRefusedError(REFUSED_ERROR)).toBe(true);
		expect(isRefusedError(new Error(REFUSED_ERROR))).toBe(true);
		expect(isRefusedError('camera stream key must be 1-64 letters')).toBe(false);
		expect(isRefusedError(42)).toBe(false);
		expect(isRefusedError(null)).toBe(false);
	});

	it('pins the exact backend wording', () => {
		expect(REFUSED_ERROR).toBe(
			'camera stream is not granted: save a layout with a Camera widget in Studio'
		);
	});
});
