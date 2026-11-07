import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('./server-check-commands', () => ({
	serverCheckConfigStatus: vi.fn(),
	saveServerCheckConfig: vi.fn(() => Promise.resolve()),
	serverCheckConnect: vi.fn(() => Promise.resolve()),
	serverCheckReconnect: vi.fn(() => Promise.resolve())
}));
vi.mock('./server-check-source', () => ({
	refreshServerCheckCatalog: vi.fn(() => Promise.resolve([]))
}));

import ServerCheckSettings from './ServerCheckSettings';
import {
	saveServerCheckConfig,
	serverCheckConfigStatus,
	serverCheckConnect,
	serverCheckReconnect
} from './server-check-commands';
import { refreshServerCheckCatalog } from './server-check-source';
import { createTelemetryHub, type TelemetryHub } from '../../../core/telemetry';
import { TelemetryHubContext } from '../../telemetryContext';
import { emptyTarget } from './serverCheckModel';
import type { ServerCheckTarget } from './server-check-types';

const SAVED: ServerCheckTarget[] = [
	{ ...emptyTarget('vps'), name: 'VPS', kind: 'tcp', host: 'vps.example.org', port: 22 },
	{
		...emptyTarget('site'),
		name: 'Site',
		kind: 'http',
		url: 'https://example.org/health',
		expectStatus: 200,
		expectKeyword: 'ok'
	}
];

let hub: TelemetryHub;

function renderPane() {
	hub = createTelemetryHub();
	return render(
		<TelemetryHubContext.Provider value={hub}>
			<ServerCheckSettings />
		</TelemetryHubContext.Provider>
	);
}

const input = (root: HTMLElement, id: string, label: string): HTMLInputElement => {
	const row = root.querySelector(`.srvc-target[data-id="${id}"]`) as HTMLElement;
	const field = Array.from(row.querySelectorAll('label')).find((l) =>
		l.textContent?.trim().startsWith(label)
	) as HTMLElement;
	return field.querySelector('input, select') as HTMLInputElement;
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(serverCheckConfigStatus).mockResolvedValue({ configured: true, targets: SAVED });
});

describe('ServerCheckSettings', () => {
	it('prefills the saved targets (kind-specific fields) and starts the worker for the badge', async () => {
		const { container, getByText } = renderPane();
		await waitFor(() => expect(container.querySelectorAll('.srvc-target')).toHaveLength(2));
		expect(input(container, 'vps', 'Name').value).toBe('VPS');
		expect(input(container, 'vps', 'Host').value).toBe('vps.example.org');
		expect(input(container, 'vps', 'Port').value).toBe('22');
		expect(input(container, 'site', 'URL').value).toBe('https://example.org/health');
		expect(input(container, 'site', 'Expected status').value).toBe('200');
		expect(input(container, 'site', 'Body must contain').value).toBe('ok');
		expect(getByText('configured')).toBeTruthy();
		expect(serverCheckConnect).toHaveBeenCalled();
	});

	it('shows "not configured" with an empty list and lets a target be added', async () => {
		vi.mocked(serverCheckConfigStatus).mockResolvedValueOnce({ configured: false, targets: [] });
		const { container, getByText, getByLabelText } = renderPane();
		await waitFor(() => expect(getByText('not configured')).toBeTruthy());
		fireEvent.click(getByText('Add target'));
		expect(container.querySelectorAll('.srvc-target')).toHaveLength(1);
		expect(container.querySelector('.srvc-target')?.getAttribute('data-id')).toBe('target-1');
		// A blank host is a problem → Save disabled, hint shown.
		expect(getByText(/bare host/)).toBeTruthy();
		expect((getByText('Save & check') as HTMLButtonElement).disabled).toBe(true);
		// Filling the row clears the problem; the unnamed row's remove button falls back to its id.
		fireEvent.change(input(container, 'target-1', 'Host'), { target: { value: '10.0.0.1' } });
		expect((getByText('Save & check') as HTMLButtonElement).disabled).toBe(false);
		// Switching to TCP shows an empty port (0 renders blank) until one is typed.
		fireEvent.change(input(container, 'target-1', 'Check'), { target: { value: 'tcp' } });
		expect(input(container, 'target-1', 'Port').value).toBe('');
		expect(getByText(/Port must be/)).toBeTruthy();
		fireEvent.change(input(container, 'target-1', 'Port'), { target: { value: '8080' } });
		expect(input(container, 'target-1', 'Port').value).toBe('8080');
		fireEvent.change(input(container, 'target-1', 'Name'), { target: { value: 'Router' } });
		expect(getByLabelText('Remove Router')).toBeTruthy();
		// A second target gets the next free id even though the first was renamed.
		fireEvent.click(getByText('Add target'));
		const ids = Array.from(container.querySelectorAll('.srvc-target')).map((el) =>
			el.getAttribute('data-id')
		);
		expect(ids).toEqual(['target-1', 'target-2']);
	});

	it('edits flow through the row editor: kind switch swaps the fields, numbers coerce', async () => {
		const { container } = renderPane();
		await waitFor(() => expect(container.querySelectorAll('.srvc-target')).toHaveLength(2));
		fireEvent.change(input(container, 'vps', 'Check'), { target: { value: 'icmp' } });
		expect(input(container, 'vps', 'Host')).toBeTruthy();
		expect(
			container.querySelector('.srvc-target[data-id="vps"] input[type="number"][min="1"]')
		).toBeNull();
		fireEvent.change(input(container, 'vps', 'Check'), { target: { value: 'http' } });
		expect(input(container, 'vps', 'URL').value).toBe('');
		fireEvent.change(input(container, 'vps', 'URL'), { target: { value: 'https://u:p@x.org' } });
		expect(container.textContent).toMatch(/Remove the credentials/);
		fireEvent.change(input(container, 'vps', 'URL'), { target: { value: 'https://x.org' } });
		fireEvent.change(input(container, 'vps', 'Expected status'), { target: { value: '204' } });
		expect(input(container, 'vps', 'Expected status').value).toBe('204');
		fireEvent.change(input(container, 'vps', 'Expected status'), { target: { value: '' } });
		expect(input(container, 'vps', 'Expected status').value).toBe(''); // back to "any 2xx/3xx"
		fireEvent.change(input(container, 'vps', 'Every (s)'), { target: { value: 'abc' } });
		expect(input(container, 'vps', 'Every (s)').value).toBe('30'); // non-numeric → fallback
		fireEvent.change(input(container, 'vps', 'Timeout (ms)'), { target: { value: '500' } });
		expect(input(container, 'vps', 'Timeout (ms)').value).toBe('500');
		fireEvent.change(input(container, 'site', 'Body must contain'), { target: { value: 'fine' } });
		expect(input(container, 'site', 'Body must contain').value).toBe('fine');
	});

	it('saves the list, restarts the worker, refreshes the catalog — in that order', async () => {
		const { container, getByText } = renderPane();
		await waitFor(() => expect(container.querySelectorAll('.srvc-target')).toHaveLength(2));
		fireEvent.change(input(container, 'vps', 'Port'), { target: { value: '2222' } });
		fireEvent.click(getByText('Save & check'));
		await waitFor(() =>
			expect(saveServerCheckConfig).toHaveBeenCalledWith([{ ...SAVED[0], port: 2222 }, SAVED[1]])
		);
		await waitFor(() => expect(refreshServerCheckCatalog).toHaveBeenCalled());
		const order = [saveServerCheckConfig, serverCheckReconnect, refreshServerCheckCatalog].map(
			(f) => vi.mocked(f).mock.invocationCallOrder[0]
		);
		expect(order[0]).toBeLessThan(order[1]);
		expect(order[1]).toBeLessThan(order[2]);
		expect(await waitFor(() => getByText('Saved ✓'))).toBeTruthy();
	});

	it('removing every target saves an empty list and flips to "not configured"', async () => {
		const { container, getByText, getByLabelText } = renderPane();
		await waitFor(() => expect(container.querySelectorAll('.srvc-target')).toHaveLength(2));
		fireEvent.click(getByLabelText('Remove VPS'));
		fireEvent.click(getByLabelText('Remove Site'));
		expect(container.querySelectorAll('.srvc-target')).toHaveLength(0);
		fireEvent.click(getByText('Save & check'));
		await waitFor(() => expect(saveServerCheckConfig).toHaveBeenCalledWith([]));
		await waitFor(() => expect(getByText('not configured')).toBeTruthy());
	});

	it('reports a save failure and reflects the live srv.status badge', async () => {
		vi.mocked(saveServerCheckConfig).mockRejectedValueOnce(new Error('disk full'));
		const { container, getByText, findByText } = renderPane();
		await waitFor(() => expect(container.querySelectorAll('.srvc-target')).toHaveLength(2));
		fireEvent.click(getByText('Save & check'));
		expect(await findByText(/Couldn.t save: disk full/)).toBeTruthy();
		act(() => {
			hub.ingest({ sensor: 'srv.status', ts_ms: 0, value: { kind: 'text', value: 'connected' } });
		});
		expect(getByText(/Connected/)).toBeTruthy();
	});

	it('unmounting before the status resolves does not set state, and rejections leave defaults', async () => {
		let resolve!: (v: { configured: boolean; targets: ServerCheckTarget[] }) => void;
		vi.mocked(serverCheckConfigStatus).mockReturnValueOnce(new Promise((r) => (resolve = r)));
		const { unmount } = renderPane();
		unmount();
		await act(async () => {
			resolve({ configured: true, targets: SAVED });
		});
		vi.mocked(serverCheckConnect).mockRejectedValueOnce(new Error('no backend'));
		vi.mocked(serverCheckConfigStatus).mockRejectedValueOnce(new Error('no backend'));
		const { findByText } = renderPane();
		expect(await findByText('not configured')).toBeTruthy();
	});
});
