import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('./notifyfeed-commands', () => ({
	notifyConfigStatus: vi.fn(),
	saveNotifyConfig: vi.fn(() => Promise.resolve()),
	notifyConnect: vi.fn(() => Promise.resolve()),
	notifyReconnect: vi.fn(() => Promise.resolve()),
	notifyMarkAllSeen: vi.fn(() => Promise.resolve())
}));

import NotifyFeedSettings from './NotifyFeedSettings';
import {
	notifyConfigStatus,
	notifyConnect,
	notifyMarkAllSeen,
	notifyReconnect,
	saveNotifyConfig
} from './notifyfeed-commands';
import { createTelemetryHub, type TelemetryHub } from '../../../core/telemetry';
import { TelemetryHubContext } from '../../telemetryContext';
import type { NotifyConfigStatus } from './notifyfeed-types';

const SAVED: NotifyConfigStatus = {
	configured: true,
	pollSeconds: 5,
	depthMode: 'hours',
	depthCount: 30,
	depthHours: 48,
	exclusions: ['Telegram']
};

let hub: TelemetryHub;

function renderPane() {
	hub = createTelemetryHub();
	return render(
		<TelemetryHubContext.Provider value={hub}>
			<NotifyFeedSettings />
		</TelemetryHubContext.Provider>
	);
}

const field = (root: HTMLElement, label: string): HTMLInputElement => {
	const row = Array.from(root.querySelectorAll('label')).find((l) =>
		l.textContent?.trim().startsWith(label)
	) as HTMLElement;
	return row.querySelector('input, select') as HTMLInputElement;
};

const ingestStatus = (value: string): void => {
	act(() => {
		hub.ingest({ sensor: 'notify.status', ts_ms: 0, value: { kind: 'text', value } });
	});
};

const ingestList = (seen: boolean): void => {
	act(() => {
		hub.ingest({
			sensor: 'notify.list',
			ts_ms: 0,
			value: {
				kind: 'json',
				value: {
					version: 1,
					items: [{ key: 'a', app: 'Mail', title: 'Hi', body: '', tsMs: 1, seen }]
				}
			}
		});
	});
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(notifyConfigStatus).mockResolvedValue(SAVED);
});

describe('NotifyFeedSettings', () => {
	it('loads the saved config, starts the worker and reflects the live badge', async () => {
		const { container, getByText } = renderPane();
		await waitFor(() => expect(getByText('configured · poll 5 s')).toBeTruthy());
		expect(notifyConnect).toHaveBeenCalled();
		// hours mode: the Hours field carries its own bounds and the saved value.
		expect(field(container, 'Mode').value).toBe('hours');
		expect(field(container, 'Hours').value).toBe('48');
		expect(field(container, 'Hours').min).toBe('1');
		expect(field(container, 'Hours').max).toBe('168');
		expect(container.querySelector('.has-token-text')?.textContent).toBe('Telegram');
		ingestStatus('granted');
		expect(getByText(/Granted/)).toBeTruthy();
	});

	it('switching the depth mode swaps the number field label and bounds', async () => {
		const { container, getByText } = renderPane();
		await waitFor(() => expect(getByText('configured · poll 5 s')).toBeTruthy());
		// A cleared or non-numeric field snaps to the mode's floor (the repo number-input idiom).
		fireEvent.change(field(container, 'Hours'), { target: { value: '' } });
		expect(field(container, 'Hours').value).toBe('1');
		fireEvent.change(field(container, 'Hours'), { target: { value: '12' } });
		expect(field(container, 'Hours').value).toBe('12');
		fireEvent.change(field(container, 'Mode'), { target: { value: 'count' } });
		expect(field(container, 'Items').value).toBe('30');
		expect(field(container, 'Items').min).toBe('10');
		expect(field(container, 'Items').max).toBe('200');
		fireEvent.change(field(container, 'Items'), { target: { value: '999' } });
		expect(field(container, 'Items').value).toBe('999');
		fireEvent.change(field(container, 'Items'), { target: { value: 'abc' } });
		expect(field(container, 'Items').value).toBe('10');
	});

	it('saves the snake_case payload nested under { config }, clamped, then restarts the worker', async () => {
		const { container, getByText } = renderPane();
		await waitFor(() => expect(getByText('configured · poll 5 s')).toBeTruthy());
		// An out-of-bounds hours value is clamped client-side exactly as the server would.
		fireEvent.change(field(container, 'Hours'), { target: { value: '999' } });
		const input = screen.getByPlaceholderText('Telegram — Enter to add');
		fireEvent.change(input, { target: { value: 'Bank' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		fireEvent.click(screen.getByLabelText('Remove Telegram'));
		fireEvent.click(getByText('Save & apply'));
		// The pane passes the flat snake_case input; the { config } nesting is the adapter's job
		// (asserted in notifyfeed-commands.test.ts).
		await waitFor(() =>
			expect(saveNotifyConfig).toHaveBeenCalledWith({
				poll_secs: 5,
				depth_mode: 'hours',
				depth_count: 30,
				depth_hours: 168,
				exclusions: ['Bank']
			})
		);
		await waitFor(() => expect(notifyReconnect).toHaveBeenCalled());
		expect(vi.mocked(saveNotifyConfig).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(notifyReconnect).mock.invocationCallOrder[0]
		);
		expect(await waitFor(() => getByText('Saved ✓'))).toBeTruthy();
		expect(container.querySelector('.has-field-err')).toBeNull();
	});

	it('shows Saving… with aria-busy while the save is in flight', async () => {
		let resolve!: () => void;
		vi.mocked(saveNotifyConfig).mockReturnValueOnce(new Promise<void>((r) => (resolve = r)));
		const { getByText } = renderPane();
		await waitFor(() => expect(getByText('configured · poll 5 s')).toBeTruthy());
		fireEvent.click(getByText('Save & apply'));
		const busy = getByText('Saving…') as HTMLButtonElement;
		expect(busy.getAttribute('aria-busy')).toBe('true');
		await act(async () => {
			resolve();
		});
		expect(await waitFor(() => getByText('Saved ✓'))).toBeTruthy();
	});

	it('marks all seen from the pane, gated on the live unread count', async () => {
		const { getByText } = renderPane();
		const mark = getByText('Mark all seen') as HTMLButtonElement;
		expect(mark.disabled).toBe(true); // no unread items yet
		ingestList(false);
		expect(mark.disabled).toBe(false);
		fireEvent.click(mark);
		expect(notifyMarkAllSeen).toHaveBeenCalledTimes(1);
		ingestList(true); // the forced re-emit is the feedback
		expect(mark.disabled).toBe(true);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		vi.mocked(notifyMarkAllSeen).mockRejectedValueOnce(new Error('io error'));
		ingestList(false);
		fireEvent.click(mark);
		await act(async () => {
			await Promise.resolve();
		});
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it('flags oversized exclusions inline and disables Save until fixed', async () => {
		const { container, getByText, queryByText } = renderPane();
		await waitFor(() => expect(getByText('configured · poll 5 s')).toBeTruthy());
		const input = screen.getByPlaceholderText('Telegram — Enter to add');
		fireEvent.change(input, { target: { value: 'x'.repeat(101) } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(container.querySelector('.has-field-err')?.textContent).toBe(
			'each exclusion must be 1-100 characters'
		);
		expect((getByText('Save & apply') as HTMLButtonElement).disabled).toBe(true);
		expect(saveNotifyConfig).not.toHaveBeenCalled();
		fireEvent.click(screen.getByLabelText('Remove ' + 'x'.repeat(101)));
		expect(queryByText('each exclusion must be 1-100 characters')).toBeNull();
		expect((getByText('Save & apply') as HTMLButtonElement).disabled).toBe(false);
	});

	it('reports a save failure through the shared error row', async () => {
		vi.mocked(saveNotifyConfig).mockRejectedValueOnce(new Error('disk full'));
		const { findByText, getByText } = renderPane();
		await waitFor(() => expect(getByText('configured · poll 5 s')).toBeTruthy());
		fireEvent.click(getByText('Save & apply'));
		expect(await findByText(/Couldn.t save: disk full/)).toBeTruthy();
	});

	it('leaves the defaults when the status load rejects, and after unmount resolves nothing', async () => {
		vi.mocked(notifyConfigStatus).mockRejectedValueOnce(new Error('no backend'));
		const { getByText } = renderPane();
		expect(await waitFor(() => getByText('not configured · poll 3 s'))).toBeTruthy();
		vi.mocked(notifyConnect).mockRejectedValueOnce(new Error('no backend'));
		let resolve!: (v: NotifyConfigStatus) => void;
		vi.mocked(notifyConfigStatus).mockReturnValueOnce(new Promise((r) => (resolve = r)));
		const { unmount } = renderPane();
		unmount();
		await act(async () => {
			resolve(SAVED);
		});
	});

	it('drops a status load that resolves after an edit (capture staleness guard)', async () => {
		let resolve!: (v: NotifyConfigStatus) => void;
		vi.mocked(notifyConfigStatus).mockReturnValueOnce(new Promise((r) => (resolve = r)));
		const { getByText } = renderPane();
		// The save bumps the revision before awaiting, so the in-flight load is stale afterwards.
		fireEvent.click(getByText('Save & apply'));
		await waitFor(() => expect(getByText('Saved ✓')).toBeTruthy());
		await act(async () => {
			resolve(SAVED);
		});
		// configured comes from the save's apply callback; the stale poll 5 never lands.
		expect(getByText('configured · poll 3 s')).toBeTruthy();
	});
});
