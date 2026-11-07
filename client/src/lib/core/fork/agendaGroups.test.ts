import { describe, expect, it } from 'vitest';
import type { AgendaEvent } from '../agenda';
import {
	dayOffset,
	eventStartMs,
	formatCountdown,
	groupAgenda,
	groupKeyFor,
	nextEvent
} from './agendaGroups';

// Fri 1 Jan 2027, 13:00 local.
const NOW = new Date(2027, 0, 1, 13, 0, 0).getTime();
const at = (d: number, h: number, m = 0): string => new Date(2027, 0, d, h, m).toISOString();
const timed = (summary: string, start: string): AgendaEvent => ({
	summary,
	start,
	allDay: false,
	location: ''
});
const allDay = (summary: string, start: string): AgendaEvent => ({
	summary,
	start,
	allDay: true,
	location: ''
});

describe('eventStartMs / dayOffset', () => {
	it('treats an all-day ICS date as local midnight and a timed start as given', () => {
		expect(eventStartMs(allDay('x', '2027-01-02'))).toBe(new Date(2027, 0, 2).getTime());
		expect(eventStartMs(timed('x', at(2, 9)))).toBe(new Date(2027, 0, 2, 9).getTime());
		// An all-day flag with a full timestamp is parsed as that timestamp.
		expect(eventStartMs(allDay('x', at(2, 9)))).toBe(new Date(2027, 0, 2, 9).getTime());
		expect(Number.isNaN(eventStartMs(timed('x', 'garbage')))).toBe(true);
	});
	it('counts whole local days between midnights', () => {
		expect(dayOffset(new Date(2027, 0, 1, 23, 59).getTime(), NOW)).toBe(0);
		expect(dayOffset(new Date(2027, 0, 2, 0, 1).getTime(), NOW)).toBe(1);
		expect(dayOffset(new Date(2026, 11, 31, 23).getTime(), NOW)).toBe(-1);
		expect(dayOffset(new Date(2027, 0, 8).getTime(), NOW)).toBe(7);
	});
});

describe('groupKeyFor', () => {
	it('buckets by day distance and drops the past with the same grace as the Agenda meter', () => {
		expect(groupKeyFor(timed('t', at(1, 15)), NOW)).toBe('today');
		expect(groupKeyFor(timed('t', at(1, 12, 30)), NOW)).toBe('today'); // started 30 min ago
		expect(groupKeyFor(timed('t', at(1, 11, 59)), NOW)).toBeNull(); // over an hour ago
		expect(groupKeyFor(allDay('t', '2027-01-01'), NOW)).toBe('today');
		expect(groupKeyFor(allDay('t', '2026-12-31'), NOW)).toBeNull();
		expect(groupKeyFor(timed('t', at(2, 9)), NOW)).toBe('tomorrow');
		expect(groupKeyFor(timed('t', at(3, 9)), NOW)).toBe('week');
		expect(groupKeyFor(timed('t', at(7, 23)), NOW)).toBe('week'); // 6 days out
		expect(groupKeyFor(timed('t', at(8, 0)), NOW)).toBe('later'); // 7 days out
		expect(groupKeyFor(timed('t', 'garbage'), NOW)).toBeNull();
	});
});

describe('groupAgenda', () => {
	const events: AgendaEvent[] = [
		timed('Far', at(20, 10)),
		timed('Lunch', at(2, 12)),
		timed('Gone', at(1, 8)),
		allDay('Holiday', '2027-01-01'),
		timed('Review', at(1, 15)),
		timed('Planning', at(2, 9)),
		timed('Dentist', at(5, 16))
	];
	it('orders groups Today → Tomorrow → This week → Later, soonest first inside each', () => {
		const { groups, hidden } = groupAgenda(events, NOW, { includeLater: true, maxRows: 20 });
		expect(groups.map((g) => [g.key, g.label, g.events.map((e) => e.summary)])).toEqual([
			['today', 'Today', ['Holiday', 'Review']],
			['tomorrow', 'Tomorrow', ['Planning', 'Lunch']],
			['week', 'This week', ['Dentist']],
			['later', 'Later', ['Far']]
		]);
		expect(hidden).toBe(0);
	});
	it('drops the Later bucket when not wanted, without counting it as hidden', () => {
		const { groups, hidden } = groupAgenda(events, NOW, { includeLater: false, maxRows: 20 });
		expect(groups.map((g) => g.key)).toEqual(['today', 'tomorrow', 'week']);
		expect(hidden).toBe(0);
	});
	it('caps total rows across groups and reports the rest; empty groups vanish', () => {
		const { groups, hidden } = groupAgenda(events, NOW, { includeLater: true, maxRows: 3 });
		expect(groups.map((g) => [g.key, g.events.length])).toEqual([
			['today', 2],
			['tomorrow', 1]
		]);
		expect(hidden).toBe(3);
		expect(groupAgenda(events, NOW, { includeLater: true, maxRows: 0 })).toEqual({
			groups: [],
			hidden: 6
		});
		expect(groupAgenda([], NOW, { includeLater: true, maxRows: 5 })).toEqual({
			groups: [],
			hidden: 0
		});
	});
});

describe('nextEvent', () => {
	it('is the soonest strictly-future start; running and all-day-today events do not count', () => {
		const list = [
			timed('Running', at(1, 12, 30)),
			allDay('Holiday', '2027-01-01'),
			timed('Later today', at(1, 17)),
			timed('Soon', at(1, 14, 10)),
			timed('Broken', 'garbage')
		];
		expect(nextEvent(list, NOW)?.summary).toBe('Soon');
		expect(nextEvent([allDay('Tomorrow off', '2027-01-02')], NOW)?.summary).toBe('Tomorrow off');
		expect(nextEvent([timed('Running', at(1, 12, 30))], NOW)).toBeNull();
		expect(nextEvent([], NOW)).toBeNull();
	});
});

describe('formatCountdown', () => {
	it('words the gap at minute resolution', () => {
		expect(formatCountdown(NOW, NOW)).toBe('now');
		expect(formatCountdown(NOW - 5, NOW)).toBe('now');
		expect(formatCountdown(NOW + 30_000, NOW)).toBe('<1 min');
		expect(formatCountdown(NOW + 25 * 60_000, NOW)).toBe('25 min');
		expect(formatCountdown(NOW + 125 * 60_000, NOW)).toBe('2 h 05 min');
		expect(formatCountdown(NOW + 23 * 3_600_000 + 59 * 60_000, NOW)).toBe('23 h 59 min');
		expect(formatCountdown(NOW + 3 * 86_400_000 + 4 * 3_600_000, NOW)).toBe('3 d 4 h');
		expect(formatCountdown(Number.NaN, NOW)).toBe('now');
	});
});
