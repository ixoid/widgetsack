import type { Channel } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
	Channel: class {
		onmessage = () => undefined;
	},
	invoke: vi.fn(async () => ({}))
}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraDecoder } from './camera-decoder';
import { DECODE_ERROR_HOLD_MS, REFUSED_ERROR, WATCHDOG_MS } from './camera-model';
import { getDiagnostics } from './camera-diagnostics';
import {
	defaultSessionDeps,
	HIDE_DEBOUNCE_MS,
	runCameraStream,
	startCameraSession,
	STATS_INTERVAL_MS,
	type SessionDeps
} from './camera-session';
import type { CameraStatus } from './camera-types';
import type { CameraView, DecoderProblem } from './camera-model';

// Golden vectors (framing-golden.hex), inlined: config + key + delta.
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)).buffer;
const CONFIG = hex(
	'0100000000000000800738040b617663312e346430303261014d002affe10004674d002a01000268ee'
);
const KEY = hex('020100000000000040420f000000000000000003658884');
const DELTA = hex('020000000100000096c40f000000000000000002419a');

const STATUS: CameraStatus = {
	configured: true,
	host: '',
	port: 0,
	path: '',
	hasUsername: false,
	hasPassword: false,
	credentialsSet: true,
	codec: null,
	width: null,
	height: null,
	state: 'idle',
	authLockedUntilMs: null
};

function fakes(subscribeState: CameraStatus['state'] = 'connecting') {
	const channels: { onmessage: (m: unknown) => void }[] = [];
	const order: string[] = [];
	const decoder: CameraDecoder = {
		configure: vi.fn(async () => undefined),
		push: vi.fn(),
		close: vi.fn(),
		available: vi.fn(() => true),
		cooling: vi.fn(() => false),
		counters: () => ({ drawn: 0, superseded: 1, dropped: 2 })
	};
	let problem: (p: DecoderProblem) => void = () => undefined;
	let draw: () => void = () => undefined;
	const acks: [string, number][] = [];
	const deps: SessionDeps = {
		createChannel: () => {
			const c = { onmessage: (_m: unknown) => undefined };
			channels.push(c);
			return c as unknown as Channel<unknown>;
		},
		subscribe: vi.fn(async (_c, key) => {
			order.push(`sub:${key}`);
			return { ...STATUS, state: subscribeState };
		}),
		unsubscribe: vi.fn(async (key) => {
			order.push(`unsub:${key}`);
		}),
		ack: vi.fn(async (key, seq) => {
			acks.push([key, seq]);
		}),
		createDecoder: (_canvas, onProblem, onDraw) => {
			problem = onProblem;
			draw = onDraw;
			return decoder;
		},
		now: () => Date.now()
	};
	const views: CameraView[] = [];
	return {
		deps,
		channels,
		order,
		decoder,
		views,
		onView: (v: CameraView) => views.push(v),
		acks,
		draw: () => draw(),
		problem: (p: DecoderProblem) => problem(p)
	};
}
const canvas = { width: 0, height: 0, getContext: () => null };
const clearRect = vi.fn();
const drawnCanvas = { width: 4, height: 3, getContext: () => ({ drawImage: vi.fn(), clearRect }) };
const flush = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('camera session', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('subscribes with the key, routes config/frames to the decoder and statuses to the view', async () => {
		const f = fakes();
		const stop = startCameraSession('cam-1', canvas, f.onView, f.deps);
		await flush();
		expect(f.order).toEqual(['sub:cam-1']);
		expect(f.views).toEqual([]); // connecting is where the hook starts: nothing to announce

		const ch = f.channels[0];
		ch.onmessage({ kind: 'status', state: 'live', codec: 'avc1.4d002a' });
		ch.onmessage(CONFIG);
		ch.onmessage(KEY);
		ch.onmessage(DELTA);
		ch.onmessage({ kind: 'status', state: 'retrying', error: 'notFound' });
		expect(f.views.at(-1)).toBe('notFound');
		ch.onmessage({ kind: 'status', state: 'live' });
		ch.onmessage({ nonsense: true });
		ch.onmessage(new ArrayBuffer(3)); // malformed: dropped silently
		expect(f.views.at(-1)).toBe('live');
		expect(f.decoder.configure).toHaveBeenCalledTimes(1);
		expect(f.decoder.push).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(STATS_INTERVAL_MS);
		expect(getDiagnostics()).toMatchObject({
			codec: 'avc1.4d002a',
			width: 1920,
			height: 1080,
			frames: 2,
			superseded: 1,
			dropped: 2
		});

		stop();
		expect(f.decoder.close).toHaveBeenCalled();
		expect(getDiagnostics()).toBeNull();
		ch.onmessage(KEY); // after stop: ignored
		expect(f.decoder.push).toHaveBeenCalledTimes(2);
		await flush();
		expect(f.order).toEqual(['sub:cam-1', 'unsub:cam-1']);
	});

	it('does not let the subscribe result overwrite a status that already arrived', async () => {
		const f = fakes('connecting');
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		f.channels[0].onmessage({ kind: 'status', state: 'authFailed' });
		await flush();
		expect(f.views).toEqual(['authFailed']);
		stop();
	});

	it('surfaces decoder problems and a configure rejection', async () => {
		const f = fakes();
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		f.problem('decodeError');
		expect(f.views.at(-1)).toBe('decodeError');
		vi.mocked(f.decoder.configure).mockRejectedValueOnce(new Error('no codec'));
		f.channels[0].onmessage(CONFIG);
		await flush();
		expect(f.views.at(-1)).toBe('unsupportedCodec');
		stop();
		f.problem('decodeError'); // after stop: no view update
		expect(f.views.at(-1)).toBe('unsupportedCodec');
	});

	it('keeps a decoder problem on screen when a later live status arrives', async () => {
		const f = fakes();
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		f.problem('decodeError');
		f.channels[0].onmessage({ kind: 'status', state: 'live' });
		expect(f.views.at(-1)).toBe('decodeError');
		f.channels[0].onmessage(CONFIG); // a new CONFIG alone does not clear a decodeError
		expect(f.views.at(-1)).toBe('decodeError');
		f.draw(); // a draw inside the burst window does not either
		expect(f.views.at(-1)).toBe('decodeError');
		vi.advanceTimersByTime(DECODE_ERROR_HOLD_MS);
		f.draw(); // a draw after the window proves the rebuilt decoder works
		expect(f.views.at(-1)).toBe('live');
		stop();
	});

	it('does not let the subscribe result hide a decoder problem that came first', async () => {
		const f = fakes('live');
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		f.problem('decodeError');
		await flush();
		expect(f.views).toEqual(['decodeError']);
		stop();
	});

	it('unsubscribes once on an unsupported codec, goes deaf, and does not resubscribe', async () => {
		const f = fakes();
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		vi.mocked(f.decoder.configure).mockRejectedValueOnce(new Error('no codec'));
		f.channels[0].onmessage(CONFIG);
		await flush();
		expect(f.views.at(-1)).toBe('unsupportedCodec');
		expect(f.order).toEqual(['sub:k', 'unsub:k']);
		f.channels[0].onmessage(KEY);
		f.channels[0].onmessage({ kind: 'status', state: 'live' });
		expect(f.decoder.push).not.toHaveBeenCalled();
		expect(f.views.at(-1)).toBe('unsupportedCodec');
		stop(); // teardown must not unsubscribe a second time
		await flush();
		expect(f.order).toEqual(['sub:k', 'unsub:k']);
	});

	it('clears the canvas when entering a non-live view and not on live', async () => {
		const f = fakes();
		clearRect.mockClear();
		const stop = startCameraSession('k', drawnCanvas, f.onView, f.deps);
		await flush();
		expect(clearRect).not.toHaveBeenCalled(); // still connecting, nothing changed
		f.channels[0].onmessage({ kind: 'status', state: 'live' });
		expect(clearRect).not.toHaveBeenCalled();
		f.channels[0].onmessage({ kind: 'status', state: 'retrying', retryInMs: 1000 });
		expect(f.views.at(-1)).toBe('noSignal');
		expect(clearRect).toHaveBeenCalledTimes(1);
		expect(clearRect).toHaveBeenLastCalledWith(0, 0, 4, 3);
		f.channels[0].onmessage({ kind: 'status', state: 'connecting' });
		expect(clearRect).toHaveBeenCalledTimes(2);
		stop();
	});

	it('maps the fixed refusal string to refused (Error and plain string)', async () => {
		for (const rejection of [new Error(REFUSED_ERROR), REFUSED_ERROR]) {
			const f = fakes();
			vi.mocked(f.deps.subscribe).mockRejectedValueOnce(rejection);
			const stop = startCameraSession('k', canvas, f.onView, f.deps);
			await flush();
			expect(f.views).toEqual(['refused']);
			stop();
		}
	});

	it('shows unavailable (terminal, no retry) for any other subscribe failure', async () => {
		for (const rejection of [
			'camera config could not be read',
			new Error('camera config is corrupt'),
			'camera stream key must be 1-64 letters'
		]) {
			const f = fakes();
			vi.mocked(f.deps.subscribe).mockRejectedValueOnce(rejection);
			const stop = startCameraSession('k', canvas, f.onView, f.deps);
			await flush();
			expect(f.views).toEqual(['unavailable']);
			vi.advanceTimersByTime(60_000);
			expect(f.deps.subscribe).toHaveBeenCalledTimes(1);
			stop();
		}
	});

	it('does not subscribe at all when the browser has no VideoDecoder', async () => {
		const f = fakes();
		vi.mocked(f.decoder.available).mockReturnValue(false);
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		expect(f.deps.subscribe).not.toHaveBeenCalled();
		expect(f.views).toEqual(['decoderUnavailable']);
		stop();
		await flush();
		expect(f.order).toEqual([]); // no unsubscribe for a subscription that never was
	});

	it('hands the codec name to the view for an unsupported codec', async () => {
		const f = fakes();
		const seen: (string | undefined)[] = [];
		const stop = startCameraSession('k', canvas, (v, c) => seen.push(v + ':' + c), f.deps);
		await flush();
		f.channels[0].onmessage({ kind: 'status', state: 'unsupportedCodec', codec: 'H265' });
		expect(seen).toEqual(['unsupportedCodec:H265']);
		stop();
	});

	it('stops acking while the decoder is cooling down and resumes after', async () => {
		const f = fakes();
		const stop = startCameraSession('cam-a', canvas, f.onView, f.deps);
		await flush();
		const ch = f.channels[0];
		vi.mocked(f.decoder.cooling).mockReturnValue(true);
		ch.onmessage(frameBuf(1, true));
		expect(f.acks).toEqual([]);
		vi.mocked(f.decoder.cooling).mockReturnValue(false);
		ch.onmessage(frameBuf(2, true));
		expect(f.acks).toEqual([['cam-a', 2]]);
		stop();
	});

	it('a Studio save that restarts the worker replaces the credentials hint', async () => {
		const f = fakes();
		vi.mocked(f.deps.subscribe).mockResolvedValueOnce({
			...STATUS,
			configured: true,
			credentialsSet: false,
			state: 'connecting'
		});
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		const ch = f.channels[0];
		ch.onmessage({ kind: 'status', state: 'authFailed' });
		expect(f.views.at(-1)).toBe('credentialsMissing');
		ch.onmessage({ kind: 'status', state: 'connecting' }); // restart after the save
		expect(f.views.at(-1)).toBe('connecting');
		ch.onmessage({ kind: 'status', state: 'authFailed' });
		expect(f.views.at(-1)).toBe('authFailed');
		stop();
	});

	it('StrictMode mount/unmount/mount stays ordered and skips the cancelled subscribe', async () => {
		const f = fakes();
		const first = startCameraSession('k', canvas, f.onView, f.deps);
		first();
		const second = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		expect(f.order).toEqual(['unsub:k', 'sub:k']);
		second();
		await flush();
		expect(f.order).toEqual(['unsub:k', 'sub:k', 'unsub:k']);
	});

	it('an unsubscribe failure is swallowed', async () => {
		const f = fakes();
		vi.mocked(f.deps.unsubscribe).mockRejectedValueOnce(new Error('x'));
		startCameraSession('k', canvas, f.onView, f.deps)();
		await flush();
		expect(f.deps.unsubscribe).toHaveBeenCalled();
	});

	it('has working default deps', async () => {
		expect(typeof defaultSessionDeps.now()).toBe('number');
		expect(defaultSessionDeps.createChannel()).toBeTruthy();
		const dec = defaultSessionDeps.createDecoder(
			canvas,
			() => undefined,
			() => undefined
		);
		expect(dec.counters()).toEqual({ drawn: 0, superseded: 0, dropped: 0 });
		dec.close();
		await defaultSessionDeps.subscribe({} as Channel<unknown>, 'k');
		await defaultSessionDeps.unsubscribe('k');
		await defaultSessionDeps.ack('k', 1);
	});
});

// A FRAME message as the backend frames it: header (kind, flags, reserved, seq), ts_us, payload.
const frameBuf = (seq: number, keyframe: boolean) => {
	const b = new ArrayBuffer(17);
	const v = new DataView(b);
	v.setUint8(0, 2);
	v.setUint8(1, keyframe ? 1 : 0);
	v.setUint32(4, seq, true);
	v.setUint8(16, 9);
	return b;
};

describe('acks', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('acks the last seq every 8 frames and on every keyframe', async () => {
		const f = fakes();
		const stop = startCameraSession('cam-a', canvas, f.onView, f.deps);
		await flush();
		const ch = f.channels[0];
		ch.onmessage(CONFIG);
		ch.onmessage(frameBuf(0, true));
		expect(f.acks).toEqual([['cam-a', 0]]); // keyframe
		for (let seq = 1; seq <= 7; seq++) ch.onmessage(frameBuf(seq, false));
		expect(f.acks).toHaveLength(1);
		ch.onmessage(frameBuf(8, false));
		expect(f.acks.at(-1)).toEqual(['cam-a', 8]); // 8 frames after the keyframe
		ch.onmessage(frameBuf(9, true)); // mid-GOP keyframe
		expect(f.acks.at(-1)).toEqual(['cam-a', 9]);
		ch.onmessage(CONFIG); // seq may jump or continue across a CONFIG: acks echo whatever came
		ch.onmessage(frameBuf(0, true));
		expect(f.acks.at(-1)).toEqual(['cam-a', 0]);
		stop();
	});

	it('ignores ack failures and sends no ack after stop', async () => {
		const f = fakes();
		vi.mocked(f.deps.ack).mockRejectedValue(new Error('gone'));
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		f.channels[0].onmessage(frameBuf(0, true));
		await flush(); // the rejection is swallowed: no unhandled rejection fails the run
		expect(f.deps.ack).toHaveBeenCalledTimes(1);
		stop();
		f.channels[0].onmessage(frameBuf(1, true));
		expect(f.deps.ack).toHaveBeenCalledTimes(1);
	});

	it('still acks frames the decoder gated away (the backend counts frames in flight)', async () => {
		const f = fakes();
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		for (let seq = 1; seq <= 8; seq++) f.channels[0].onmessage(frameBuf(seq, false));
		expect(f.acks).toEqual([['k', 8]]);
		stop();
	});
});

describe('watchdogs through the session', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('connecting without a keyframe for more than 10 s becomes no signal', async () => {
		const f = fakes();
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		vi.advanceTimersByTime(WATCHDOG_MS);
		expect(f.views).toEqual([]);
		vi.advanceTimersByTime(STATS_INTERVAL_MS);
		expect(f.views).toEqual(['noSignal']);
		f.channels[0].onmessage(CONFIG);
		f.channels[0].onmessage(frameBuf(0, true));
		expect(f.views.at(-1)).toBe('connecting'); // the keyframe clears the stall; live follows
		f.channels[0].onmessage({ kind: 'status', state: 'live' });
		expect(f.views.at(-1)).toBe('live');
		stop();
	});

	it('live with no frame for more than 10 s becomes no signal', async () => {
		const f = fakes();
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		f.channels[0].onmessage({ kind: 'status', state: 'live' });
		vi.advanceTimersByTime(WATCHDOG_MS + STATS_INTERVAL_MS);
		expect(f.views).toEqual(['live', 'noSignal']);
		stop();
	});
});

describe('subscribe result hints', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('an address without credentials turns authFailed into credentialsMissing', async () => {
		const f = fakes();
		vi.mocked(f.deps.subscribe).mockResolvedValueOnce({
			...STATUS,
			configured: true,
			credentialsSet: false,
			state: 'connecting'
		});
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		f.channels[0].onmessage({ kind: 'status', state: 'authFailed', error: 'authFailed' });
		expect(f.views).toEqual(['credentialsMissing']);
		stop();
	});

	it('decoderUnavailable stops the backend stream and goes deaf', async () => {
		const f = fakes();
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		f.problem('decoderUnavailable');
		expect(f.views).toEqual(['decoderUnavailable']);
		await flush();
		expect(f.order).toEqual(['sub:k', 'unsub:k']);
		f.channels[0].onmessage(KEY);
		expect(f.decoder.push).not.toHaveBeenCalled();
		stop();
	});
});

describe('per-key serialisation', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('a subscribe that never resolves for one key does not block another key', async () => {
		const f = fakes();
		vi.mocked(f.deps.subscribe).mockImplementationOnce(() => new Promise(() => undefined));
		const stopA = startCameraSession('a', canvas, f.onView, f.deps);
		const stopB = startCameraSession('b', canvas, f.onView, f.deps);
		await flush();
		expect(f.order).toEqual(['sub:b']);
		stopB();
		await flush();
		expect(f.order).toEqual(['sub:b', 'unsub:b']);
		stopA();
	});

	it('keeps order within one key across several queued sessions', async () => {
		const f = fakes();
		const stops = [1, 2, 3].map(() => startCameraSession('k', canvas, f.onView, f.deps));
		stops.forEach((s) => s());
		await flush();
		expect(f.order).toEqual(['unsub:k', 'unsub:k', 'unsub:k']); // each cancelled before subscribing
	});
});

describe('runCameraStream visibility', () => {
	const setHidden = (hidden: boolean) => {
		Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
		document.dispatchEvent(new Event('visibilitychange'));
	};
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		setHidden(false);
	});

	it('unsubscribes after 1.5 s hidden, resubscribes on visible, keeps a short hide', async () => {
		const f = fakes();
		clearRect.mockClear();
		const stop = runCameraStream('k', drawnCanvas, f.onView, f.deps);
		await flush();
		expect(f.order).toEqual(['sub:k']);

		setHidden(true);
		setHidden(true); // a second event must not stack timers
		vi.advanceTimersByTime(HIDE_DEBOUNCE_MS - 1);
		setHidden(false); // back in time: nothing happened
		vi.advanceTimersByTime(HIDE_DEBOUNCE_MS);
		await flush();
		expect(f.order).toEqual(['sub:k']);

		setHidden(true);
		vi.advanceTimersByTime(HIDE_DEBOUNCE_MS);
		await flush();
		expect(f.order).toEqual(['sub:k', 'unsub:k']);

		setHidden(false);
		await flush();
		expect(f.order).toEqual(['sub:k', 'unsub:k', 'sub:k']);
		expect(f.views).toContain('connecting');
		expect(clearRect).toHaveBeenCalled(); // the paused session's frame is wiped before the new one

		stop();
		await flush();
		expect(f.order.at(-1)).toBe('unsub:k');
		setHidden(true); // listener removed: no timer, nothing more
		vi.advanceTimersByTime(HIDE_DEBOUNCE_MS);
		expect(f.order.filter((o) => o === 'unsub:k')).toHaveLength(2);
	});

	it('a widget mounted in an already hidden page stops after the debounce', async () => {
		setHidden(true);
		const f = fakes();
		const stop = runCameraStream('k', canvas, f.onView, f.deps);
		await flush();
		vi.advanceTimersByTime(HIDE_DEBOUNCE_MS);
		await flush();
		expect(f.order).toEqual(['sub:k', 'unsub:k']);
		stop();
	});

	it('teardown while hidden-and-stopped does not stop twice', async () => {
		const f = fakes();
		const stop = runCameraStream('k', canvas, f.onView, f.deps);
		await flush();
		setHidden(true);
		vi.advanceTimersByTime(HIDE_DEBOUNCE_MS);
		await flush();
		stop();
		await flush();
		expect(f.order).toEqual(['sub:k', 'unsub:k']);
	});
});
