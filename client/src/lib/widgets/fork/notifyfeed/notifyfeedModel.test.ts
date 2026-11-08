import { describe, expect, it } from 'vitest';
import {
	exclusionProblem,
	formatAge,
	groupItems,
	isRefusedError,
	isStatusKind,
	meterStateCopy,
	paneStatusBadge,
	parseExclusions,
	parseNotifyList,
	rowLines,
	unseenCount,
	type NotifyGroup
} from './notifyfeedModel';
import type { NotifyItem } from './notifyfeed-types';

const item = (over: Partial<NotifyItem>): NotifyItem => ({
	key: 'k',
	app: 'App',
	title: '',
	body: '',
	tsMs: 1_000,
	seen: false,
	...over
});

describe('parseNotifyList', () => {
	it('shapes the {version, items} payload and ignores the version', () => {
		const items = parseNotifyList({
			version: 1,
			items: [item({ key: 'a', app: 'Telegram', title: 'Hi', tsMs: 5, seen: true })]
		});
		expect(items).toEqual([
			{ key: 'a', app: 'Telegram', title: 'Hi', body: '', tsMs: 5, seen: true }
		]);
	});

	it('drops malformed entries and non-object inputs instead of throwing', () => {
		expect(parseNotifyList(null)).toEqual([]);
		expect(parseNotifyList('granted')).toEqual([]);
		expect(parseNotifyList({ items: 'nope' })).toEqual([]);
		expect(parseNotifyList({ version: 1, items: [{ key: 'ok' }, null] })).toEqual([]);
		// Each field has its own type guard: one bad field drops only its own entry.
		const kept = item({ key: 'keep' });
		expect(
			parseNotifyList({
				version: 1,
				items: [
					{ ...kept, app: 7 },
					{ ...kept, title: null },
					{ ...kept, tsMs: 'soon' },
					{ ...kept, key: '' },
					kept,
					{ ...kept, seen: 'yes' }
				]
			})
		).toEqual([
			kept,
			// A non-boolean `seen` reads as false, not as malformed: the wire always sends a boolean.
			{ ...kept, seen: false }
		]);
	});
});

describe('groupItems', () => {
	it('groups by app in first-appearance order, newest-first inside each group', () => {
		// Globally newest-first input, interleaved apps.
		const groups = groupItems([
			item({ key: '1', app: 'Telegram', tsMs: 30 }),
			item({ key: '2', app: 'Mail', tsMs: 25 }),
			item({ key: '3', app: 'Telegram', tsMs: 20 }),
			item({ key: '4', app: 'News', tsMs: 10 })
		]);
		expect(groups.map((g: NotifyGroup) => g.app)).toEqual(['Telegram', 'Mail', 'News']);
		expect(groups[0].items.map((i) => i.key)).toEqual(['1', '3']);
		expect(groups[1].items.map((i) => i.key)).toEqual(['2']);
	});

	it('returns an empty array for an empty feed', () => {
		expect(groupItems([])).toEqual([]);
	});
});

describe('unseenCount', () => {
	it('counts only unread items', () => {
		expect(unseenCount([item({ seen: true }), item({ seen: false }), item({ seen: false })])).toBe(
			2
		);
		expect(unseenCount([])).toBe(0);
	});
});

describe('rowLines', () => {
	it('uses the title as the headline with the body below', () => {
		expect(rowLines(item({ title: 'New message', body: 'Hello there' }))).toEqual({
			headline: 'New message',
			body: 'Hello there'
		});
	});

	it('promotes the body to the headline when there is no title', () => {
		expect(rowLines(item({ body: 'Reminder: take out the trash' }))).toEqual({
			headline: 'Reminder: take out the trash',
			body: ''
		});
	});
});

describe('formatAge', () => {
	const at = (secsAgo: number): number => 10_000_000 - secsAgo * 1000;
	const NOW = 10_000_000;

	it('hits the coarse boundaries: now / min / h / d', () => {
		expect(formatAge(at(0), NOW)).toBe('now');
		expect(formatAge(at(59), NOW)).toBe('now');
		expect(formatAge(at(60), NOW)).toBe('1 min');
		expect(formatAge(at(119), NOW)).toBe('1 min');
		expect(formatAge(at(59 * 60), NOW)).toBe('59 min');
		expect(formatAge(at(60 * 60), NOW)).toBe('1 h');
		expect(formatAge(at(23 * 3600), NOW)).toBe('23 h');
		expect(formatAge(at(24 * 3600), NOW)).toBe('1 d');
		expect(formatAge(at(3 * 86_400), NOW)).toBe('3 d');
	});

	it('never shows a negative age (a clock skew can put ts slightly in the future)', () => {
		expect(formatAge(NOW + 5_000, NOW)).toBe('now');
	});
});

describe('meterStateCopy', () => {
	it('denied names the setting and says how to re-allow', () => {
		expect(meterStateCopy('denied', 0)).toEqual({
			title: 'Notification access is off',
			hint: 'Allow widgetsack in Windows Settings → Privacy & security → Notifications.'
		});
	});

	it('unavailable points at the pane', () => {
		expect(meterStateCopy('unavailable', 4)).toEqual({
			title: 'Notifications unavailable',
			hint: 'Check the source in Plugins → Notifications.'
		});
	});

	it('granted + empty is a NEUTRAL single line, granted + items renders no state', () => {
		expect(meterStateCopy('granted', 0)).toEqual({ title: 'No notifications', hint: '' });
		expect(meterStateCopy('granted', 3)).toEqual({ title: '', hint: '' });
	});

	it('off and no-sample both read as loading (transient by construction)', () => {
		expect(meterStateCopy('off', 0)).toEqual({ title: 'Reading notifications…', hint: '' });
		expect(meterStateCopy(null, 0)).toEqual({ title: 'Reading notifications…', hint: '' });
	});
});

describe('paneStatusBadge', () => {
	it('maps every status kind to its label and tone', () => {
		expect(paneStatusBadge('granted')).toEqual({ label: 'Granted', tone: 'ok' });
		expect(paneStatusBadge('denied')).toEqual({ label: 'Access denied', tone: 'warn' });
		expect(paneStatusBadge('unavailable')).toEqual({ label: 'Unavailable', tone: 'warn' });
		expect(paneStatusBadge('off')).toEqual({ label: 'Idle', tone: '' });
		expect(paneStatusBadge(null)).toEqual({ label: 'Idle', tone: '' });
	});
});

describe('isStatusKind', () => {
	it('accepts the four wire kinds and rejects everything else', () => {
		expect(isStatusKind('granted')).toBe(true);
		expect(isStatusKind('off')).toBe(true);
		expect(isStatusKind('bogus')).toBe(false);
		expect(isStatusKind(null)).toBe(false);
	});
});

describe('parseExclusions', () => {
	it('splits on newline only (app names may contain commas), trims, drops empties', () => {
		expect(parseExclusions('Telegram Desktop\n  Mail  \n\n')).toEqual(['Telegram Desktop', 'Mail']);
		expect(parseExclusions('')).toEqual([]);
	});
});

describe('exclusionProblem', () => {
	it('is null inside the guardrails and names the broken one outside', () => {
		expect(exclusionProblem(['Telegram', 'Bank'])).toBeNull();
		expect(exclusionProblem([])).toBeNull();
		const many = Array.from({ length: 65 }, (_, i) => `app${i}`);
		expect(exclusionProblem(many)).toBe('at most 64 exclusions');
		expect(exclusionProblem(['word'.repeat(26)])).toBe('each exclusion must be 1-100 characters');
	});
});

describe('refused error text', () => {
	it('recognises the fixed gate refusal (Error and plain string), rejects other errors', () => {
		const refused = new Error(
			'notify feed is not granted: save a layout with a Notifyfeed widget in Studio'
		);
		expect(isRefusedError(refused)).toBe(true);
		expect(
			isRefusedError('notify feed is not granted: save a layout with a Notifyfeed widget in Studio')
		).toBe(true);
		expect(isRefusedError(new Error('io error'))).toBe(false);
		expect(isRefusedError(undefined)).toBe(false);
	});
});
