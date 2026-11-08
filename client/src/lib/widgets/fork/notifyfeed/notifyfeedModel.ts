// Pure helpers for the Notifications widget and its settings pane (serverCheckModel precedent).
// No React / Tauri / DOM — unit-tested in notifyfeedModel.test.ts. ALL user-facing copy lives here.

import type { NotifyItem, NotifyStatusKind } from './notifyfeed-types';

/** Defensively shape the `notify.list` JSON payload (the `{version, items}` object) into typed
 * items; malformed entries are dropped, never thrown. `version` is ignored — the payload is a
 * full replace, so the meter just renders whatever items arrived. */
export function parseNotifyList(value: unknown): NotifyItem[] {
	if (!value || typeof value !== 'object') return [];
	const items = (value as Record<string, unknown>).items;
	if (!Array.isArray(items)) return [];
	const out: NotifyItem[] = [];
	for (const raw of items) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		if (typeof r.key !== 'string' || !r.key) continue;
		if (typeof r.app !== 'string' || typeof r.title !== 'string' || typeof r.body !== 'string')
			continue;
		if (typeof r.tsMs !== 'number' || !isFinite(r.tsMs)) continue;
		out.push({
			key: r.key,
			app: r.app,
			title: r.title,
			body: r.body,
			tsMs: r.tsMs,
			// The wire always sends a boolean; anything else reads as unread (the safe direction).
			seen: r.seen === true
		});
	}
	return out;
}

export type NotifyGroup = { app: string; items: NotifyItem[] };

/** Group by app. The input is already globally newest-first, so groups land in first-appearance
 * order (= newest-app-first) and items inside a group stay newest-first — no re-sorting. */
export function groupItems(items: NotifyItem[]): NotifyGroup[] {
	const out: NotifyGroup[] = [];
	const byApp = new Map<string, NotifyGroup>();
	for (const item of items) {
		const existing = byApp.get(item.app);
		if (existing) {
			existing.items.push(item);
		} else {
			const group: NotifyGroup = { app: item.app, items: [item] };
			byApp.set(item.app, group);
			out.push(group);
		}
	}
	return out;
}

/** Unread count, derived client-side from per-item `seen` (NOT the `notify.count` sensor — that
 * one is the ring TOTAL by owner decision and never resets on mark-all-seen). */
export function unseenCount(items: NotifyItem[]): number {
	return items.reduce((n, i) => (i.seen ? n : n + 1), 0);
}

/** The two text lines of a row: a toast with no title shows its body as the headline. */
export function rowLines(item: NotifyItem): { headline: string; body: string } {
	return { headline: item.title || item.body, body: item.title ? item.body : '' };
}

/** Coarse relative age: 'now' / 'N min' / 'N h' / 'N d' (the formatDownSince granularity idiom).
 * A ts slightly in the future (clock skew) reads as 'now', never negative. */
export function formatAge(tsMs: number, nowMs: number): string {
	const secs = Math.max(0, Math.floor((nowMs - tsMs) / 1000));
	if (secs < 60) return 'now';
	if (secs < 3600) return `${Math.floor(secs / 60)} min`;
	if (secs < 86_400) return `${Math.floor(secs / 3600)} h`;
	return `${Math.floor(secs / 86_400)} d`;
}

export type NotifyStateCopy = { title: string; hint: string };

/** What `.ntf-state` shows for a status (empty title = render no state block). Granted + empty
 * is NEUTRAL copy on purpose: a dead source is indistinguishable from an empty Action Center
 * (ADR `notifyfeed-source` Правило 1), so "working / all good" would be a lie. */
export function meterStateCopy(
	status: NotifyStatusKind | null,
	itemCount: number
): NotifyStateCopy {
	switch (status) {
		case 'denied':
			return {
				title: 'Notification access is off',
				hint: 'Allow widgetsack in Windows Settings → Privacy & security → Notifications.'
			};
		case 'unavailable':
			return {
				title: 'Notifications unavailable',
				hint: 'Check the source in Plugins → Notifications.'
			};
		case 'granted':
			return itemCount === 0 ? { title: 'No notifications', hint: '' } : { title: '', hint: '' };
		default:
			// 'off' or no sample yet: a mounted widget re-opens the demand gate, so the first poll
			// lands within poll_secs — transient by construction.
			return { title: 'Reading notifications…', hint: '' };
	}
}

export type NotifyPaneBadge = { label: string; tone: 'ok' | 'warn' | '' };

/** The Plugins pane badge — its own mapping (NOT haStatusBadge; the kinds differ). Empty tone =
 * the dim default `has-badge` with no modifier class. */
export function paneStatusBadge(status: NotifyStatusKind | null): NotifyPaneBadge {
	switch (status) {
		case 'granted':
			return { label: 'Granted', tone: 'ok' };
		case 'denied':
			return { label: 'Access denied', tone: 'warn' };
		case 'unavailable':
			return { label: 'Unavailable', tone: 'warn' };
		default:
			return { label: 'Idle', tone: '' };
	}
}

const STATUS_KINDS: NotifyStatusKind[] = ['granted', 'denied', 'unavailable', 'off'];

/** Type-guard for the `notify.status` text — the wire sends only these four kinds (the
 * serverCheckModel `isKind` idiom); anything unknown degrades to the loading/Idle default. */
export function isStatusKind(v: string | null): v is NotifyStatusKind {
	return typeof v === 'string' && STATUS_KINDS.includes(v as NotifyStatusKind);
}

/** TokenListField `parse` for the exclusions editor — split on NEWLINE only (app names may
 * contain commas; the MQTT topics precedent), trim, drop empties. */
export const parseExclusions = (text: string): string[] =>
	text
		.split('\n')
		.map((entry) => entry.trim())
		.filter(Boolean);

/** Exclusion guardrails, mirrored from config.rs so the pane can flag them inline. */
export const MAX_EXCLUSIONS = 64;
export const MAX_EXCLUSION_CHARS = 100;

/** Client-side mirror of the backend's exclusion validation. Null = looks fine. The messages
 * never echo the entry text. */
export function exclusionProblem(list: string[]): string | null {
	if (list.length > MAX_EXCLUSIONS) return `at most ${MAX_EXCLUSIONS} exclusions`;
	if (list.some((entry) => entry.length > MAX_EXCLUSION_CHARS))
		return `each exclusion must be 1-${MAX_EXCLUSION_CHARS} characters`;
	return null;
}

/** Depth guardrails (config.rs) — the pane's input bounds AND the save-time clamp values. */
export const MIN_DEPTH_COUNT = 10;
export const MAX_DEPTH_COUNT = 200;
export const MIN_DEPTH_HOURS = 1;
export const MAX_DEPTH_HOURS = 168;

/** The fixed error `notify_mark_all_seen` rejects with for an overlay whose SAVED layout has no
 * Notifyfeed widget (the camera REFUSED_ERROR pattern). */
export const REFUSED_ERROR =
	'notify feed is not granted: save a layout with a Notifyfeed widget in Studio';

export function isRefusedError(e: unknown): boolean {
	const text = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
	return text.includes(REFUSED_ERROR);
}
