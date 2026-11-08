import { describe, expect, it, vi } from 'vitest';

vi.mock('./notifyfeed-commands', () => ({
	notifyConfigStatus: vi.fn(),
	saveNotifyConfig: vi.fn(),
	notifyConnect: vi.fn(() => Promise.resolve()),
	notifyReconnect: vi.fn(() => Promise.resolve()),
	notifyDisconnect: vi.fn(() => Promise.resolve()),
	notifyMarkAllSeen: vi.fn(() => Promise.resolve())
}));

import { registerNotifyFeedPlugin } from './notifyfeed-plugin';
import { getMeta } from '../../../core/widget';
import { listPlugins } from '../../plugin';
import { notifyConnect } from './notifyfeed-commands';
import { createTelemetryHub } from '../../../core/telemetry';

registerNotifyFeedPlugin();

describe('notifyfeed plugin', () => {
	it('registers the notifyfeed widget with a STATIC sensors map, interactive, and the source', () => {
		const meta = getMeta('notifyfeed');
		expect(meta).toBeTruthy();
		expect(meta?.binds).toBe('none');
		expect(meta?.interactive).toBe(true);
		expect(meta?.defaultConfig).toEqual({ title: '', maxRows: 20, showBody: true });
		expect(meta?.configFields?.map((f) => f.key)).toEqual([
			'title',
			'maxRows',
			'showBody',
			'color'
		]);
		expect(meta?.configFields?.every((f) => f.help)).toBe(true);
		// The map is config-INDEPENDENT — any instance config yields the same three ids.
		expect(meta?.sensors?.({})).toEqual({
			list: 'notify.list',
			count: 'notify.count',
			status: 'notify.status'
		});
		expect(meta?.sensors?.({ maxRows: 3, title: 'x' })).toEqual({
			list: 'notify.list',
			count: 'notify.count',
			status: 'notify.status'
		});
		const plugin = listPlugins().find((p) => p.id === 'notifyfeed');
		expect(plugin?.settings).toBeTruthy();
		// The source registers the full bindable catalog (the three meta `sensors` map ids).
		const source = plugin?.sources?.[0];
		expect(plugin?.sources?.map((s) => s.id)).toEqual(['notifyfeed']);
		expect(source?.catalog?.()).toEqual(['notify.list', 'notify.count', 'notify.status']);
		expect(source?.catalogEntries?.().map((e) => e.id)).toEqual([
			'notify.list',
			'notify.count',
			'notify.status'
		]);
		// Deliberately NO statusSensor: statusDotFrom would mislabel 'granted' as "Not connected".
		expect(plugin?.statusSensor).toBeUndefined();
	});

	it('starts the backend worker at app init — start() invokes the connect adapter', async () => {
		const source = listPlugins().find((p) => p.id === 'notifyfeed')?.sources?.[0];
		const stop = await source?.start(createTelemetryHub());
		expect(notifyConnect).toHaveBeenCalledTimes(1);
		// Window cleanup releases nothing — the worker's lifetime belongs to the app.
		expect(stop).toBeTypeOf('function');
		expect(stop).not.toThrow();
		// A rejected connect never breaks app init (startAllSources must keep the source alive).
		vi.mocked(notifyConnect).mockRejectedValueOnce(new Error('no backend'));
		await expect(source?.start(createTelemetryHub())).resolves.toBeTypeOf('function');
	});
});
