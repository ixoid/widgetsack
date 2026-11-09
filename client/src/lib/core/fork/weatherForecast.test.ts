import { describe, expect, it } from 'vitest';
import {
	anchorDate,
	conditionLabel,
	dayLabel,
	dayCount,
	forecastScale,
	dayRows,
	forecastSensors,
	forecastText,
	hourCount,
	isDayFromSun,
	localHourKey,
	normalizeLocale,
	pickHours,
	type RawHour
} from './weatherForecast';

const KNOWN_CODES = [
	0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86,
	95, 96, 99
];
const NO_SUN = { rise: null, set: null };
const hour = (time: string | null, extra: Partial<RawHour> = {}): RawHour => ({
	time,
	temp: 1,
	code: 3,
	isDay: 1,
	...extra
});

describe('normalizeLocale', () => {
	it('keeps en and falls back to ru for anything else', () => {
		expect(normalizeLocale('en')).toBe('en');
		expect(normalizeLocale('ru')).toBe('ru');
		expect(normalizeLocale('de')).toBe('ru');
		expect(normalizeLocale(undefined)).toBe('ru');
	});
});

describe('hourCount / dayCount (shared by the sensors map and the meter)', () => {
	it('clamp numbers and fall back to the defaults for anything else', () => {
		expect([-3, 0, 7.9, 99].map(hourCount)).toEqual([0, 0, 7, 24]);
		expect([-3, 0, 3.9, 99].map(dayCount)).toEqual([1, 1, 3, 7]);
		for (const bad of [null, undefined, Number.NaN, Infinity, '4', {}]) {
			expect(hourCount(bad)).toBe(12);
			expect(dayCount(bad)).toBe(5);
		}
	});
});

describe('forecastScale (secondary text multiplier)', () => {
	it('passes 1..2.5 through, clamps outside and falls back to 1 for junk', () => {
		expect([1, 1.3, 2.5].map(forecastScale)).toEqual([1, 1.3, 2.5]);
		expect([0, 0.5, -2].map(forecastScale)).toEqual([1, 1, 1]);
		expect(forecastScale(9)).toBe(2.5);
		for (const bad of [null, undefined, NaN, '1.5', Infinity]) expect(forecastScale(bad)).toBe(1);
	});
});

describe('forecastSensors', () => {
	it('always subscribes the current block, sun and hour 0 time', () => {
		const m = forecastSensors({ days: 1, hours: 0 });
		expect(Object.keys(m).sort()).toEqual(
			[
				'status',
				'temp',
				'apparent',
				'humidity',
				'wind',
				'code',
				'is_day',
				'unit',
				'rise',
				'set',
				'hour0time',
				'day0high',
				'day0low',
				'day0code'
			].sort()
		);
		expect(m.rise).toBe('weather.sun.rise');
	});

	it('maps hour cells, including hour{i}isday to is_day', () => {
		const m = forecastSensors({ days: 1, hours: 2 });
		expect(m.hour1time).toBe('weather.hour.1.time');
		expect(m.hour1temp).toBe('weather.hour.1.temp');
		expect(m.hour1code).toBe('weather.hour.1.code');
		expect(m.hour1isday).toBe('weather.hour.1.is_day');
		expect(m.hour2time).toBeUndefined();
	});

	it('clamps days to 1..7 and hours to 0..24, with 5 / 12 as defaults', () => {
		const count = (m: Record<string, string>, re: RegExp) =>
			Object.keys(m).filter((k) => re.test(k)).length;
		const big = forecastSensors({ days: 99, hours: 99 });
		expect(count(big, /^day\d+high$/)).toBe(7);
		expect(count(big, /^hour\d+temp$/)).toBe(24);
		const small = forecastSensors({ days: 0, hours: -3 });
		expect(count(small, /^day\d+high$/)).toBe(1);
		expect(count(small, /^hour\d+temp$/)).toBe(0);
		const junk = forecastSensors({ days: 'x', hours: Number.NaN });
		expect(count(junk, /^day\d+high$/)).toBe(5);
		expect(count(junk, /^hour\d+temp$/)).toBe(12);
		const none = forecastSensors(undefined as unknown as Record<string, unknown>);
		expect(count(none, /^day\d+high$/)).toBe(5);
		expect(count(none, /^hour\d+temp$/)).toBe(12);
		expect(count(forecastSensors({ days: 2.9, hours: 1.9 }), /^day\d+high$/)).toBe(2);
	});
});

describe('localHourKey', () => {
	const t = Date.UTC(2026, 10, 9, 22, 41); // 22:41 UTC
	it('shifts by the explicit offset and truncates to the hour', () => {
		expect(localHourKey(t, 180)).toBe('2026-11-10T01:00');
		expect(localHourKey(t, 0)).toBe('2026-11-09T22:00');
		expect(localHourKey(t, -300)).toBe('2026-11-09T17:00');
	});
});

describe('isDayFromSun', () => {
	it('compares the time of day with rise and set', () => {
		const rise = '2026-11-09T07:12';
		const set = '2026-11-09T16:30';
		expect(isDayFromSun('2026-11-10T07:00', rise, set)).toBe(false);
		expect(isDayFromSun('2026-11-10T07:12', rise, set)).toBe(true);
		expect(isDayFromSun('2026-11-10T16:00', rise, set)).toBe(true);
		expect(isDayFromSun('2026-11-10T16:30', rise, set)).toBe(false);
	});
	it('is null on missing or malformed input', () => {
		expect(isDayFromSun('2026-11-10T07:00', null, '2026-11-09T16:30')).toBeNull();
		expect(isDayFromSun('2026-11-10T07:00', '2026-11-09T07:12', null)).toBeNull();
		expect(isDayFromSun('garbage', '2026-11-09T07:12', '2026-11-09T16:30')).toBeNull();
	});
});

describe('conditionLabel', () => {
	it('has a Russian label for every WMO code the stock mapping knows', () => {
		for (const code of KNOWN_CODES) {
			const ru = conditionLabel(code, 'ru');
			expect(ru, `code ${code}`).not.toBe('—');
			expect(ru).toMatch(/[а-яё]/i);
			expect(conditionLabel(code, 'en')).toMatch(/^[A-Za-z]/);
		}
	});
	it('pins a few labels and the unknown / null fallbacks', () => {
		expect(conditionLabel(3, 'ru')).toBe('Пасмурно');
		expect(conditionLabel(3, 'en')).toBe('Overcast');
		expect(conditionLabel(1234, 'ru')).toBe('—');
		expect(conditionLabel(1234, 'en')).toBe('—');
		expect(conditionLabel(null, 'ru')).toBe('—');
	});
});

describe('forecastText', () => {
	it('returns the table of the requested locale', () => {
		expect(forecastText('ru').high).toBe('макс');
		expect(forecastText('en').high).toBe('max');
	});
});

describe('pickHours', () => {
	const now = '2026-11-09T07:00';
	const t = (h: number) => `2026-11-09T${String(h).padStart(2, '0')}:00`;

	it('formats the cell: 24-hour label, temperature, icon and RU label', () => {
		const [c] = pickHours([hour(t(7), { temp: 5, code: 61 })], now, 12, NO_SUN, 'ru');
		expect(c).toEqual({
			key: t(7),
			hour: '07',
			temp: 5,
			icon: 'rain',
			label: 'Дождь',
			now: true
		});
	});

	it('flags only the current hour and drops past hours', () => {
		const cells = pickHours(
			[6, 7, 8].map((h) => hour(t(h))),
			'2026-11-09T07:00',
			12,
			NO_SUN,
			'ru'
		);
		expect(cells.map((c) => c.hour)).toEqual(['07', '08']);
		expect(cells.map((c) => c.now)).toEqual([true, false]);
	});

	it('respects max (including 0 and negatives) and an empty input', () => {
		const raw = [7, 8, 9, 10].map((h) => hour(t(h)));
		expect(pickHours(raw, now, 2, NO_SUN, 'ru')).toHaveLength(2);
		expect(pickHours(raw, now, 0, NO_SUN, 'ru')).toHaveLength(0);
		expect(pickHours(raw, now, -1, NO_SUN, 'ru')).toHaveLength(0);
		expect(pickHours([], now, 12, NO_SUN, 'ru')).toEqual([]);
	});

	it('stops at a gap, a stale (non-increasing) time and a malformed time', () => {
		const gap = [hour(t(7)), hour(null), hour(t(9))];
		expect(pickHours(gap, now, 12, NO_SUN, 'ru')).toHaveLength(1);
		const stale = [hour(t(7)), hour(t(8)), hour(t(8)), hour(t(10))];
		expect(pickHours(stale, now, 12, NO_SUN, 'ru')).toHaveLength(2);
		const older = [hour(t(7)), hour(t(8)), hour(t(7))];
		expect(pickHours(older, now, 12, NO_SUN, 'ru')).toHaveLength(2);
		const bad = [hour(t(7)), hour('2026-11-09 08:00'), hour(t(9))];
		expect(pickHours(bad, now, 12, NO_SUN, 'ru')).toHaveLength(1);
	});

	it('handles a midnight rollover in the run', () => {
		const raw = [hour('2026-11-09T23:00'), hour('2026-11-10T00:00')];
		const cells = pickHours(raw, '2026-11-09T23:00', 12, NO_SUN, 'ru');
		expect(cells.map((c) => c.hour)).toEqual(['23', '00']);
	});

	it('prefers is_day, then the sun, then day', () => {
		const sun = { rise: '2026-11-09T07:12', set: '2026-11-09T16:30' };
		const iconOf = (
			isDay: number | null,
			time: string,
			s: { rise: string | null; set: string | null } = sun
		) => pickHours([hour(time, { code: 0, isDay })], '2026-11-09T00:00', 12, s, 'ru')[0].icon;
		expect(iconOf(0, t(12))).toBe('moon'); // is_day wins over the sun
		expect(iconOf(1, t(2))).toBe('sun');
		expect(iconOf(null, t(2))).toBe('moon'); // sun says night
		expect(iconOf(null, t(12))).toBe('sun');
		expect(iconOf(null, t(2), NO_SUN)).toBe('sun'); // nothing known: day
	});

	it('shows the moon at night for codes 0, 1 and 2 but a cloud for overcast (owner rule)', () => {
		const iconAt = (code: number, isDay: number) =>
			pickHours([hour(t(20), { code, isDay })], now, 12, NO_SUN, 'ru')[0].icon;
		expect(iconAt(0, 0)).toBe('moon');
		expect(iconAt(1, 0)).toBe('moon');
		expect(iconAt(2, 0)).toBe('moon');
		expect(iconAt(3, 0)).toBe('cloud');
		expect(iconAt(61, 0)).toBe('rain');
		expect(iconAt(2, 1)).toBe('weather'); // daytime partly cloudy keeps the stock glyph
	});

	it('shows a placeholder for a missing code', () => {
		const [c] = pickHours([hour(t(7), { code: null })], now, 12, NO_SUN, 'en');
		expect(c.icon).toBe('help');
		expect(c.label).toBe('—');
	});
});

describe('anchorDate', () => {
	it('uses hour 0 date when valid, else today', () => {
		expect(anchorDate('2026-11-10T00:00', '2026-11-09')).toBe('2026-11-10');
		expect(anchorDate('nope', '2026-11-09')).toBe('2026-11-09');
		expect(anchorDate(null, '2026-11-09')).toBe('2026-11-09');
	});
});

describe('dayLabel (explicit locale, pinned strings)', () => {
	const today = '2026-11-09';
	it('ru', () => {
		expect(dayLabel('2026-11-09', today, 'ru')).toEqual({ name: 'Сегодня', sub: 'Пн 9 ноя' });
		expect(dayLabel('2026-11-10', today, 'ru')).toEqual({ name: 'Вт', sub: '10 ноя' });
		expect(dayLabel('2026-05-10', today, 'ru').sub).toBe('10 мая');
		expect(dayLabel('2026-09-10', today, 'ru').sub).toBe('10 сен');
	});
	it('cuts the month to 3 letters without a dot in every month, ru and en', () => {
		const ru = 'янв фев мар апр мая июн июл авг сен окт ноя дек'.split(' ');
		const en = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
		const months = Array.from(
			{ length: 12 },
			(_, m) => `2026-${String(m + 1).padStart(2, '0')}-15`
		);
		expect(months.map((d) => dayLabel(d, today, 'ru').sub)).toEqual(ru.map((m) => `15 ${m}`));
		expect(months.map((d) => dayLabel(d, today, 'en').sub)).toEqual(en.map((m) => `15 ${m}`));
	});
	it('en', () => {
		expect(dayLabel('2026-11-10', today, 'en')).toEqual({ name: 'Tue', sub: '10 Nov' });
		expect(dayLabel('2026-11-09', today, 'en')).toEqual({ name: 'Today', sub: 'Mon 9 Nov' });
	});
});

describe('dayRows', () => {
	const day = (high: number | null, low: number | null, code: number | null) => ({
		high,
		low,
		code
	});
	it('numbers rows from the anchor and marks today', () => {
		const rows = dayRows([day(5, 1, 3), day(6, 2, 61)], '2026-11-09', '2026-11-09', 'ru');
		expect(rows.map((r) => [r.date, r.name, r.today])).toEqual([
			['2026-11-09', 'Сегодня', true],
			['2026-11-10', 'Вт', false]
		]);
		expect(rows[1]).toMatchObject({ high: 6, low: 2, icon: 'rain', label: 'Дождь', sub: '10 ноя' });
	});
	it('drops past rows and rows with no data at all, keeping dates aligned', () => {
		const rows = dayRows(
			[day(5, 1, 3), day(null, null, null), day(7, 3, null)],
			'2026-11-08',
			'2026-11-09',
			'en'
		);
		expect(rows.map((r) => r.date)).toEqual(['2026-11-10']);
		expect(rows[0].icon).toBe('help');
	});
	it('crosses a month boundary by calendar days', () => {
		const rows = dayRows([day(1, 1, 3), day(1, 1, 3)], '2026-11-30', '2026-11-30', 'en');
		expect(rows.map((r) => r.date)).toEqual(['2026-11-30', '2026-12-01']);
	});
	it('keeps a row that has only a low', () => {
		expect(dayRows([day(null, 2, null)], '2026-11-09', '2026-11-09', 'en')).toHaveLength(1);
	});
});
