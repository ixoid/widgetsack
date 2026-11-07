// Pure helpers for the fork's Agenda+ widget (roadmap K-1): bucket the `agenda.list` events into
// Today / Tomorrow / This week / Later, pick the next event, and word a countdown to it. No React,
// no DOM, no Tauri — every rule here is unit-tested in agendaGroups.test.ts. The day rules mirror
// core/agenda.ts (a timed event stays "upcoming" for an hour after it starts; an all-day event for
// its whole day; an ICS date is a calendar day in the user's zone) so the two widgets never disagree
// about which events exist.
import type { AgendaEvent } from '../agenda';

export type AgendaGroupKey = 'today' | 'tomorrow' | 'week' | 'later';

export type AgendaGroup = { key: AgendaGroupKey; label: string; events: AgendaEvent[] };

export const GROUP_LABELS: Record<AgendaGroupKey, string> = {
	today: 'Today',
	tomorrow: 'Tomorrow',
	week: 'This week',
	later: 'Later'
};

const ORDER: AgendaGroupKey[] = ['today', 'tomorrow', 'week', 'later'];
const DAY_MS = 86_400_000;
const GRACE_MS = 3_600_000;

/** Epoch ms of an event's start; NaN when unparseable. An all-day `YYYY-MM-DD` is local midnight. */
export function eventStartMs(e: AgendaEvent): number {
	const iso = e.allDay && /^\d{4}-\d{2}-\d{2}$/.test(e.start) ? `${e.start}T00:00:00` : e.start;
	return new Date(iso).getTime();
}

const localMidnight = (ms: number): number => {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
};

/** Whole local days from `nowMs`'s day to `ms`'s day (0 = today, 1 = tomorrow, negative = past). */
export function dayOffset(ms: number, nowMs: number): number {
	return Math.round((localMidnight(ms) - localMidnight(nowMs)) / DAY_MS);
}

/** The group an event belongs to, or null when it is already over (same rule as upcomingEvents). */
export function groupKeyFor(e: AgendaEvent, nowMs: number): AgendaGroupKey | null {
	const ms = eventStartMs(e);
	if (Number.isNaN(ms)) return null;
	const days = dayOffset(ms, nowMs);
	if (e.allDay ? days < 0 : ms < nowMs - GRACE_MS) return null;
	if (days <= 0) return 'today';
	if (days === 1) return 'tomorrow';
	if (days < 7) return 'week';
	return 'later';
}

export type GroupedAgenda = { groups: AgendaGroup[]; hidden: number };

/** Bucket the upcoming events, soonest first inside each group, dropping empty groups. `maxRows`
 * caps the total rows across groups (the earliest win; `hidden` counts the rest). `includeLater`
 * false drops everything a week or more away instead of showing a "Later" bucket. */
export function groupAgenda(
	events: AgendaEvent[],
	nowMs: number,
	opts: { includeLater: boolean; maxRows: number }
): GroupedAgenda {
	const tagged = events
		.map((e) => ({ e, ms: eventStartMs(e), key: groupKeyFor(e, nowMs) }))
		.filter((x): x is { e: AgendaEvent; ms: number; key: AgendaGroupKey } => x.key !== null)
		.filter((x) => opts.includeLater || x.key !== 'later')
		.sort((a, b) => a.ms - b.ms);
	const cap = Math.max(0, Math.floor(opts.maxRows));
	const shown = tagged.slice(0, cap);
	const groups: AgendaGroup[] = [];
	for (const key of ORDER) {
		const rows = shown.filter((x) => x.key === key).map((x) => x.e);
		if (rows.length) groups.push({ key, label: GROUP_LABELS[key], events: rows });
	}
	return { groups, hidden: tagged.length - shown.length };
}

/** The first event that has not started yet (strictly in the future), or null. An all-day event
 * counts from its local midnight, so today's all-day entries are never "next". */
export function nextEvent(events: AgendaEvent[], nowMs: number): AgendaEvent | null {
	let best: { e: AgendaEvent; ms: number } | null = null;
	for (const e of events) {
		const ms = eventStartMs(e);
		if (Number.isNaN(ms) || ms <= nowMs) continue;
		if (!best || ms < best.ms) best = { e, ms };
	}
	return best?.e ?? null;
}

/** Time until `startMs`, worded for a glance: "now" once it has begun, "<1 min", "25 min",
 * "2 h 05 min", "3 d 4 h". Minute resolution — the widget ticks on the shared minute clock. */
export function formatCountdown(startMs: number, nowMs: number): string {
	const diff = startMs - nowMs;
	if (!Number.isFinite(diff) || diff <= 0) return 'now';
	const totalMin = Math.floor(diff / 60_000);
	if (totalMin < 1) return '<1 min';
	if (totalMin < 60) return `${totalMin} min`;
	const totalH = Math.floor(totalMin / 60);
	if (totalH < 24) return `${totalH} h ${String(totalMin % 60).padStart(2, '0')} min`;
	const days = Math.floor(totalH / 24);
	return `${days} d ${totalH % 24} h`;
}
