import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { HwinfoStatus } from './hwinfo-types';

// Mock the command adapter (no backend). Spies so we can assert args + the save → restart → refresh
// ordering. Nothing here is secret.
vi.mock('./hwinfo-commands', () => ({
	hwinfoConnect: vi.fn(() => Promise.resolve()),
	hwinfoReconnect: vi.fn(() => Promise.resolve()),
	saveHwinfoConfig: vi.fn(() => Promise.resolve())
}));
// The source owns the status fetch; mock it so the pane's loads are observable and deterministic.
vi.mock('./hwinfo-source', () => ({ refreshHwinfoCatalog: vi.fn() }));
vi.mock('../../../overlay', () => ({ copyToClipboard: vi.fn(() => Promise.resolve(true)) }));

import HwinfoSettings from './HwinfoSettings';
import { hwinfoConnect, hwinfoReconnect, saveHwinfoConfig } from './hwinfo-commands';
import { refreshHwinfoCatalog } from './hwinfo-source';
import { copyToClipboard } from '../../../overlay';
import { createTelemetryHub, type TelemetryHub } from '../../../core/telemetry';
import { TelemetryHubContext } from '../../telemetryContext';

const cpu = 'CPU [#0]: AMD Ryzen 9 9950X3D: Enhanced';
const status: HwinfoStatus = {
	configured: true,
	pollSeconds: 3,
	enabled: ['gpu-power'],
	running: true,
	backend: 'registry',
	gadgetEnabled: true,
	detail: '10 readings',
	readings: [
		{
			slug: 'cpu-tctl-tdie',
			id: 'hw.cpu-tctl-tdie',
			label: 'CPU (Tctl/Tdie)',
			sensor: cpu,
			unit: '°C',
			value: 63.8
		},
		{
			slug: 'gpu-power',
			id: 'hw.gpu-power',
			label: 'GPU Power',
			sensor: 'GPU [#0]',
			unit: 'W',
			value: 70
		}
	]
};

let hub: TelemetryHub;

function renderPane() {
	hub = createTelemetryHub();
	return render(
		<TelemetryHubContext.Provider value={hub}>
			<HwinfoSettings />
		</TelemetryHubContext.Provider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(refreshHwinfoCatalog).mockResolvedValue(status);
});

describe('HwinfoSettings', () => {
	it('connects, loads the status and prefills interval + picks', async () => {
		const { getByLabelText, getByText, getByDisplayValue } = renderPane();
		expect(hwinfoConnect).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(getByText(/Gadget registry · 10 readings/)).toBeTruthy());
		expect(getByDisplayValue('3')).toBeTruthy();
		const gpu = getByLabelText('Enable GPU Power') as HTMLInputElement;
		const cpuTemp = getByLabelText('Enable CPU (Tctl/Tdie)') as HTMLInputElement;
		expect(gpu.checked).toBe(true);
		expect(cpuTemp.checked).toBe(false);
		expect(getByText('63.8 °C')).toBeTruthy();
		expect(getByText('hw.gpu-power')).toBeTruthy();
	});

	it('still renders when the initial connect is refused (overlay-only build, no backend)', async () => {
		vi.mocked(hwinfoConnect).mockRejectedValueOnce(new Error('no runtime'));
		const { getByText } = renderPane();
		await waitFor(() => expect(getByText(/Gadget registry · 10 readings/)).toBeTruthy());
	});

	it('shows the live hw.status badge from the hub', async () => {
		const { getByText } = renderPane();
		await waitFor(() => expect(getByText(/Not connected/)).toBeTruthy());
		act(() => {
			hub.ingest({ sensor: 'hw.status', ts_ms: 1, value: { kind: 'text', value: 'connected' } });
		});
		await waitFor(() => expect(getByText(/Connected/)).toBeTruthy());
	});

	it('filters the readings list and tells when nothing matches', async () => {
		const { getByLabelText, getByText, queryByLabelText } = renderPane();
		await waitFor(() => expect(getByLabelText('Enable GPU Power')).toBeTruthy());
		fireEvent.change(getByLabelText('Filter readings'), { target: { value: 'tctl' } });
		expect(getByLabelText('Enable CPU (Tctl/Tdie)')).toBeTruthy();
		expect(queryByLabelText('Enable GPU Power')).toBeNull();
		fireEvent.change(getByLabelText('Filter readings'), { target: { value: 'zzz' } });
		expect(getByText('No reading matches the filter.')).toBeTruthy();
	});

	it('toggles picks, clamps the interval and saves → restarts → refreshes in order', async () => {
		const { getByLabelText, getByText, getByDisplayValue } = renderPane();
		await waitFor(() => expect(getByLabelText('Enable GPU Power')).toBeTruthy());
		fireEvent.click(getByLabelText('Enable CPU (Tctl/Tdie)'));
		fireEvent.click(getByLabelText('Enable GPU Power'));
		fireEvent.change(getByDisplayValue('3'), { target: { value: '500' } });
		expect(getByDisplayValue('60')).toBeTruthy();

		const order: string[] = [];
		vi.mocked(saveHwinfoConfig).mockImplementation(async () => {
			order.push('save');
		});
		vi.mocked(hwinfoReconnect).mockImplementation(async () => {
			order.push('restart');
		});
		vi.mocked(refreshHwinfoCatalog).mockImplementation(async () => {
			order.push('refresh');
			return { ...status, detail: '11 readings' };
		});
		fireEvent.click(getByText('Save & refresh'));
		await waitFor(() => expect(getByText('Saved ✓')).toBeTruthy());
		expect(saveHwinfoConfig).toHaveBeenCalledWith({ pollSeconds: 60, enabled: ['cpu-tctl-tdie'] });
		expect(order).toEqual(['save', 'restart', 'refresh']);
		expect(getByText(/11 readings/)).toBeTruthy();
	});

	it('keeps the last status when the post-save probe yields nothing', async () => {
		const { getByLabelText, getByText } = renderPane();
		await waitFor(() => expect(getByLabelText('Enable GPU Power')).toBeTruthy());
		vi.mocked(refreshHwinfoCatalog).mockResolvedValueOnce(null);
		fireEvent.click(getByText('Save & refresh'));
		await waitFor(() => expect(getByText('Saved ✓')).toBeTruthy());
		expect(getByText(/Gadget registry · 10 readings/)).toBeTruthy();
	});

	it('surfaces a save failure', async () => {
		const { getByLabelText, getByText } = renderPane();
		await waitFor(() => expect(getByLabelText('Enable GPU Power')).toBeTruthy());
		vi.mocked(saveHwinfoConfig).mockRejectedValueOnce(new Error('disk full'));
		fireEvent.click(getByText('Save & refresh'));
		await waitFor(() => expect(getByText(/Couldn’t save: disk full/)).toBeTruthy());
		expect(hwinfoReconnect).not.toHaveBeenCalled();
	});

	it('re-probes on Refresh without losing unsaved picks, and tolerates a null probe', async () => {
		const { getByLabelText, getByText } = renderPane();
		await waitFor(() => expect(getByLabelText('Enable GPU Power')).toBeTruthy());
		fireEvent.click(getByLabelText('Enable CPU (Tctl/Tdie)'));
		vi.mocked(refreshHwinfoCatalog).mockResolvedValueOnce({ ...status, detail: 'again' });
		fireEvent.click(getByText('↻ Refresh'));
		await waitFor(() => expect(getByText(/again/)).toBeTruthy());
		expect((getByLabelText('Enable CPU (Tctl/Tdie)') as HTMLInputElement).checked).toBe(true);
		vi.mocked(refreshHwinfoCatalog).mockResolvedValueOnce(null);
		fireEvent.click(getByText('↻ Refresh'));
		await waitFor(() => expect(getByText('↻ Refresh')).toBeTruthy());
		expect(getByText(/again/)).toBeTruthy();
	});

	it('explains an empty catalog and a pending probe', async () => {
		vi.mocked(refreshHwinfoCatalog).mockResolvedValue({
			...status,
			backend: 'none',
			detail: 'HWiNFO64 is not running',
			readings: []
		});
		const { getByText } = renderPane();
		expect(getByText('Probing HWiNFO…')).toBeTruthy();
		await waitFor(() => expect(getByText(/Not available · HWiNFO64 is not running/)).toBeTruthy());
		expect(getByText(/No readings available/)).toBeTruthy();
	});

	it('ignores a probe that resolves to nothing on first load', async () => {
		vi.mocked(refreshHwinfoCatalog).mockResolvedValue(null);
		const { getByText } = renderPane();
		await act(async () => {
			await Promise.resolve();
		});
		expect(getByText('Probing HWiNFO…')).toBeTruthy();
	});

	it('copies ids from both lists', async () => {
		const { getByLabelText } = renderPane();
		await waitFor(() => expect(getByLabelText('Copy sensor id hw.gpu-power')).toBeTruthy());
		fireEvent.click(getByLabelText('Copy sensor id hw.gpu-power'));
		fireEvent.click(getByLabelText('Copy sensor id hw.cpu.temp'));
		expect(copyToClipboard).toHaveBeenCalledWith('hw.gpu-power');
		expect(copyToClipboard).toHaveBeenCalledWith('hw.cpu.temp');
	});
});
