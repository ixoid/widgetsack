import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./server-check-commands', () => ({
	serverCheckConfigStatus: vi.fn(),
	serverCheckConnect: vi.fn(() => Promise.resolve())
}));

import { serverCheckConfigStatus, serverCheckConnect } from './server-check-commands';
import { refreshServerCheckCatalog, serverCheckSource } from './server-check-source';
import { createTelemetryHub } from '../../../core/telemetry';
import { emptyTarget } from './serverCheckModel';

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(serverCheckConfigStatus).mockResolvedValue({
		configured: true,
		targets: [emptyTarget('vps'), emptyTarget('nas')]
	});
});

describe('serverCheckSource', () => {
	it('start refreshes the catalog and kicks the backend worker', async () => {
		const stop = await serverCheckSource.start(createTelemetryHub());
		expect(serverCheckConnect).toHaveBeenCalled();
		const ids = serverCheckSource.catalog?.() ?? [];
		expect(ids).toEqual(
			expect.arrayContaining(['srv.status', 'srv.list', 'srv.vps.ms', 'srv.nas.up'])
		);
		const entries = serverCheckSource.catalogEntries?.() ?? [];
		expect(entries.find((e) => e.id === 'srv.vps.ms')?.unit).toBe('ms');
		expect(() => stop()).not.toThrow();
	});

	it('keeps the previous list when the status call fails, and survives a failing connect', async () => {
		await refreshServerCheckCatalog();
		vi.mocked(serverCheckConfigStatus).mockRejectedValueOnce(new Error('no backend'));
		expect(await refreshServerCheckCatalog()).toEqual(['vps', 'nas']);
		vi.mocked(serverCheckConnect).mockRejectedValueOnce(new Error('no backend'));
		await expect(serverCheckSource.start(createTelemetryHub())).resolves.toBeTypeOf('function');
	});
});
