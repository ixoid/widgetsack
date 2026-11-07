import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HwinfoStatus } from './hwinfo-types';

vi.mock('./hwinfo-commands', () => ({
	hwinfoConfigStatus: vi.fn(),
	hwinfoConnect: vi.fn(() => Promise.resolve())
}));

import { hwinfoConfigStatus, hwinfoConnect } from './hwinfo-commands';
import { hwinfoSource, refreshHwinfoCatalog } from './hwinfo-source';
import { createTelemetryHub } from '../../../core/telemetry';

const status: HwinfoStatus = {
	configured: true,
	pollSeconds: 2,
	enabled: ['gpu-power'],
	running: true,
	backend: 'registry',
	gadgetEnabled: true,
	detail: 'gadget registry · 10 readings',
	readings: [
		{
			slug: 'gpu-power',
			id: 'hw.gpu-power',
			label: 'GPU Power',
			sensor: 'GPU',
			unit: 'W',
			value: 70
		},
		{
			slug: 'gpu-clock',
			id: 'hw.gpu-clock',
			label: 'GPU Clock',
			sensor: 'GPU',
			unit: 'MHz',
			value: 1500
		}
	]
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(hwinfoConfigStatus).mockResolvedValue(status);
});

describe('hwinfo-source', () => {
	it('start refreshes the catalog, connects the worker and returns a no-op stop', async () => {
		const stop = await hwinfoSource.start(createTelemetryHub());
		expect(hwinfoConfigStatus).toHaveBeenCalledTimes(1);
		expect(hwinfoConnect).toHaveBeenCalledTimes(1);
		expect(() => stop()).not.toThrow();
		expect(hwinfoSource.id).toBe('hwinfo');
	});

	it('the catalog carries the well-known ids plus the enabled readings', async () => {
		await refreshHwinfoCatalog();
		const ids = hwinfoSource.catalog?.() ?? [];
		expect(ids).toContain('hw.status');
		expect(ids).toContain('hw.cpu.temp');
		expect(ids).toContain('hw.gpu-power');
		expect(ids).not.toContain('hw.gpu-clock');
		const entry = hwinfoSource.catalogEntries?.().find((e) => e.id === 'hw.gpu-power');
		expect(entry).toEqual({ id: 'hw.gpu-power', label: 'GPU Power', unit: 'W' });
	});

	it('a failed status read keeps the previous catalog and a failed connect is swallowed', async () => {
		await refreshHwinfoCatalog();
		vi.mocked(hwinfoConfigStatus).mockRejectedValueOnce(new Error('no backend'));
		await expect(refreshHwinfoCatalog()).resolves.toEqual(status);
		expect(hwinfoSource.catalog?.()).toContain('hw.gpu-power');
		vi.mocked(hwinfoConnect).mockRejectedValueOnce(new Error('offline'));
		await expect(hwinfoSource.start(createTelemetryHub())).resolves.toBeTypeOf('function');
	});
});
