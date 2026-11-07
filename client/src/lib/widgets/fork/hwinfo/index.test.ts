import { describe, expect, it, vi } from 'vitest';

// The settings pane + source call Tauri (no runtime in tests) — stub the command module + clipboard.
vi.mock('./hwinfo-commands', () => ({
	hwinfoConfigStatus: () =>
		Promise.resolve({
			configured: false,
			pollSeconds: 2,
			enabled: [],
			running: false,
			backend: 'none',
			gadgetEnabled: null,
			detail: 'HWiNFO64 is not running',
			readings: []
		}),
	saveHwinfoConfig: () => Promise.resolve(),
	hwinfoConnect: () => Promise.resolve(),
	hwinfoReconnect: () => Promise.resolve(),
	hwinfoDisconnect: () => Promise.resolve()
}));
vi.mock('../../../overlay', () => ({ copyToClipboard: () => Promise.resolve(true) }));

import { registerHwinfoPlugin } from './index';
import { listPlugins } from '../../plugin';
import { sourceCatalogEntries } from '../../../core/plugin';

registerHwinfoPlugin();

describe('hwinfo plugin', () => {
	it('registers as a plugin with a settings panel, a source and the hw.status dot', () => {
		const p = listPlugins().find((x) => x.id === 'hwinfo');
		expect(p).toMatchObject({ id: 'hwinfo', name: 'Hardware (HWiNFO)', statusSensor: 'hw.status' });
		expect(p?.settings).toBeTruthy();
		expect(p?.sources?.some((s) => s.id === 'hwinfo')).toBe(true);
		// No widget type of its own: the ids bind to the built-in meters.
		expect(p?.widgets ?? []).toEqual([]);
	});

	it('always exposes the well-known hw.* ids in the catalog', () => {
		const ids = sourceCatalogEntries().map((e) => e.id);
		expect(ids).toEqual(
			expect.arrayContaining(['hw.status', 'hw.cpu.temp', 'hw.cpu.clock.max', 'hw.cpu.power'])
		);
	});
});
