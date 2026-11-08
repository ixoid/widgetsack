import { describe, expect, it, vi } from 'vitest';
import { getDiagnostics, publishDiagnostics, subscribeDiagnostics } from './camera-diagnostics';
import type { StatsSnapshot } from './camera-stats';

const SNAP: StatsSnapshot = {
	codec: 'avc1.4d002a',
	width: 1920,
	height: 1080,
	gopSeconds: 2,
	ttfkMs: 400,
	kbps: 1500,
	frames: 10,
	dropped: 0
};

describe('camera diagnostics store', () => {
	it('notifies subscribers until they unsubscribe', () => {
		const cb = vi.fn();
		const off = subscribeDiagnostics(cb);
		publishDiagnostics(SNAP);
		expect(getDiagnostics()).toBe(SNAP);
		expect(cb).toHaveBeenCalledTimes(1);
		off();
		publishDiagnostics(null);
		expect(cb).toHaveBeenCalledTimes(1);
		expect(getDiagnostics()).toBeNull();
	});
});
