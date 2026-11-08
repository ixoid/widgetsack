import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

vi.mock('./notifyfeed-commands', () => ({
	notifyMarkAllSeen: vi.fn(() => Promise.resolve())
}));

import NotifyFeedHost from './NotifyFeedHost';
import { notifyMarkAllSeen } from './notifyfeed-commands';
import type { SensorState, SensorValue } from '../../../core/telemetry';

const state = (value: SensorValue | null): SensorState => ({ value, history: [] });
const json = (v: unknown): SensorValue => ({ kind: 'json', value: v });

const PAYLOAD = {
	version: 1,
	items: [
		{ key: 'a', app: 'Telegram', title: 'New message', body: 'Hi', tsMs: 100, seen: false },
		{ key: 'b', app: 'Mail', title: 'Seen one', body: '', tsMs: 50, seen: true }
	]
};

const sensors = (): Record<string, SensorState> => ({
	list: state(json(PAYLOAD)),
	count: state({ kind: 'scalar', value: 5 }),
	status: state({ kind: 'text', value: 'granted' })
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

describe('NotifyFeedHost', () => {
	it('extracts plain meter props from the sensors snapshot', () => {
		const { container, getByText } = render(<NotifyFeedHost sensors={sensors()} />);
		expect(container.querySelectorAll('.ntf-row')).toHaveLength(2);
		expect(container.querySelector('.ntf-row[data-seen="false"]')).toBeTruthy();
		expect(container.querySelector('.ntf-count')?.textContent).toBe('5');
		expect(getByText('Telegram')).toBeTruthy();
	});

	it('degrades to loading copy when the sensors are absent or the wrong kind', () => {
		// No meta map yet (studio preview before resolution) and non-matching value kinds.
		const { container, getByText } = render(
			<NotifyFeedHost
				sensors={{
					list: state({ kind: 'text', value: 'granted' }),
					count: state({ kind: 'text', value: 'nope' }),
					status: state({ kind: 'scalar', value: 1 })
				}}
			/>
		);
		expect(getByText('Reading notifications…')).toBeTruthy();
		expect(container.querySelector('.ntf-count')).toBeNull();
		expect(container.querySelector('.ntf-row')).toBeNull();
	});

	it('invokes notify_mark_all_seen directly on button click and holds the button while in flight', async () => {
		let resolve!: () => void;
		vi.mocked(notifyMarkAllSeen).mockReturnValueOnce(new Promise<void>((r) => (resolve = r)));
		const { container } = render(<NotifyFeedHost sensors={sensors()} />);
		const button = container.querySelector('.ntf-mark') as HTMLButtonElement;
		expect(button.disabled).toBe(false);
		fireEvent.click(button);
		expect(notifyMarkAllSeen).toHaveBeenCalledTimes(1);
		expect(button.disabled).toBe(true); // marking
		await act(async () => {
			resolve();
		});
		expect(button.disabled).toBe(false); // unseen stays 1 until the re-emit lands
	});

	it('shows the gate-refusal hint for 3 s, then clears it', async () => {
		vi.mocked(notifyMarkAllSeen).mockRejectedValueOnce(
			new Error('notify feed is not granted: save a layout with a Notifyfeed widget in Studio')
		);
		const { container, getByText, queryByText } = render(<NotifyFeedHost sensors={sensors()} />);
		fireEvent.click(container.querySelector('.ntf-mark') as HTMLButtonElement);
		await act(async () => {
			vi.advanceTimersByTime(0);
		});
		expect(getByText('Save the layout in Studio')).toBeTruthy();
		await act(async () => {
			vi.advanceTimersByTime(3000);
		});
		expect(queryByText('Save the layout in Studio')).toBeNull();
	});

	it('only warns for other failures — no hint', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		vi.mocked(notifyMarkAllSeen).mockRejectedValueOnce(new Error('io error'));
		const { container, queryByText } = render(<NotifyFeedHost sensors={sensors()} />);
		fireEvent.click(container.querySelector('.ntf-mark') as HTMLButtonElement);
		await act(async () => {
			vi.advanceTimersByTime(0);
		});
		expect(warn).toHaveBeenCalledOnce();
		expect(queryByText('Save the layout in Studio')).toBeNull();
		warn.mockRestore();
	});

	it('cancels the pending hint timeout on unmount (no timer leaks)', async () => {
		vi.mocked(notifyMarkAllSeen).mockRejectedValueOnce(
			new Error('notify feed is not granted: save a layout with a Notifyfeed widget in Studio')
		);
		const { container, unmount } = render(<NotifyFeedHost sensors={sensors()} />);
		expect(vi.getTimerCount()).toBe(1); // the shared minute clock
		fireEvent.click(container.querySelector('.ntf-mark') as HTMLButtonElement);
		await act(async () => {
			vi.advanceTimersByTime(0);
		});
		expect(vi.getTimerCount()).toBe(2); // + the hint timeout
		unmount();
		expect(vi.getTimerCount()).toBe(0); // both cleaned up
	});
});
