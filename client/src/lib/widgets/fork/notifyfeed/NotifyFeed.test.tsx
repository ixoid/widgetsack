import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import NotifyFeed from './NotifyFeed';
import type { NotifyItem } from './notifyfeed-types';

const NOW = 10_000_000;

const item = (over: Partial<NotifyItem>): NotifyItem => ({
	key: 'k',
	app: 'Telegram',
	title: '',
	body: '',
	tsMs: 9_000_000, // 1000 s ago → "16 min"
	seen: false,
	...over
});

// Props that render the body (granted + non-empty); tests override what they need.
const base = {
	items: [item({ key: 'a', title: 'New message', body: 'Hello', seen: false })],
	count: 7 as number | null,
	status: 'granted' as const,
	nowMs: NOW
};

describe('NotifyFeed meter', () => {
	it('groups rows by app in first-appearance order with per-row data-seen', () => {
		const { container } = render(
			<NotifyFeed
				{...base}
				items={[
					item({ key: '1', app: 'Telegram', title: 'first', seen: false }),
					item({ key: '2', app: 'Mail', title: 'second', seen: true }),
					item({ key: '3', app: 'Telegram', title: 'third', seen: true })
				]}
			/>
		);
		const groups = Array.from(container.querySelectorAll('.ntf-group'));
		expect(groups.map((g) => g.getAttribute('data-app'))).toEqual(['Telegram', 'Mail']);
		expect(groups[0].querySelectorAll('.ntf-title-text')).toHaveLength(2);
		const seen = Array.from(container.querySelectorAll('.ntf-row')).map((r) =>
			r.getAttribute('data-seen')
		);
		expect(seen).toEqual(['false', 'true', 'true']);
	});

	it('slices the flat list BEFORE grouping, so a sliced group shows partially, and counts the rest', () => {
		const { container, rerender } = render(
			<NotifyFeed
				{...base}
				items={[
					item({ key: '1', app: 'Telegram', title: 'a' }),
					item({ key: '2', app: 'Telegram', title: 'b' }),
					item({ key: '3', app: 'Mail', title: 'c' })
				]}
				maxRows={2}
			/>
		);
		expect(container.querySelectorAll('.ntf-row')).toHaveLength(2);
		expect(container.querySelector('.ntf-group[data-app="Mail"]')).toBeNull();
		expect(container.querySelector('.ntf-more')?.textContent).toBe('+1 more item');
		rerender(
			<NotifyFeed
				{...base}
				items={[
					item({ key: '1', app: 'Telegram', title: 'a' }),
					item({ key: '2', app: 'Telegram', title: 'b' }),
					item({ key: '3', app: 'Mail', title: 'c' }),
					item({ key: '4', app: 'Mail', title: 'd' })
				]}
				maxRows={2}
			/>
		);
		expect(container.querySelector('.ntf-more')?.textContent).toBe('+2 more items');
	});

	it('hides body lines with showBody:false and for title-less toasts promotes the body', () => {
		const { container, rerender } = render(
			<NotifyFeed
				{...base}
				items={[item({ key: 'a', title: 'Title', body: 'Body' })]}
				showBody={false}
			/>
		);
		expect(container.querySelector('.ntf-text')).toBeNull();
		expect(container.querySelector('.ntf-title-text')?.textContent).toBe('Title');
		rerender(
			<NotifyFeed
				{...base}
				items={[item({ key: 'b', title: '', body: 'Body as headline' })]}
				showBody={false}
			/>
		);
		// A no-title toast shows its body as the headline — no second line even with showBody off.
		expect(container.querySelector('.ntf-title-text')?.textContent).toBe('Body as headline');
		expect(container.querySelector('.ntf-text')).toBeNull();
	});

	it('shows the total count badge with its aria-label, and hides it before the first sample', () => {
		const { container, rerender } = render(<NotifyFeed {...base} count={7} />);
		const badge = container.querySelector('.ntf-count');
		expect(badge?.textContent).toBe('7');
		expect(badge?.getAttribute('aria-label')).toBe('7 notifications');
		rerender(<NotifyFeed {...base} count={null} />);
		expect(container.querySelector('.ntf-count')).toBeNull();
	});

	it('disables the mark button without unseen items or while marking; clicks invoke the handler', () => {
		const onMarkAllSeen = vi.fn();
		const { rerender } = render(
			<NotifyFeed
				{...base}
				items={[item({ key: 'a', seen: true })]}
				onMarkAllSeen={onMarkAllSeen}
			/>
		);
		const button = document.querySelector('.ntf-mark') as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(button.hasAttribute('data-has-unseen')).toBe(false);
		rerender(
			<NotifyFeed
				{...base}
				items={[item({ key: 'a', seen: false })]}
				onMarkAllSeen={onMarkAllSeen}
			/>
		);
		expect(button.disabled).toBe(false);
		expect(button.getAttribute('data-has-unseen')).toBe('true');
		expect(button.getAttribute('aria-label')).toBe('Mark all seen');
		fireEvent.click(button);
		expect(onMarkAllSeen).toHaveBeenCalledTimes(1);
		rerender(
			<NotifyFeed
				{...base}
				items={[item({ key: 'a', seen: false })]}
				marking
				onMarkAllSeen={onMarkAllSeen}
			/>
		);
		expect(button.disabled).toBe(true);
	});

	it('clamps maxRows into 1..100 and applies the accent color variable', () => {
		const many = [
			item({ key: '1', title: 'a' }),
			item({ key: '2', title: 'b' }),
			item({ key: '3', title: 'c' })
		];
		const { container, rerender } = render(
			<NotifyFeed {...base} items={many} maxRows={150} color="#ff8800" />
		);
		// 150 clamps to 100 — no artificial "more" footer for a short feed.
		expect(container.querySelectorAll('.ntf-row')).toHaveLength(3);
		expect(container.querySelector('.ntf-more')).toBeNull();
		expect(container.querySelector('.ntf')?.getAttribute('style')).toContain('--ntf-accent');
		rerender(<NotifyFeed {...base} items={many} maxRows={0} />);
		// 0 clamps UP to 1 — at least one row always renders.
		expect(container.querySelectorAll('.ntf-row')).toHaveLength(1);
		expect(container.querySelector('.ntf-more')?.textContent).toBe('+2 more items');
	});

	it('renders the relative age with machine-readable dateTime and a locale tooltip', () => {
		const ts = NOW - 2 * 60_000;
		const { container } = render(
			<NotifyFeed {...base} items={[item({ key: 'a', title: 'Hi', tsMs: ts })]} />
		);
		const when = container.querySelector('.ntf-when') as HTMLElement;
		expect(when.textContent).toBe('2 min');
		expect(when.getAttribute('dateTime')).toBe(new Date(ts).toISOString());
		// Locale gotcha (CLAUDE.md): compute the expectation with the same formatter as the code.
		expect(when.getAttribute('title')).toBe(new Date(ts).toLocaleString());
	});

	it('renders the header title only when set', () => {
		const { container, rerender } = render(<NotifyFeed {...base} title="Feed" />);
		expect(container.querySelector('.ntf-title')?.textContent).toBe('Feed');
		rerender(<NotifyFeed {...base} title="" />);
		expect(container.querySelector('.ntf-title')).toBeNull();
	});

	it('replaces the body with the state copy for denied / unavailable, keeping the header', () => {
		const { getByText, rerender, container } = render(<NotifyFeed {...base} status="denied" />);
		expect(getByText('Notification access is off')).toBeTruthy();
		expect(
			getByText('Allow widgetsack in Windows Settings → Privacy & security → Notifications.')
		).toBeTruthy();
		expect(container.querySelector('.ntf-body')).toBeNull();
		expect(container.querySelector('.ntf-mark')).toBeTruthy();
		rerender(<NotifyFeed {...base} status="unavailable" />);
		expect(getByText('Notifications unavailable')).toBeTruthy();
		expect(getByText('Check the source in Plugins → Notifications.')).toBeTruthy();
	});

	it('shows neutral empty copy for granted + no items and loading copy for off / no sample', () => {
		const { getByText, rerender } = render(<NotifyFeed {...base} items={[]} status="granted" />);
		expect(getByText('No notifications')).toBeTruthy();
		rerender(<NotifyFeed {...base} items={[]} status="off" />);
		expect(getByText('Reading notifications…')).toBeTruthy();
		rerender(<NotifyFeed {...base} items={[]} status={null} />);
		expect(getByText('Reading notifications…')).toBeTruthy();
	});

	it('shows the transient gate-refusal hint as a live status', () => {
		const { getByText } = render(<NotifyFeed {...base} markHint="Save the layout in Studio" />);
		const hint = getByText('Save the layout in Studio');
		expect(hint.getAttribute('role')).toBe('status');
	});
});
