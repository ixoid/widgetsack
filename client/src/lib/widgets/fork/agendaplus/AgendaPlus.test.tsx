import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import AgendaPlus from './AgendaPlus';
import { createTelemetryHub, type SensorSample } from '../../../core/telemetry';
import { TelemetryHubContext } from '../../telemetryContext';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const sample = (sensor: string, rows: unknown): SensorSample => ({
	sensor,
	ts_ms: 0,
	value: { kind: 'json', value: rows }
});

const renderWith = async (
	hub: ReturnType<typeof createTelemetryHub> | null,
	props: Record<string, unknown> = {}
) => {
	let container!: HTMLElement;
	await act(async () => {
		container = render(
			<TelemetryHubContext.Provider value={hub}>
				<AgendaPlus {...props} />
			</TelemetryHubContext.Provider>
		).container;
	});
	return container;
};

const texts = (c: HTMLElement, sel: string): string[] =>
	Array.from(c.querySelectorAll(sel), (el) => el.textContent ?? '');

describe('AgendaPlus meter', () => {
	it('groups events by day, words each row for its group and counts down to the next one', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 1, 13)); // Fri 1 Jan 2027 13:00
		const hub = createTelemetryHub();
		hub.ingestBatch([
			sample('agenda.list', [
				{ summary: 'Holiday', start: '2027-01-01', allDay: true },
				{ summary: 'Review', start: new Date(2027, 0, 1, 15).toISOString(), location: 'Room 4' },
				{ summary: 'Planning', start: new Date(2027, 0, 2, 9).toISOString() },
				{ summary: 'Dentist', start: new Date(2027, 0, 5, 16, 30).toISOString() },
				{ summary: 'Far away', start: new Date(2027, 0, 20, 10).toISOString() },
				{ summary: 'Long gone', start: new Date(2026, 11, 1, 10).toISOString() }
			])
		]);
		const c = await renderWith(hub, { title: 'Agenda' });
		expect(c.querySelector('.ag-title')?.textContent).toBe('Agenda');
		expect(texts(c, '.agp-group-title')).toEqual(['Today', 'Tomorrow', 'This week']);
		expect(texts(c, '.ag-when')).toEqual(['All day', '15:00', '09:00', 'Tue 16:30']);
		expect(c.querySelector('.ag-location')?.textContent).toBe('Room 4');
		// "Later" is off by default and not counted as hidden.
		expect(c.querySelector('.ag-more')).toBeNull();
		// Countdown: the all-day event today is not "next"; Review at 15:00 is 2 h away.
		expect(c.querySelector('.agp-next-summary')?.textContent).toBe('Review');
		expect(c.querySelector('.agp-next-in')?.textContent).toBe('in 2 h 00 min');
	});

	it('lists Later with a date, caps rows and reports the hidden count', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 1, 13));
		const hub = createTelemetryHub();
		hub.ingestBatch([
			sample('agenda.list', [
				{ summary: 'A', start: new Date(2027, 0, 1, 15).toISOString() },
				{ summary: 'B', start: new Date(2027, 0, 2, 9).toISOString() },
				{ summary: 'Far', start: new Date(2027, 0, 20, 10).toISOString() }
			])
		]);
		const all = await renderWith(hub, { showLater: true, showCountdown: false });
		expect(texts(all, '.agp-group-title')).toEqual(['Today', 'Tomorrow', 'Later']);
		expect(texts(all, '.ag-when')).toEqual(['15:00', '09:00', '20 Jan 10:00']);
		expect(all.querySelector('.agp-next')).toBeNull();
		const capped = await renderWith(hub, { showLater: true, maxRows: 1 });
		expect(texts(capped, '.agp-group-title')).toEqual(['Today']);
		expect(capped.querySelector('.ag-more')?.textContent).toBe('+2 more events');
		const one = await renderWith(hub, { showLater: true, maxRows: 2 });
		expect(one.querySelector('.ag-more')?.textContent).toBe('+1 more event');
	});

	it('shows the reading / unavailable / empty states and the parse warnings', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 1, 13));
		const empty = await renderWith(createTelemetryHub());
		expect(empty.querySelector('.ag-empty')?.textContent).toBe('No upcoming events');
		expect(empty.querySelector('.agp-next')).toBeNull();

		const pending = createTelemetryHub();
		pending.ingestBatch([sample('agenda.parse', { pending: true })]);
		expect((await renderWith(pending)).querySelector('.ag-empty')?.textContent).toBe(
			'Reading calendar…'
		);

		const broken = createTelemetryHub();
		broken.ingestBatch([sample('agenda.parse', { pending: false, warnings: ['Feed 404'] })]);
		const c = await renderWith(broken);
		expect(c.querySelector('.ag-empty')?.textContent).toBe('Calendar unavailable');
		expect(c.querySelector('.ag-status')?.textContent).toBe('Feed 404');

		// No hub at all (studio preview) renders the empty state, not a crash.
		expect((await renderWith(null)).querySelector('.ag-empty')).toBeTruthy();
	});

	it('applies the accent colour as a CSS variable', async () => {
		const c = await renderWith(createTelemetryHub(), { color: '#ff8800' });
		expect((c.firstElementChild as HTMLElement).style.getPropertyValue('--ag-accent')).toBe(
			'#ff8800'
		);
	});
});
