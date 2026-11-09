import { describe, expect, it } from 'vitest';
import { registerWeatherForecastPlugin } from './weather-forecast-plugin';
import { getMeta } from '../../../core/widget';
import { listPlugins } from '../../plugin';

registerWeatherForecastPlugin();

describe('weatherforecast plugin', () => {
	it('registers the widget over the Weather plugin data, with no source of its own', () => {
		const meta = getMeta('weatherforecast');
		expect(meta).toBeTruthy();
		expect(meta?.binds).toBe('none');
		expect(meta?.defaultSize).toEqual({ w: 312, h: 280 });
		expect(meta?.defaultConfig).toEqual({
			days: 5,
			hours: 12,
			locale: 'ru',
			showCurrent: true,
			showDetail: true
		});
		const keys = (meta?.configFields ?? []).map((f) => f.key);
		expect(keys).toEqual(['days', 'hours', 'locale', 'showCurrent', 'showDetail', 'color']);
		expect((meta?.configFields ?? []).every((f) => f.help)).toBe(true);
		const locale = meta?.configFields?.find((f) => f.key === 'locale');
		expect(locale && locale.kind === 'select' && locale.options).toEqual(['ru', 'en']);
		const plugin = listPlugins().find((p) => p.id === 'weatherforecast');
		expect(plugin?.statusSensor).toBe('weather.status');
		expect(plugin?.sources).toBeUndefined();
		expect(plugin?.settings).toBeUndefined();
	});

	it('subscribes the sensors for the configured days and hours', () => {
		const map = getMeta('weatherforecast')?.sensors?.({ days: 2, hours: 3 }) ?? {};
		expect(map.day1code).toBe('weather.day.1.code');
		expect(map.day2code).toBeUndefined();
		expect(map.hour2isday).toBe('weather.hour.2.is_day');
		expect(map.hour3time).toBeUndefined();
	});
});
