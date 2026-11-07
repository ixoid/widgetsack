import { describe, expect, it } from 'vitest';
import { registerServerCheckPlugin } from './server-check';
import { getMeta } from '../../../core/widget';
import { listPlugins } from '../../plugin';

registerServerCheckPlugin();

describe('server-check plugin', () => {
	it('registers the servercheck widget with its config fields and the status sensor', () => {
		const meta = getMeta('servercheck');
		expect(meta).toBeTruthy();
		expect(meta?.binds).toBe('none');
		const keys = (meta?.configFields ?? []).map((f) => f.key);
		expect(keys).toEqual(['title', 'maxRows', 'slowMs', 'showSparkline', 'color']);
		expect((meta?.configFields ?? []).every((f) => f.help)).toBe(true);
		const plugin = listPlugins().find((p) => p.id === 'server-check');
		expect(plugin?.statusSensor).toBe('srv.status');
		expect(plugin?.sources?.[0].id).toBe('server-check');
	});
});
