import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	browserDeps,
	createCameraDecoder,
	createErrorBurst,
	COOLDOWN_MS,
	QUEUE_LIMIT,
	clearCanvas,
	type CanvasLike,
	type DecoderConfig,
	type DecoderDeps,
	type DecoderLike,
	type FrameLike
} from './camera-decoder';
import type { ConfigMsg, FrameMsg } from './camera-protocol';

const CONFIG: ConfigMsg = {
	kind: 'config',
	seq: 0,
	width: 1920,
	height: 1080,
	codec: 'avc1.4d002a',
	description: Uint8Array.of(1, 2, 3)
};
const frame = (seq: number, keyframe: boolean): FrameMsg => ({
	kind: 'frame',
	seq,
	keyframe,
	tsUs: seq * 1000,
	data: Uint8Array.of(0, 0, 0, 1, 9)
});

type FakeDecoder = {
	cfg?: DecoderConfig;
	chunks: unknown[];
	closed: boolean;
	throwOnDecode: boolean;
	throwOnClose: boolean;
	output(f: FrameLike): void;
	error(e: unknown): void;
};

function setup(supported = true, available = true) {
	const decoders: FakeDecoder[] = [];
	let rafCb: (() => void) | null = null;
	let clock = 0;
	let queue = 0;
	const cancel = vi.fn();
	const deps: DecoderDeps = {
		available: () => available,
		isSupported: vi.fn(async () => supported),
		create: (init) => {
			const d: FakeDecoder = {
				chunks: [],
				closed: false,
				throwOnDecode: false,
				throwOnClose: false,
				output: init.output,
				error: init.error
			};
			decoders.push(d);
			const impl: DecoderLike = {
				get decodeQueueSize() {
					return queue;
				},
				configure: (c) => {
					d.cfg = c;
				},
				decode: (c) => {
					if (d.throwOnDecode) throw new Error('bad');
					d.chunks.push(c);
				},
				close: () => {
					d.closed = true;
					if (d.throwOnClose) throw new Error('closed');
				}
			};
			return impl;
		},
		chunk: (i) => i,
		schedule: (cb) => {
			rafCb = cb;
			return 7;
		},
		cancel,
		now: () => clock
	};
	const ctx = { drawImage: vi.fn(), clearRect: vi.fn() };
	const canvas: CanvasLike = { width: 0, height: 0, getContext: () => ctx };
	const problems: string[] = [];
	const draws: number[] = [];
	const dec = createCameraDecoder(
		canvas,
		(p) => problems.push(p),
		deps,
		() => draws.push(1)
	);
	const mkFrame = (w = 640, h = 360) => ({ close: vi.fn(), displayWidth: w, displayHeight: h });
	return {
		dec,
		deps,
		decoders,
		canvas,
		ctx,
		problems,
		draws,
		setQueue: (n: number) => (queue = n),
		cancel,
		mkFrame,
		flush: () => rafCb?.(),
		tick: (ms: number) => (clock += ms)
	};
}

describe('camera decoder', () => {
	it('configures with the avcC description and latency hint', async () => {
		const t = setup();
		await t.dec.configure(CONFIG);
		expect(t.decoders[0].cfg).toEqual({
			codec: 'avc1.4d002a',
			description: CONFIG.description,
			optimizeForLatency: true
		});
	});

	it('reports an unsupported codec and never creates a decoder', async () => {
		const t = setup(false);
		await t.dec.configure(CONFIG);
		expect(t.problems).toEqual(['unsupportedCodec']);
		expect(t.decoders).toHaveLength(0);
	});

	it('reports decoderUnavailable when the browser has no VideoDecoder', async () => {
		const t = setup(true, false);
		await t.dec.configure(CONFIG);
		expect(t.problems).toEqual(['decoderUnavailable']);
		expect(t.decoders).toHaveLength(0);
	});

	it('drops frames until a decoder exists, then deltas until the first keyframe', async () => {
		const t = setup();
		t.dec.push(frame(0, true)); // before configure
		await t.dec.configure(CONFIG);
		t.dec.push(frame(1, false));
		t.dec.push(frame(2, true));
		t.dec.push(frame(3, false));
		expect(t.decoders[0].chunks).toEqual([
			{ type: 'key', timestamp: 2000, data: frame(2, true).data },
			{ type: 'delta', timestamp: 3000, data: frame(3, false).data }
		]);
		expect(t.dec.counters().dropped).toBe(2);
	});

	it('a re-configure gates deltas again and closes the old decoder', async () => {
		const t = setup();
		await t.dec.configure(CONFIG);
		t.dec.push(frame(0, true));
		await t.dec.configure(CONFIG);
		expect(t.decoders[0].closed).toBe(true);
		t.dec.push(frame(1, false));
		expect(t.decoders[1].chunks).toHaveLength(0);
	});

	it('a configure superseded while checking support is abandoned', async () => {
		const t = setup();
		const first = t.dec.configure(CONFIG);
		await t.dec.configure(CONFIG);
		await first;
		expect(t.decoders).toHaveLength(1);
	});

	it('draws only the newest frame on the animation frame and closes the rest', async () => {
		const t = setup();
		await t.dec.configure(CONFIG);
		const a = t.mkFrame(640, 360);
		const b = t.mkFrame(800, 450);
		t.decoders[0].output(a);
		t.decoders[0].output(b);
		expect(a.close).toHaveBeenCalledTimes(1);
		t.flush();
		expect(t.ctx.drawImage).toHaveBeenCalledTimes(1);
		expect(t.ctx.drawImage).toHaveBeenCalledWith(b, 0, 0);
		expect(b.close).toHaveBeenCalledTimes(1);
		expect([t.canvas.width, t.canvas.height]).toEqual([800, 450]);
		expect(t.dec.counters()).toEqual({ drawn: 1, superseded: 1, dropped: 0 });
		expect(t.draws).toHaveLength(1);
		t.flush(); // nothing pending: no draw
		expect(t.ctx.drawImage).toHaveBeenCalledTimes(1);
	});

	it('draws without a draw listener (it is optional)', async () => {
		const t = setup();
		const quiet = createCameraDecoder(t.canvas, () => undefined, t.deps);
		await quiet.configure(CONFIG);
		t.decoders[0].output(t.mkFrame());
		t.flush();
		expect(quiet.counters().drawn).toBe(1);
	});

	it('falls back to the canvas size and tolerates a missing 2D context', async () => {
		const t = setup();
		t.canvas.width = 10;
		t.canvas.height = 20;
		t.canvas.getContext = () => null;
		await t.dec.configure(CONFIG);
		const f = { close: vi.fn() };
		t.decoders[0].output(f);
		t.flush();
		expect([t.canvas.width, t.canvas.height]).toEqual([10, 20]);
		expect(f.close).toHaveBeenCalledTimes(1);
	});

	it('closes the frame even when drawImage throws', async () => {
		const t = setup();
		await t.dec.configure(CONFIG);
		t.ctx.drawImage.mockImplementationOnce(() => {
			throw new Error('canvas lost');
		});
		const f = t.mkFrame();
		t.decoders[0].output(f);
		expect(() => t.flush()).toThrow('canvas lost');
		expect(f.close).toHaveBeenCalledTimes(1);
		expect(t.dec.counters().drawn).toBe(0);
	});

	it('clearCanvas blanks the whole canvas and tolerates a missing context', () => {
		const t = setup();
		t.canvas.width = 30;
		t.canvas.height = 20;
		clearCanvas(t.canvas);
		expect(t.ctx.clearRect).toHaveBeenCalledWith(0, 0, 30, 20);
		t.canvas.getContext = () => null;
		expect(() => clearCanvas(t.canvas)).not.toThrow();
	});

	it('close() tears down: closes decoder and pending frame, cancels the animation frame', async () => {
		const t = setup();
		await t.dec.configure(CONFIG);
		const f = t.mkFrame();
		t.decoders[0].output(f);
		t.decoders[0].throwOnClose = true; // an already-closed decoder must not throw out of close()
		t.dec.close();
		expect(t.decoders[0].closed).toBe(true);
		expect(f.close).toHaveBeenCalledTimes(1);
		expect(t.cancel).toHaveBeenCalledWith(7);
		const late = t.mkFrame();
		t.decoders[0].output(late);
		expect(late.close).toHaveBeenCalledTimes(1);
		await t.dec.configure(CONFIG);
		expect(t.decoders).toHaveLength(1);
		t.dec.close(); // idempotent
	});

	it('close() without a pending animation frame cancels nothing', () => {
		const t = setup();
		t.dec.close();
		expect(t.cancel).not.toHaveBeenCalled();
	});

	it('rebuilds after a decode error, reports decodeError on the third within 10 s', async () => {
		const t = setup();
		await t.dec.configure(CONFIG);
		t.decoders[0].error(new Error('x'));
		expect(t.decoders).toHaveLength(2);
		expect(t.decoders[1].cfg?.codec).toBe('avc1.4d002a');
		t.tick(1000);
		t.dec.push(frame(1, false)); // gated again after the rebuild
		expect(t.decoders[1].chunks).toHaveLength(0);
		t.decoders[1].throwOnDecode = true;
		t.dec.push(frame(2, true)); // a throwing decode counts as an error too
		expect(t.decoders).toHaveLength(3);
		t.decoders[2].error(new Error('x'));
		expect(t.problems).toEqual(['decodeError']);
		expect(t.decoders).toHaveLength(3);
	});

	it('after a burst: stays off, then a keyframe 10 s later rebuilds it from the last CONFIG', async () => {
		const t = setup();
		await t.dec.configure(CONFIG);
		t.decoders[0].error(new Error('x'));
		t.decoders[1].error(new Error('x'));
		t.decoders[2].error(new Error('x')); // third inside 10 s: burst
		expect(t.problems).toEqual(['decodeError']);
		expect(t.dec.cooling()).toBe(true);
		expect(t.decoders).toHaveLength(3);
		const dropped = t.dec.counters().dropped;
		t.dec.push(frame(1, true)); // a keyframe inside the cool-down is not enough
		t.tick(COOLDOWN_MS - 1);
		t.dec.push(frame(2, true));
		t.tick(1);
		t.dec.push(frame(3, false)); // after the cool-down a delta is not enough either
		expect(t.dec.counters().dropped).toBe(dropped + 3);
		expect(t.dec.cooling()).toBe(true);
		expect(t.decoders).toHaveLength(3);
		t.dec.push(frame(4, true));
		expect(t.dec.cooling()).toBe(false);
		expect(t.decoders).toHaveLength(4);
		expect(t.decoders[3].cfg?.codec).toBe('avc1.4d002a');
		expect(t.decoders[3].chunks).toHaveLength(1); // the keyframe went into the new decoder
	});

	it('a new CONFIG ends the cool-down at once', async () => {
		const t = setup();
		await t.dec.configure(CONFIG);
		for (let i = 0; i < 3; i++) t.decoders.at(-1)?.error(new Error('x'));
		expect(t.dec.cooling()).toBe(true);
		await t.dec.configure(CONFIG);
		expect(t.dec.cooling()).toBe(false);
	});

	it('reports whether the browser can decode at all', () => {
		expect(setup().dec.available()).toBe(true);
		expect(setup(true, false).dec.available()).toBe(false);
	});

	it('ignores errors after close', async () => {
		const t = setup();
		await t.dec.configure(CONFIG);
		t.dec.close();
		t.decoders[0].error(new Error('x'));
		expect(t.decoders).toHaveLength(1);
	});
});

describe('backpressure and counters', () => {
	it('drops deltas while the decode queue is over the limit, resumes on a keyframe', async () => {
		const t = setup();
		await t.dec.configure(CONFIG);
		t.dec.push(frame(0, true));
		t.setQueue(QUEUE_LIMIT); // at the limit is still fine
		t.dec.push(frame(1, false));
		t.setQueue(QUEUE_LIMIT + 1);
		t.dec.push(frame(2, false)); // over: dropped, gate closes
		t.setQueue(0);
		t.dec.push(frame(3, false)); // queue recovered but the gate waits for a keyframe
		t.setQueue(QUEUE_LIMIT + 5);
		t.dec.push(frame(4, true)); // a keyframe is never dropped for the backlog
		t.setQueue(0);
		t.dec.push(frame(5, false));
		expect(t.decoders[0].chunks.map((c) => (c as { timestamp: number }).timestamp)).toEqual([
			0, 1000, 4000, 5000
		]);
		expect(t.dec.counters()).toEqual({ drawn: 0, superseded: 0, dropped: 2 });
	});

	it('counts supersession separately from drops', async () => {
		const t = setup();
		await t.dec.configure(CONFIG);
		t.decoders[0].output(t.mkFrame());
		t.decoders[0].output(t.mkFrame());
		t.decoders[0].output(t.mkFrame());
		expect(t.dec.counters()).toEqual({ drawn: 0, superseded: 2, dropped: 0 });
		t.flush();
		expect(t.dec.counters()).toEqual({ drawn: 1, superseded: 2, dropped: 0 });
	});

	it('counts gate discards and decode errors as dropped, not superseded', async () => {
		const t = setup();
		t.dec.push(frame(0, true)); // no decoder yet
		await t.dec.configure(CONFIG);
		t.dec.push(frame(1, false)); // before the keyframe gate
		t.decoders[0].error(new Error('x')); // decode error
		expect(t.dec.counters()).toEqual({ drawn: 0, superseded: 0, dropped: 3 });
	});
});

describe('createErrorBurst', () => {
	it('fires at the limit inside the window only', () => {
		const hit = createErrorBurst(3, 10_000);
		expect(hit(0)).toBe(false);
		expect(hit(5000)).toBe(false);
		expect(hit(9000)).toBe(true);
		const slow = createErrorBurst(3, 10_000);
		slow(0);
		slow(6000);
		expect(slow(12_000)).toBe(false); // the first one aged out
	});
});

describe('browserDeps', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('reports no VideoDecoder when the global is absent', () => {
		vi.stubGlobal('VideoDecoder', undefined);
		expect(browserDeps().available()).toBe(false);
	});

	it('wraps the WebCodecs globals', async () => {
		const made: unknown[] = [];
		class FakeVideoDecoder {
			static isConfigSupported = vi.fn(async (c: DecoderConfig) => ({
				supported: c.codec === 'ok'
			}));
			constructor(init: unknown) {
				made.push(init);
			}
		}
		class FakeChunk {
			constructor(public init: unknown) {}
		}
		vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
		vi.stubGlobal('EncodedVideoChunk', FakeChunk);
		vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
			cb();
			return 5;
		});
		const cancel = vi.fn();
		vi.stubGlobal('cancelAnimationFrame', cancel);
		const d = browserDeps();
		expect(d.available()).toBe(true);
		const cfg = { description: new Uint8Array(1), optimizeForLatency: true };
		expect(await d.isSupported({ ...cfg, codec: 'ok' })).toBe(true);
		expect(await d.isSupported({ ...cfg, codec: 'no' })).toBe(false);
		const init = { output: () => undefined, error: () => undefined };
		expect(d.create(init)).toBeInstanceOf(FakeVideoDecoder);
		expect(made).toEqual([init]);
		const chunkInit = { type: 'key' as const, timestamp: 1, data: new Uint8Array(1) };
		expect(d.chunk(chunkInit)).toBeInstanceOf(FakeChunk);
		const cb = vi.fn();
		expect(d.schedule(cb)).toBe(5);
		expect(cb).toHaveBeenCalled();
		d.cancel(5);
		expect(cancel).toHaveBeenCalledWith(5);
		expect(typeof d.now()).toBe('number');
	});
});
