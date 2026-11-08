// WebCodecs adapter for the camera stream. Everything the browser provides (VideoDecoder, chunk
// construction, requestAnimationFrame, the 2D canvas) comes in through `DecoderDeps`, so tests
// inject fakes. Policy: ignore deltas until a keyframe after each configure, keep only the newest
// decoded frame and draw it on the next animation frame, close every VideoFrame exactly once.

import type { ConfigMsg, FrameMsg } from './camera-protocol';

export type FrameLike = { close(): void; displayWidth?: number; displayHeight?: number };

export type DecoderConfig = {
	codec: string;
	description: Uint8Array;
	optimizeForLatency: boolean;
};

export type DecoderLike = {
	configure(config: DecoderConfig): void;
	decode(chunk: unknown): void;
	close(): void;
};

export type DecoderDeps = {
	isSupported(config: DecoderConfig): Promise<boolean>;
	create(init: { output(frame: FrameLike): void; error(e: unknown): void }): DecoderLike;
	chunk(init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }): unknown;
	schedule(cb: () => void): number;
	cancel(handle: number): void;
	now(): number;
};

export type CanvasLike = {
	width: number;
	height: number;
	getContext(id: '2d'): { drawImage(frame: never, x: number, y: number): void } | null;
};

export type DecoderProblem = 'unsupportedCodec' | 'decodeError';

export const ERROR_BURST = 3;
export const ERROR_WINDOW_MS = 10_000;

/** True once `limit` errors have landed inside the sliding window (pure, injected clock). */
export function createErrorBurst(limit = ERROR_BURST, windowMs = ERROR_WINDOW_MS) {
	let stamps: number[] = [];
	return (nowMs: number): boolean => {
		stamps = [...stamps.filter((t) => nowMs - t < windowMs), nowMs];
		return stamps.length >= limit;
	};
}

export const browserDeps = (): DecoderDeps => ({
	isSupported: async (config) => {
		const r = await VideoDecoder.isConfigSupported(config);
		return r.supported === true;
	},
	create: (init) => new VideoDecoder(init),
	chunk: (init) => new EncodedVideoChunk(init),
	schedule: (cb) => requestAnimationFrame(cb),
	cancel: (h) => cancelAnimationFrame(h),
	now: () => Date.now()
});

export type CameraDecoder = {
	configure(msg: ConfigMsg): Promise<void>;
	push(msg: FrameMsg): void;
	close(): void;
	/** Frames drawn, and frames discarded (gated deltas, superseded outputs, failed decodes). */
	counters(): { drawn: number; dropped: number };
};

export function createCameraDecoder(
	canvas: CanvasLike,
	onProblem: (p: DecoderProblem) => void,
	deps: DecoderDeps = browserDeps()
): CameraDecoder {
	const burst = createErrorBurst();
	let decoder: DecoderLike | null = null;
	let config: DecoderConfig | null = null;
	let generation = 0;
	let closed = false;
	let needKey = true;
	let pending: FrameLike | null = null;
	let raf = 0;
	let drawn = 0;
	let dropped = 0;

	// close() throws on a decoder the browser already closed after an error.
	const discard = () => {
		try {
			decoder?.close();
		} catch {
			// already closed
		}
		decoder = null;
	};

	const draw = () => {
		raf = 0;
		const frame = pending;
		pending = null;
		if (!frame) return;
		const w = frame.displayWidth ?? canvas.width;
		const h = frame.displayHeight ?? canvas.height;
		if (canvas.width !== w) canvas.width = w;
		if (canvas.height !== h) canvas.height = h;
		canvas.getContext('2d')?.drawImage(frame as never, 0, 0);
		frame.close();
		drawn++;
	};

	const output = (frame: FrameLike) => {
		if (closed) return frame.close();
		if (pending) {
			pending.close();
			dropped++;
		}
		pending = frame;
		if (!raf) raf = deps.schedule(draw);
	};

	const open = (cfg: DecoderConfig) => {
		decoder = deps.create({ output, error: onError });
		decoder.configure(cfg);
		needKey = true;
	};

	// A VideoDecoder is dead after an error: rebuild it from the last config unless errors keep
	// coming (3 in 10 s), which is reported instead of looping forever.
	const onError = () => {
		if (closed) return;
		dropped++;
		discard();
		if (burst(deps.now())) {
			onProblem('decodeError');
			return;
		}
		/* v8 ignore next -- a decoder only exists after configure(), which sets `config`. */
		if (config) open(config);
	};

	return {
		async configure(msg) {
			const mine = ++generation;
			discard();
			config = {
				codec: msg.codec,
				description: msg.description,
				optimizeForLatency: true
			};
			const ok = await deps.isSupported(config);
			if (closed || mine !== generation) return;
			if (!ok) return onProblem('unsupportedCodec');
			open(config);
		},
		push(msg) {
			if (!decoder) {
				dropped++;
				return;
			}
			if (needKey && !msg.keyframe) {
				dropped++;
				return;
			}
			needKey = false;
			try {
				decoder.decode(
					deps.chunk({
						type: msg.keyframe ? 'key' : 'delta',
						timestamp: msg.tsUs,
						data: msg.data
					})
				);
			} catch {
				onError();
			}
		},
		close() {
			closed = true;
			generation++;
			if (raf) deps.cancel(raf);
			raf = 0;
			pending?.close();
			pending = null;
			discard();
		},
		counters: () => ({ drawn, dropped })
	};
}
