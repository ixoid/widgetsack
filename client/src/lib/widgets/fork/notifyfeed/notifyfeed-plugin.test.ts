import { describe, expect, it } from 'vitest';
import { registerNotifyFeedPlugin } from './notifyfeed-plugin';
import { getMeta } from '../../../core/widget';
import { listPlugins } from '../../plugin';

registerNotifyFeedPlugin();

describe('notifyfeed plugin', () => {
	it('registers the notifyfeed widget with a STATIC sensors map, interactive, and no source', () => {
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
		expect(plugin?.sources).toBeUndefined();
		// Deliberately NO statusSensor: statusDotFrom would mislabel 'granted' as "Not connected".
		expect(plugin?.statusSensor).toBeUndefined();
	});
});
