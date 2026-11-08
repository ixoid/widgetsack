// One live camera session (non-React): Channel -> protocol -> decoder, a thin adapter over the pure
// model in camera-model.ts. Subscribe/unsubscribe for one key go through one promise chain so a
// StrictMode mount/unmount/mount (or a hide/show) can never reorder them on the way to the backend;
// other keys do not wait on it. runCameraStream adds the visibility rule: hidden for 1.5 s ->
// unsubscribe, visible again -> resubscribe.

import { Channel } from '@tauri-apps/api/core';
import { createAckPolicy } from './camera-ack';
import { cameraAck, cameraSubscribe, cameraUnsubscribe } from './camera-commands';
import {
	clearCanvas,
	createCameraDecoder,
	type CameraDecoder,
	type CanvasLike
} from './camera-decoder';
import { publishDiagnostics } from './camera-diagnostics';
import {
	codecOf,
	initialModel,
	isRefusedError,
	reduce,
	viewOf,
	WATCHDOG_MS,
	type CameraView,
	type DecoderProblem,
	type ModelEvent
} from './camera-model';
import { isStatusMsg, parseMessage } from './camera-protocol';
import { createCameraStats } from './camera-stats';
import type { CameraStatus } from './camera-types';

/** The view to show; `codec` is the name for the unsupported-codec text when known. */
export type ViewListener = (v: CameraView, codec?: string) => void;

export const HIDE_DEBOUNCE_MS = 1500;
/**
 * Time from a (re)start to the next restart when a live stream goes silent without any status
 * (the backend dropped this subscriber and says nothing). The last rung repeats.
 */
export const RESTART_LADDER_MS = [10_000, 30_000, 60_000];

/** Events runCameraStream needs from a session to run the restart ladder. */
export type SessionHooks = {
	/** Live and silent past the watchdog with no status heard since: the backend may have dropped us. */
	onStall(): void;
	/** A status, CONFIG or keyframe arrived: the stall is over. */
	onStallCleared(): void;
	onKeyframe(): void;
};
export const STATS_INTERVAL_MS = 1000;

export type SessionDeps = {
	createChannel(): Channel<unknown>;
	subscribe(channel: Channel<unknown>, key: string): Promise<CameraStatus>;
	unsubscribe(key: string): Promise<void>;
	/** Flow control; a failure is harmless (the next ack covers it), the session ignores it. */
	ack(key: string, seq: number): Promise<void>;
	createDecoder(
		canvas: CanvasLike,
		onProblem: (p: DecoderProblem) => void,
		onDraw: () => void
	): CameraDecoder;
	now(): number;
};

export const defaultSessionDeps: SessionDeps = {
	createChannel: () => new Channel<unknown>(),
	subscribe: cameraSubscribe,
	unsubscribe: cameraUnsubscribe,
	ack: cameraAck,
	createDecoder: (canvas, onProblem, onDraw) =>
		createCameraDecoder(canvas, onProblem, undefined, onDraw),
	now: () => Date.now()
};

// One chain per key: a hung subscribe for one widget must not stall the others.
const tails = new Map<string, Promise<unknown>>();
function enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
	const run = (tails.get(key) ?? Promise.resolve()).then(work);
	const tail = run.catch(() => undefined);
	tails.set(key, tail);
	void tail.then(() => {
		if (tails.get(key) === tail) tails.delete(key);
	});
	return run;
}

/** Start one subscription; returns its teardown. */
export function startCameraSession(
	key: string,
	canvas: CanvasLike,
	onView: ViewListener,
	deps: SessionDeps = defaultSessionDeps,
	hooks?: SessionHooks
): () => void {
	let stopped = false;
	let stalledLive = false;
	let unsubscribed = false;
	let model = initialModel(deps.now());
	let shown: CameraView = 'connecting'; // the hook starts there
	const stats = createCameraStats(deps.now());
	const shouldAck = createAckPolicy();

	const dispatch = (e: ModelEvent) => {
		model = reduce(model, e, deps.now());
		const v = viewOf(model);
		if (stopped) return;
		// Only a live stall counts: a retrying/connecting wire means the backend is on it.
		const nowStalled = model.stalled && model.wire === 'live';
		if (nowStalled !== stalledLive) {
			stalledLive = nowStalled;
			if (nowStalled) hooks?.onStall();
			else hooks?.onStallCleared();
		}
		if (v === shown) return;
		shown = v;
		// Only live may leave pixels on screen: a later show starts black, not on a stale frame.
		if (v !== 'live') clearCanvas(canvas);
		onView(v, codecOf(model) ?? undefined);
	};
	const release = () => {
		if (unsubscribed) return;
		unsubscribed = true;
		void enqueue(key, () => deps.unsubscribe(key)).catch(() => undefined);
	};
	const onProblem = (p: DecoderProblem) => {
		dispatch({ type: 'problem', problem: p });
		if (p === 'unsupportedCodec' || p === 'decoderUnavailable') {
			// the backend would keep sending frames nobody can decode: stop it and go deaf
			channel.onmessage = () => undefined;
			release();
		}
	};
	const decoder = deps.createDecoder(canvas, onProblem, () => dispatch({ type: 'drawn' }));
	const channel = deps.createChannel();

	channel.onmessage = (msg) => {
		if (msg instanceof ArrayBuffer) {
			let parsed;
			try {
				parsed = parseMessage(msg);
			} catch {
				return; // a malformed message is dropped, the stream carries on
			}
			if (parsed.kind === 'config') {
				stats.config(parsed.codec, parsed.width, parsed.height);
				dispatch({ type: 'config', codec: parsed.codec });
				decoder.configure(parsed).catch(() => onProblem('unsupportedCodec'));
			} else {
				stats.frame({
					tsUs: parsed.tsUs,
					size: parsed.data.byteLength,
					keyframe: parsed.keyframe,
					nowMs: deps.now()
				});
				dispatch({ type: 'frame', keyframe: parsed.keyframe });
				if (parsed.keyframe) hooks?.onKeyframe();
				decoder.push(parsed);
				// Acks stay on during a decoder cooldown: they tell the backend the webview is alive, and
				// without them it drops the subscriber for any GOP longer than its ack deadline.
				if (shouldAck(parsed.keyframe)) deps.ack(key, parsed.seq).catch(() => undefined);
			}
		} else if (isStatusMsg(msg)) {
			dispatch({ type: 'status', msg });
		}
	};

	const timer = setInterval(() => {
		dispatch({ type: 'tick' });
		publishDiagnostics(stats.snapshot(deps.now(), decoder.counters()));
	}, STATS_INTERVAL_MS);

	void enqueue(key, async () => {
		if (stopped) return;
		if (!decoder.available()) {
			// nothing to subscribe for: the backend would stream into a browser that cannot decode
			unsubscribed = true;
			dispatch({ type: 'problem', problem: 'decoderUnavailable' });
			return;
		}
		const status = await deps.subscribe(channel, key);
		dispatch({ type: 'subscribed', status });
	}).catch((e: unknown) => dispatch({ type: 'subscribeFailed', refused: isRefusedError(e) }));

	return () => {
		stopped = true;
		clearInterval(timer);
		channel.onmessage = () => undefined;
		decoder.close();
		publishDiagnostics(null);
		release();
	};
}

/** A session that pauses while the page is hidden (no decoding, no network for a background tab). */
export function runCameraStream(
	key: string,
	canvas: CanvasLike,
	onView: ViewListener,
	deps: SessionDeps = defaultSessionDeps
): () => void {
	let stop: (() => void) | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let restartTimer: ReturnType<typeof setTimeout> | undefined;
	let rung = 0;

	const cancelRestart = () => {
		clearTimeout(restartTimer);
		restartTimer = undefined;
	};
	const restart = () => {
		restartTimer = undefined;
		rung++;
		stop?.(); // unsubscribe is queued before the new subscribe for this key
		clearCanvas(canvas);
		onView('connecting');
		stop = launch();
	};
	const hooks: SessionHooks = {
		// the ladder counts from the (re)start and the watchdog already used 10 s of it
		onStall: () => {
			cancelRestart();
			const at = RESTART_LADDER_MS[Math.min(rung, RESTART_LADDER_MS.length - 1)];
			restartTimer = setTimeout(restart, Math.max(0, at - WATCHDOG_MS));
		},
		onStallCleared: cancelRestart,
		onKeyframe: () => {
			rung = 0;
		}
	};
	const launch = () => startCameraSession(key, canvas, onView, deps, hooks);
	stop = launch();

	const onVisibility = () => {
		if (document.hidden) {
			timer ??= setTimeout(() => {
				timer = undefined;
				cancelRestart();
				stop?.();
				stop = null;
			}, HIDE_DEBOUNCE_MS);
			return;
		}
		clearTimeout(timer);
		timer = undefined;
		if (!stop) {
			clearCanvas(canvas); // the paused session's last frame must not flash before the new one
			onView('connecting');
			stop = launch();
		}
	};
	document.addEventListener('visibilitychange', onVisibility);
	onVisibility(); // a widget mounted in an already hidden page must not stream until the next event
	return () => {
		document.removeEventListener('visibilitychange', onVisibility);
		clearTimeout(timer);
		cancelRestart();
		stop?.();
	};
}
