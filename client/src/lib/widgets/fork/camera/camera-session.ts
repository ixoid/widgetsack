// One live camera session (non-React): Channel -> protocol -> decoder, plus the lifecycle rules.
// Subscribe/unsubscribe go through one promise chain so a StrictMode mount/unmount/mount (or a
// hide/show) can never reorder them on the way to the backend. `runCameraStream` adds the
// visibility rule: hidden for 1.5 s -> unsubscribe, visible again -> resubscribe.

import { Channel } from '@tauri-apps/api/core';
import { cameraSubscribe, cameraUnsubscribe } from './camera-commands';
import {
	createCameraDecoder,
	type CameraDecoder,
	type CanvasLike,
	type DecoderProblem
} from './camera-decoder';
import { publishDiagnostics } from './camera-diagnostics';
import { isStatusMsg, parseMessage } from './camera-protocol';
import { createCameraStats } from './camera-stats';
import type { CameraStatus } from './camera-types';
import { viewFromStatus, viewFromWire, type CameraView } from './camera-view';

export const HIDE_DEBOUNCE_MS = 1500;
export const STATS_INTERVAL_MS = 1000;

export type SessionDeps = {
	createChannel(): Channel<unknown>;
	subscribe(channel: Channel<unknown>, key: string): Promise<CameraStatus>;
	unsubscribe(key: string): Promise<void>;
	createDecoder(canvas: CanvasLike, onProblem: (p: DecoderProblem) => void): CameraDecoder;
	now(): number;
};

export const defaultSessionDeps: SessionDeps = {
	createChannel: () => new Channel<unknown>(),
	subscribe: cameraSubscribe,
	unsubscribe: cameraUnsubscribe,
	createDecoder: (canvas, onProblem) => createCameraDecoder(canvas, onProblem),
	now: () => Date.now()
};

let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
	const run = tail.then(work);
	tail = run.catch(() => undefined);
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
	let heard = false;
	const stats = createCameraStats(deps.now());
	const show = (v: CameraView) => {
		if (!stopped) onView(v);
	};
	const decoder = deps.createDecoder(canvas, show);
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
				decoder.configure(parsed).catch(() => show('unsupportedCodec'));
			} else {
				stats.frame({
					tsUs: parsed.tsUs,
					size: parsed.data.byteLength,
					keyframe: parsed.keyframe,
					nowMs: deps.now()
				});
				decoder.push(parsed);
			}
		} else if (isStatusMsg(msg)) {
			heard = true;
			show(viewFromStatus(msg));
		}
	};

	const timer = setInterval(
		() => publishDiagnostics(stats.snapshot(deps.now(), decoder.counters().dropped)),
		STATS_INTERVAL_MS
	);

	void enqueue(async () => {
		if (stopped) return;
		const status = await deps.subscribe(channel, key);
		if (!heard) show(viewFromWire(status.state));
	}).catch(() => show('unavailable'));

	return () => {
		stopped = true;
		clearInterval(timer);
		channel.onmessage = () => undefined;
		decoder.close();
		publishDiagnostics(null);
		void enqueue(() => deps.unsubscribe(key)).catch(() => undefined);
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
			onView('connecting');
			stop = startCameraSession(key, canvas, onView, deps);
		}
	};
	document.addEventListener('visibilitychange', onVisibility);
	return () => {
		document.removeEventListener('visibilitychange', onVisibility);
		clearTimeout(timer);
		stop?.();
	};
}
