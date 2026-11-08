import type { Channel } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
	Channel: class {
		onmessage = () => undefined;
	},
	invoke: vi.fn(async () => ({}))
}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraDecoder } from './camera-decoder';
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
import type { CameraView } from './camera-view';

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
	credentialsSet: false,
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
		counters: () => ({ drawn: 0, dropped: 2 })
	};
	let problem: (p: 'unsupportedCodec' | 'decodeError') => void = () => undefined;
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
		createDecoder: (_canvas, onProblem) => {
			problem = onProblem;
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
		problem: (p: 'decodeError') => problem(p)
	};
}
const canvas = { width: 0, height: 0, getContext: () => null };
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
		expect(f.views).toEqual(['connecting']); // from the subscribe result

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

	it('shows "unavailable" when the subscribe is refused', async () => {
		const f = fakes();
		vi.mocked(f.deps.subscribe).mockRejectedValueOnce(new Error('studio only'));
		const stop = startCameraSession('k', canvas, f.onView, f.deps);
		await flush();
		expect(f.views).toEqual(['unavailable']);
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
		const dec = defaultSessionDeps.createDecoder(canvas, () => undefined);
		expect(dec.counters()).toEqual({ drawn: 0, dropped: 0 });
		dec.close();
		await defaultSessionDeps.subscribe({} as Channel<unknown>, 'k');
		await defaultSessionDeps.unsubscribe('k');
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
		const stop = runCameraStream('k', canvas, f.onView, f.deps);
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

		stop();
		await flush();
		expect(f.order.at(-1)).toBe('unsub:k');
		setHidden(true); // listener removed: no timer, nothing more
		vi.advanceTimersByTime(HIDE_DEBOUNCE_MS);
		expect(f.order.filter((o) => o === 'unsub:k')).toHaveLength(2);
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
