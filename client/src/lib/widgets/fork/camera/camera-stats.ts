// Pure stream statistics for the spike readout: GOP length, time to first keyframe, bitrate.
// Time is injected (`nowMs`), so tests drive synthetic sequences.

export type StatsSnapshot = {
	codec: string | null;
	width: number | null;
	height: number | null;
	/** Mean keyframe interval in seconds (stream timestamps), null before two keyframes. */
	gopSeconds: number | null;
	/** Milliseconds from subscribe to the first keyframe, null until one arrives. */
	ttfkMs: number | null;
	kbps: number | null;
	frames: number;
	dropped: number;
};

const KEY_HISTORY = 8;
const MIN_SPAN_MS = 1000;

export function createCameraStats(startMs: number, windowMs = 5000) {
	let codec: string | null = null;
	let width: number | null = null;
	let height: number | null = null;
	let ttfkMs: number | null = null;
	let frames = 0;
	let keyTs: number[] = [];
	let samples: { at: number; bytes: number }[] = [];

	return {
		config(c: string, w: number, h: number) {
			codec = c;
			width = w;
			height = h;
		},
		frame(f: { tsUs: number; size: number; keyframe: boolean; nowMs: number }) {
			frames++;
			samples.push({ at: f.nowMs, bytes: f.size });
			if (!f.keyframe) return;
			ttfkMs ??= f.nowMs - startMs;
			keyTs = [...keyTs, f.tsUs].slice(-KEY_HISTORY);
		},
		snapshot(nowMs: number, dropped: number): StatsSnapshot {
			samples = samples.filter((s) => nowMs - s.at <= windowMs);
			let kbps: number | null = null;
			if (samples.length > 0) {
				const span = Math.max(nowMs - samples[0].at, MIN_SPAN_MS);
				const bytes = samples.reduce((n, s) => n + s.bytes, 0);
				kbps = (bytes * 8) / span;
			}
			const gopSeconds =
				keyTs.length >= 2 ? (keyTs[keyTs.length - 1] - keyTs[0]) / (keyTs.length - 1) / 1e6 : null;
			return { codec, width, height, gopSeconds, ttfkMs, kbps, frames, dropped };
		}
	};
}
