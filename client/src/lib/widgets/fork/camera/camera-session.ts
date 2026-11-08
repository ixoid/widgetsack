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
	initialModel,
	isRefusedError,
	reduce,
	viewOf,
	type CameraView,
	type DecoderProblem,
	type ModelEvent
} from './camera-model';
import { isStatusMsg, parseMessage } from './camera-protocol';
import { createCameraStats } from './camera-stats';
import type { CameraStatus } from './camera-types';

export const HIDE_DEBOUNCE_MS = 1500;
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
	onView: (v: CameraView) => void,
	deps: SessionDeps = defaultSessionDeps
): () => void {
	let stopped = false;
	let unsubscribed = false;
	let model = initialModel(deps.now());
	let shown: CameraView = 'connecting'; // the hook starts there
	const stats = createCameraStats(deps.now());
	const shouldAck = createAckPolicy();

	const dispatch = (e: ModelEvent) => {
		model = reduce(model, e, deps.now());
		const v = viewOf(model);
		if (stopped || v === shown) return;
		shown = v;
		// Only live may leave pixels on screen: a later show starts black, not on a stale frame.
		if (v !== 'live') clearCanvas(canvas);
		onView(v);
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
				dispatch({ type: 'config' });
				decoder.configure(parsed).catch(() => onProblem('unsupportedCodec'));
			} else {
				stats.frame({
					tsUs: parsed.tsUs,
					size: parsed.data.byteLength,
					keyframe: parsed.keyframe,
					nowMs: deps.now()
				});
				dispatch({ type: 'frame', keyframe: parsed.keyframe });
				decoder.push(parsed);
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
	onView: (v: CameraView) => void,
	deps: SessionDeps = defaultSessionDeps
): () => void {
	let stop: (() => void) | null = startCameraSession(key, canvas, onView, deps);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const onVisibility = () => {
		if (document.hidden) {
			timer ??= setTimeout(() => {
				timer = undefined;
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
			stop = startCameraSession(key, canvas, onView, deps);
		}
	};
	document.addEventListener('visibilitychange', onVisibility);
	onVisibility(); // a widget mounted in an already hidden page must not stream until the next event
	return () => {
		document.removeEventListener('visibilitychange', onVisibility);
		clearTimeout(timer);
		stop?.();
	};
}
