import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import WeatherForecast from './WeatherForecast';
import { forecastSensors } from '../../../core/fork/weatherForecast';
import type { SensorState } from '../../../core/telemetry';

// Local-time clock, so the meter's local hour key is 2026-11-09T07:00 in any machine zone.
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 10, 9, 7, 30));
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

type Sensors = Record<string, SensorState>;
const st = (value: SensorState['value']): SensorState => ({ value, history: [] });
const num = (v: number) => st({ kind: 'scalar', value: v });
const txt = (v: string) => st({ kind: 'text', value: v });

const daySensors = (n: number): Sensors => {
	const s: Sensors = {};
	for (let i = 0; i < n; i++) {
		s[`day${i}high`] = num(5 + i);
		s[`day${i}low`] = num(1 + i);
		s[`day${i}code`] = num(61);
	}
	return s;
};
const base: Sensors = {
	temp: num(2.4),
	code: num(3),
	is_day: num(1),
	unit: txt('C'),
	apparent: num(-1.6),
	humidity: num(95),
	wind: num(8.2)
};
const q = (c: HTMLElement, part: string) => c.querySelectorAll(`[data-part="${part}"]`);

describe('WeatherForecast meter', () => {
	it('shows the empty states from weather.status', () => {
		const empty = (sensors?: Sensors) =>
			render(<WeatherForecast sensors={sensors} />).container.querySelector('[data-part="empty"]');
		expect(empty()?.textContent).toBe('Укажите место в Plugins → Weather');
		cleanup();
		expect(empty({ status: txt('connecting') })?.textContent).toBe('Загрузка погоды…');
		cleanup();
		expect(empty({ status: txt('error') })?.textContent).toBe(
			'Погода недоступна — проверьте подключение'
		);
		cleanup();
		const en = render(<WeatherForecast locale="en" />).container.querySelector(
			'[data-part="empty"]'
		);
		expect(en?.textContent).toBe('Set your location in Plugins → Weather');
		expect(en?.getAttribute('role')).toBe('status');
	});

	it('renders the current block with detail values in Russian', () => {
		const { container } = render(<WeatherForecast sensors={base} />);
		expect(q(container, 'value')[0].textContent).toBe('2°C');
		expect(container.querySelector('.wf-c')?.textContent).toBe('Пасмурно');
		const detail = q(container, 'detail')[0].textContent;
		expect(detail).toBe('ощущается -2°влажность 95 %ветер 8 км/ч');
	});

	it('uses mph for F and omits detail values that are missing (met.no has no feels-like)', () => {
		const sensors: Sensors = { ...base, unit: txt('F'), wind: num(10) };
		delete sensors.apparent;
		const { container } = render(<WeatherForecast sensors={sensors} locale="en" />);
		expect(q(container, 'detail')[0].textContent).toBe('humidity 95 %wind 10 mph');
	});

	it('hides the detail column when nothing is present or showDetail is off', () => {
		const bare: Sensors = { temp: num(2), code: num(3) };
		expect(q(render(<WeatherForecast sensors={bare} />).container, 'detail')).toHaveLength(0);
		cleanup();
		const off = render(<WeatherForecast sensors={base} showDetail={false} />).container;
		expect(q(off, 'detail')).toHaveLength(0);
	});

	it('hides the current block with showCurrent off and shows a dash without a temperature', () => {
		const off = render(<WeatherForecast sensors={base} showCurrent={false} />).container;
		expect(q(off, 'now')).toHaveLength(0);
		cleanup();
		const noTemp = render(<WeatherForecast sensors={{ code: num(0) }} />).container;
		expect(q(noTemp, 'value')[0].textContent).toBe('—');
	});

	it('renders the hour strip from the current hour with the accent on the current cell', () => {
		// Hours are laid out as UTC text; build them in the local frame instead for the clock.
		const sensors: Sensors = { ...base };
		for (let i = 0; i < 3; i++) {
			const h = String(6 + i).padStart(2, '0');
			sensors[`hour${i}time`] = txt(`2026-11-09T${h}:00`);
			sensors[`hour${i}temp`] = num(i);
			sensors[`hour${i}code`] = num(3);
		}
		const { container } = render(<WeatherForecast sensors={sensors} hours={3} />);
		const cells = Array.from(q(container, 'hour'));
		expect(cells.map((c) => c.querySelector('.wf-hh')?.textContent)).toEqual(['07', '08']);
		expect(cells.map((c) => c.classList.contains('now'))).toEqual([true, false]);
		expect(cells[1].querySelector('.wf-ht')?.textContent).toBe('2°');
	});

	it('hides the strip with hours: 0 and when no hour data has arrived', () => {
		expect(q(render(<WeatherForecast sensors={base} hours={0} />).container, 'hours')).toHaveLength(
			0
		);
		cleanup();
		expect(q(render(<WeatherForecast sensors={base} />).container, 'hours')).toHaveLength(0);
	});

	it('sets --wf-cols to 12 for 24 hours (two rows) and to the cell count when fewer', () => {
		const many: Sensors = { ...base };
		for (let i = 0; i < 24; i++) {
			const d = i < 17 ? '09' : '10';
			const h = String((7 + i) % 24).padStart(2, '0');
			many[`hour${i}time`] = txt(`2026-11-${d}T${h}:00`);
			many[`hour${i}temp`] = num(i);
		}
		const full = render(<WeatherForecast sensors={many} hours={24} />).container;
		expect(q(full, 'hour')).toHaveLength(24);
		expect((q(full, 'hours')[0] as HTMLElement).style.getPropertyValue('--wf-cols')).toBe('12');
		cleanup();
		const few = render(<WeatherForecast sensors={many} hours={5} />).container;
		expect((q(few, 'hours')[0] as HTMLElement).style.getPropertyValue('--wf-cols')).toBe('5');
	});

	it('renders the moon for a clear night hour on met.no-shaped sensors (is_day 0, no sun ids)', () => {
		const sensors: Sensors = { temp: num(0), code: num(3) };
		sensors.hour0time = txt('2026-11-09T07:00');
		sensors.hour0temp = num(-1);
		sensors.hour0code = num(0);
		sensors.hour0isday = num(0);
		const { container } = render(<WeatherForecast sensors={sensors} hours={1} />);
		const cell = q(container, 'hour')[0];
		expect(cell.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Ясно');
		const moon = render(<WeatherForecast sensors={{ code: num(0), is_day: num(0) }} />).container;
		const stock = render(<WeatherForecast sensors={{ code: num(0), is_day: num(1) }} />).container;
		expect(cell.querySelector('svg')?.innerHTML).toBe(moon.querySelector('svg')?.innerHTML);
		expect(cell.querySelector('svg')?.innerHTML).not.toBe(stock.querySelector('svg')?.innerHTML);
	});

	it('falls back to sunrise / sunset when is_day is absent', () => {
		const sun: Sensors = {
			code: num(0),
			rise: txt('2026-11-09T06:12'),
			set: txt('2026-11-09T16:30')
		};
		// the 07:00 hour key is after sunrise: the current block shows the day glyph.
		const dayIcon = render(<WeatherForecast sensors={sun} />).container.querySelector('svg');
		const ref = render(<WeatherForecast sensors={{ code: num(0), is_day: num(1) }} />).container;
		expect(dayIcon?.innerHTML).toBe(ref.querySelector('svg')?.innerHTML);
	});

	it('renders day rows from the anchor date with today highlighted and a ru header', () => {
		const sensors: Sensors = { ...base, ...daySensors(3), hour0time: txt('2026-11-09T07:00') };
		const { container } = render(<WeatherForecast sensors={sensors} days={3} />);
		const rows = Array.from(q(container, 'day'));
		expect(rows).toHaveLength(3);
		expect(rows[0].classList.contains('today')).toBe(true);
		expect(rows[0].querySelector('b')?.textContent).toBe('Сегодня');
		expect(rows[0].querySelector('small')?.textContent).toBe('Пн 9 ноя');
		expect(rows[1].querySelector('b')?.textContent).toBe('Вт');
		expect(rows[1].querySelector('.wf-hi')?.textContent).toBe('6°');
		expect(rows[1].querySelector('.wf-lo')?.textContent).toBe('2°');
		expect(container.querySelector('.wf-head')?.textContent).toBe('день' + 'макс' + 'мин');
	});

	it('anchors to today when hour 0 is missing, and clamps days to 1..7', () => {
		const sensors: Sensors = { ...base, ...daySensors(9) };
		expect(
			q(render(<WeatherForecast sensors={sensors} days={99} />).container, 'day')
		).toHaveLength(7);
		cleanup();
		const one = render(<WeatherForecast sensors={sensors} days={0} />).container;
		expect(q(one, 'day')).toHaveLength(1);
		expect(q(one, 'day')[0].classList.contains('today')).toBe(true);
	});

	it('omits the day table when no day has data and applies a custom accent', () => {
		const { container } = render(<WeatherForecast sensors={base} color="#ff0000" />);
		expect(q(container, 'days')).toHaveLength(0);
		expect((container.firstChild as HTMLElement).style.getPropertyValue('--wf-accent')).toBe(
			'#ff0000'
		);
	});

	it('falls back to ru for an unknown locale value', () => {
		const { container } = render(<WeatherForecast sensors={base} locale="xx" />);
		expect(container.querySelector('.wf-c')?.textContent).toBe('Пасмурно');
	});

	it('renders as many hour cells as forecastSensors subscribes for a cleared hours field', () => {
		// 24 hours of data from 07:00; the strip must follow the subscribed count (12), not collapse.
		const many: Sensors = { ...base };
		for (let i = 0; i < 24; i++) {
			const d = i < 17 ? '09' : '10';
			many[`hour${i}time`] = txt(`2026-11-${d}T${String((7 + i) % 24).padStart(2, '0')}:00`);
		}
		for (const bad of [null, Number.NaN, 'x']) {
			const subscribed = Object.keys(forecastSensors({ hours: bad })).filter((k) =>
				k.endsWith('time')
			);
			const { container } = render(
				<WeatherForecast sensors={many} hours={bad as unknown as number} />
			);
			expect(q(container, 'hour')).toHaveLength(subscribed.length);
			expect(q(container, 'hour')).toHaveLength(12);
			cleanup();
		}
	});

	it('renders as many day rows as forecastSensors subscribes for a cleared days field', () => {
		const sensors: Sensors = { ...base, ...daySensors(7), hour0time: txt('2026-11-09T07:00') };
		for (const bad of [null, Number.NaN, 'x']) {
			const subscribed = Object.keys(forecastSensors({ days: bad })).filter((k) =>
				k.endsWith('high')
			);
			const { container } = render(
				<WeatherForecast sensors={sensors} days={bad as unknown as number} />
			);
			expect(q(container, 'day')).toHaveLength(subscribed.length);
			expect(q(container, 'day')).toHaveLength(5);
			cleanup();
		}
	});

	it('shows exactly the newer poll prefix when an older poll left a longer tail in the hub', () => {
		// 07:00 poll wrote hour.0..23 = 07:00..06:00(+1d); the 08:00 poll rewrote hour.0..22 = 08:00..06:00
		// and left hour.23 (06:00, stale) behind: it is not newer than hour.22, so the run ends there.
		const sensors: Sensors = { ...base };
		const put = (i: number, h: number, day: string, temp: number) => {
			sensors[`hour${i}time`] = txt(`2026-11-${day}T${String(h).padStart(2, '0')}:00`);
			sensors[`hour${i}temp`] = num(temp);
		};
		for (let i = 0; i < 24; i++) put(i, (7 + i) % 24, i < 17 ? '09' : '10', 100 + i);
		for (let i = 0; i < 23; i++) put(i, (8 + i) % 24, i < 16 ? '09' : '10', i);
		const { container } = render(<WeatherForecast sensors={sensors} hours={24} />);
		const cells = Array.from(q(container, 'hour'));
		expect(cells).toHaveLength(23);
		expect(cells[0].querySelector('.wf-hh')?.textContent).toBe('08');
		expect(cells[0].classList.contains('now')).toBe(false);
		expect(cells[22].querySelector('.wf-hh')?.textContent).toBe('06');
		expect(cells[22].querySelector('.wf-ht')?.textContent).toBe('22°');
	});

	it('applies the night glyph rule to the current block: moon for 0/1/2, own glyph otherwise', () => {
		const iconOf = (code: number, isDay: number): string | null | undefined => {
			const { container } = render(
				<WeatherForecast sensors={{ code: num(code), is_day: num(isDay) }} />
			);
			const name = container.querySelector('[data-part="now"] svg')?.getAttribute('data-icon');
			cleanup();
			return name;
		};
		expect([0, 1, 2].map((c) => iconOf(c, 0))).toEqual(['moon', 'moon', 'moon']);
		expect(iconOf(3, 0)).toBe('cloud');
		expect(iconOf(61, 0)).toBe('rain');
		expect(iconOf(2, 1)).toBe('weather');
		expect(iconOf(0, 1)).toBe('sun');
	});
});
