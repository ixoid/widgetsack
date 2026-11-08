import { describe, expect, it } from 'vitest';
import { createCameraStats } from './camera-stats';

const NONE = { superseded: 0, dropped: 0 };

describe('camera stats', () => {
	it('starts empty', () => {
		const s = createCameraStats(1000);
		expect(s.snapshot(1000, NONE)).toEqual({
			codec: null,
			width: null,
			height: null,
			gopSeconds: null,
			ttfkMs: null,
			kbps: null,
			frames: 0,
			superseded: 0,
			dropped: 0
		});
	});

	it('forgets the old stream clock on a new CONFIG (reconnect)', () => {
		const s = createCameraStats(0);
		const key = (tsUs: number) => s.frame({ tsUs, size: 10, keyframe: true, nowMs: 10 });
		key(50_000_000);
		key(52_000_000);
		s.config('avc1.4d002a', 640, 360);
		expect(s.snapshot(20, NONE).gopSeconds).toBeNull();
		key(0); // the clock restarted near zero
		key(2_000_000);
		expect(s.snapshot(20, NONE).gopSeconds).toBeCloseTo(2, 5);
	});

	it('derives GOP, time to first keyframe and bitrate from a synthetic sequence', () => {
		const s = createCameraStats(1000);
		s.config('avc1.4d002a', 1920, 1080);
		// 15 fps, a keyframe every 30 frames (2 s), 1250 bytes per frame
		for (let i = 0; i <= 90; i++) {
			s.frame({
				tsUs: Math.round((i * 1e6) / 15),
				size: 1250,
				keyframe: i % 30 === 0,
				nowMs: 1500 + Math.round((i * 1000) / 15)
			});
		}
		const snap = s.snapshot(1500 + 6000, { superseded: 7, dropped: 4 });
		expect(snap.codec).toBe('avc1.4d002a');
		expect([snap.width, snap.height]).toEqual([1920, 1080]);
		expect(snap.ttfkMs).toBe(500);
		expect(snap.gopSeconds).toBeCloseTo(2, 5);
		expect(snap.frames).toBe(91);
		expect(snap.superseded).toBe(7);
		expect(snap.dropped).toBe(4);
		// the last 5 s hold ~75 frames x 1250 B over a ~5 s span = ~150 kbit/s
		expect(snap.kbps).toBeGreaterThan(140);
		expect(snap.kbps).toBeLessThan(160);
	});

	it('keeps the first TTFK and uses a 1 s minimum span for a fresh stream', () => {
		const s = createCameraStats(0);
		s.frame({ tsUs: 0, size: 1000, keyframe: true, nowMs: 200 });
		s.frame({ tsUs: 66_000, size: 1000, keyframe: false, nowMs: 300 });
		s.frame({ tsUs: 2_000_000, size: 1000, keyframe: true, nowMs: 2300 });
		const snap = s.snapshot(2300, NONE);
		expect(snap.ttfkMs).toBe(200);
		expect(snap.gopSeconds).toBe(2);
		expect(snap.kbps).toBeCloseTo((3000 * 8) / 2100, 5);
	});

	it('reports no bitrate once all samples aged out of the window', () => {
		const s = createCameraStats(0, 5000);
		s.frame({ tsUs: 0, size: 100, keyframe: true, nowMs: 100 });
		expect(s.snapshot(10_000, NONE).kbps).toBeNull();
	});

	it('averages the GOP over the most recent keyframes only', () => {
		const s = createCameraStats(0);
		// 4 early keyframes 10 s apart, then 8 one second apart: the early ones fall out of history
		const stamps = [0, 10, 20, 30, 31, 32, 33, 34, 35, 36, 37, 38];
		for (const [i, t] of stamps.entries()) {
			s.frame({ tsUs: t * 1_000_000, size: 1, keyframe: true, nowMs: i });
		}
		expect(s.snapshot(12, NONE).gopSeconds).toBe(1);
	});
});
