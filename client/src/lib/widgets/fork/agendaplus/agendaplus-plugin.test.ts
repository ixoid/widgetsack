import { describe, expect, it } from 'vitest';
import { registerAgendaPlusPlugin } from './agendaplus-plugin';
import { getMeta } from '../../../core/widget';
import { listPlugins } from '../../plugin';

registerAgendaPlusPlugin();

describe('agendaplus plugin', () => {
	it('registers the agendaplus widget over the Agenda plugin data, with no source of its own', () => {
		const meta = getMeta('agendaplus');
		expect(meta).toBeTruthy();
		expect(meta?.binds).toBe('none');
		expect(meta?.defaultConfig).toEqual({
			title: '',
			maxRows: 8,
			showCountdown: true,
			showLater: false
		});
		const keys = (meta?.configFields ?? []).map((f) => f.key);
		expect(keys).toEqual(['title', 'maxRows', 'showCountdown', 'showLater', 'color']);
		expect((meta?.configFields ?? []).every((f) => f.help)).toBe(true);
		const plugin = listPlugins().find((p) => p.id === 'agendaplus');
		expect(plugin?.statusSensor).toBe('agenda.status');
		expect(plugin?.sources).toBeUndefined();
		expect(plugin?.settings).toBeUndefined();
	});
});
