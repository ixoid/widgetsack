import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

// Mock the weather Tauri command adapter so the panel runs without a backend. Each fn is a spy so we
// can assert call args + ordering (Save must save → restart). Open-Meteo is keyless, so
// there's no secret field — the form is just location + units + refresh.
vi.mock('./weather-commands', () => ({
	weatherConfigStatus: vi.fn(() =>
		Promise.resolve({
			configured: true,
			latitude: 51.5072,
			longitude: -0.1276,
			unit: 'fahrenheit',
			pollSeconds: 1800,
			provider: 'open-meteo'
		})
	),
	saveWeatherConfig: vi.fn(() => Promise.resolve()),
	weatherConnect: vi.fn(() => Promise.resolve()),
	weatherReconnect: vi.fn(() => Promise.resolve())
}));

import WeatherSettings from './WeatherSettings';
import {
	saveWeatherConfig,
	weatherConfigStatus,
	weatherConnect,
	weatherReconnect
} from './weather-commands';
import { createTelemetryHub, type TelemetryHub } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';

let hub: TelemetryHub;

function renderPanel() {
	hub = createTelemetryHub();
	return render(
		<TelemetryHubContext.Provider value={hub}>
			<WeatherSettings />
		</TelemetryHubContext.Provider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(weatherConfigStatus).mockResolvedValue({
		configured: true,
		latitude: 51.5072,
		longitude: -0.1276,
		unit: 'fahrenheit',
		pollSeconds: 1800,
		provider: 'open-meteo'
	});
});

describe('WeatherSettings', () => {
	it('names the Open-Meteo site without a link that would navigate the studio window', async () => {
		const { container, getByText } = renderPanel();
		await waitFor(() => expect(weatherConnect).toHaveBeenCalled());
		expect(getByText(/open-meteo\.com/)).toBeTruthy();
		expect(container.querySelector('a[href]')).toBeNull();
	});

	it('prefills the form from weather_config_status and starts the live feed', async () => {
		const { container, getByText, getByLabelText } = renderPanel();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		const lon = container.querySelector('input[placeholder="-0.1276"]') as HTMLInputElement;
		await waitFor(() => expect(lat.value).toBe('51.5072'));
		expect(lon.value).toBe('-0.1276');
		// Units mirror the loaded config; poll seconds are shown as minutes (1800s → 30min).
		const unit = getByLabelText('Units') as HTMLSelectElement;
		expect(unit.value).toBe('fahrenheit');
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		expect(poll.value).toBe('30');
		expect(getByText('configured')).toBeTruthy();
		// The studio panel kicks the poll task so the badge has a live status to read.
		expect(weatherConnect).toHaveBeenCalled();
	});

	it('shows "not configured" when the status is unconfigured', async () => {
		vi.mocked(weatherConfigStatus).mockResolvedValue({
			configured: false,
			latitude: 0,
			longitude: 0,
			unit: 'celsius',
			pollSeconds: 900
		});
		const { findByText, container } = renderPanel();
		expect(await findByText('not configured')).toBeTruthy();
		// Falsy lat/lon (0) round-trip to empty fields; default unit + 900s → 15min.
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		expect(lat.value).toBe('');
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		await waitFor(() => expect(poll.value).toBe('15'));
	});

	it('updates the latitude input as the user types', async () => {
		const { container } = renderPanel();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		await waitFor(() => expect(lat.value).toBe('51.5072'));
		fireEvent.change(lat, { target: { value: '40.7128' } });
		expect(lat.value).toBe('40.7128');
	});

	it('flags an out-of-range latitude and disables Save', async () => {
		const { container, getByRole } = renderPanel();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		await waitFor(() => expect(lat.value).toBe('51.5072'));
		fireEvent.change(lat, { target: { value: '999' } });
		expect(lat.getAttribute('aria-invalid')).toBe('true');
		const save = getByRole('button', { name: /Save & fetch/ });
		expect(save.hasAttribute('disabled')).toBe(true);
		// A bad value must not reach the backend.
		fireEvent.click(save);
		expect(saveWeatherConfig).not.toHaveBeenCalled();
	});

	it('flags an out-of-range longitude', async () => {
		const { container } = renderPanel();
		const lon = container.querySelector('input[placeholder="-0.1276"]') as HTMLInputElement;
		await waitFor(() => expect(lon.value).toBe('-0.1276'));
		fireEvent.change(lon, { target: { value: '-500' } });
		expect(lon.getAttribute('aria-invalid')).toBe('true');
	});

	it('saves the parsed numeric config (minutes → seconds) then restarts the task in order', async () => {
		const { container, getByRole, getByLabelText } = renderPanel();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		await waitFor(() => expect(lat.value).toBe('51.5072'));
		const unit = getByLabelText('Units') as HTMLSelectElement;
		fireEvent.change(unit, { target: { value: 'celsius' } });
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		fireEvent.change(poll, { target: { value: '20' } });

		fireEvent.click(getByRole('button', { name: /Save & fetch/ }));

		await waitFor(() =>
			expect(saveWeatherConfig).toHaveBeenCalledWith({
				latitude: 51.5072,
				longitude: -0.1276,
				unit: 'celsius',
				pollSeconds: 1200, // 20 minutes
				provider: 'open-meteo'
			})
		);
		await waitFor(() => expect(weatherReconnect).toHaveBeenCalled());
		// Restart order: save → restart (the running task holds the old config).
		const save = vi.mocked(saveWeatherConfig).mock.invocationCallOrder[0];
		const restart = vi.mocked(weatherReconnect).mock.invocationCallOrder[0];

		expect(save).toBeLessThan(restart);
	});

	it('shows the "Saved ✓" confirmation after a successful save', async () => {
		const { container, getByRole, findByText } = renderPanel();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		await waitFor(() => expect(lat.value).toBe('51.5072'));
		fireEvent.click(getByRole('button', { name: /Save & fetch/ }));
		expect(await findByText('Saved ✓')).toBeTruthy();
	});

	it('reflects the live weather.status sample in the badge', async () => {
		const { getByText } = renderPanel();
		await waitFor(() => expect(weatherConfigStatus).toHaveBeenCalled());
		// Default badge before any sample is "Not connected".
		expect(getByText(/Not connected/)).toBeTruthy();
		act(() => {
			hub.ingest({
				sensor: 'weather.status',
				ts_ms: 0,
				value: { kind: 'text', value: 'connected' }
			});
		});
		expect(getByText(/Connected/)).toBeTruthy();
	});

	it('auto-dismisses the "Saved ✓" tick after 2.5s', async () => {
		vi.useFakeTimers();
		try {
			const { getByRole, getByText, queryByText } = renderPanel();
			await act(async () => {}); // flush the prefill promises
			fireEvent.click(getByRole('button', { name: /Save & fetch/ }));
			await act(async () => {}); // flush the save → restart chain
			expect(getByText('Saved ✓')).toBeTruthy();
			act(() => {
				vi.advanceTimersByTime(2500);
			});
			expect(queryByText('Saved ✓')).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('renders with defaults when the connect kick and the status fetch both reject', async () => {
		vi.mocked(weatherConnect).mockRejectedValue(new Error('no backend'));
		vi.mocked(weatherConfigStatus).mockRejectedValue(new Error('no backend'));
		const { container, findByText } = renderPanel();
		// Both rejections are swallowed; the panel stays usable with its default (empty) form.
		expect(await findByText('not configured')).toBeTruthy();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		expect(lat.value).toBe('');
	});

	it('ignores a status result that resolves after unmount (no setState on a dead panel)', async () => {
		let resolveStatus: (s: {
			configured: boolean;
			latitude: number;
			longitude: number;
			unit: string;
			pollSeconds: number;
			provider?: string;
		}) => void = () => undefined;
		vi.mocked(weatherConfigStatus).mockImplementation(
			() => new Promise((res) => (resolveStatus = res))
		);
		const { container, unmount } = renderPanel();
		const lat = container.querySelector('input[placeholder="51.5072"]') as HTMLInputElement;
		expect(lat.value).toBe('');
		unmount();
		// Resolving late must hit the `alive` guard, not a state setter on the unmounted panel.
		await act(async () => {
			resolveStatus({
				configured: true,
				latitude: 1,
				longitude: 2,
				unit: 'celsius',
				pollSeconds: 900
			});
		});
	});

	it('falls back to celsius + a 15-minute poll when the saved status has neither', async () => {
		vi.mocked(weatherConfigStatus).mockResolvedValue({
			configured: false,
			latitude: 0,
			longitude: 0,
			unit: '', // unset → the || 'celsius' fallback
			pollSeconds: 0 // unset → the || 900 fallback → 15 minutes
		});
		const { container, getByLabelText } = renderPanel();
		await waitFor(() => expect(weatherConfigStatus).toHaveBeenCalled());
		const poll = container.querySelector('input[type="number"]') as HTMLInputElement;
		await waitFor(() => expect(poll.value).toBe('15'));
		const unit = getByLabelText('Units') as HTMLSelectElement;
		expect(unit.value).toBe('celsius');
	});

	it('offers exactly the two providers with the wire values', () => {
		const { getByLabelText } = renderPanel();
		const options = Array.from((getByLabelText('Weather provider') as HTMLSelectElement).options);
		expect(options.map((o) => [o.value, o.textContent])).toEqual([
			['open-meteo', 'Open-Meteo'],
			['met-no', 'MET Norway (met.no)']
		]);
	});

	it('prefills met-no, shows its hint and drops the Open-Meteo help', async () => {
		vi.mocked(weatherConfigStatus).mockResolvedValue({
			configured: true,
			latitude: 59.9,
			longitude: 10.7,
			unit: 'celsius',
			pollSeconds: 900,
			provider: 'met-no'
		});
		const { getByLabelText, getByText, queryByText } = renderPanel();
		const select = getByLabelText('Weather provider') as HTMLSelectElement;
		await waitFor(() => expect(select.value).toBe('met-no'));
		expect(getByText(/Data: MET Norway/)).toBeTruthy();
		expect(select.getAttribute('aria-describedby')).toBe('weather-metno-hint');
		expect(queryByText(/open-meteo\.com/)).toBeNull();
	});

	it.each([[undefined], ['bogus'], ['']])(
		'falls back to Open-Meteo for provider %j',
		async (provider) => {
			vi.mocked(weatherConfigStatus).mockResolvedValue({
				configured: true,
				latitude: 1,
				longitude: 2,
				unit: 'celsius',
				pollSeconds: 900,
				provider
			});
			const { getByLabelText } = renderPanel();
			await waitFor(() => expect(weatherConfigStatus).toHaveBeenCalled());
			await act(async () => {});
			expect((getByLabelText('Weather provider') as HTMLSelectElement).value).toBe('open-meteo');
		}
	);

	it('shows the met.no hint only while met-no is selected', async () => {
		const { getByLabelText, queryByText } = renderPanel();
		await waitFor(() => expect(weatherConfigStatus).toHaveBeenCalled());
		const select = getByLabelText('Weather provider');
		expect(queryByText(/remaining hours/)).toBeNull();
		fireEvent.change(select, { target: { value: 'met-no' } });
		expect(queryByText(/remaining hours/)).toBeTruthy();
		fireEvent.change(select, { target: { value: 'open-meteo' } });
		expect(queryByText(/remaining hours/)).toBeNull();
	});

	it('clears "Saved ✓" when the provider changes', async () => {
		const { getByLabelText, getByRole, findByText, queryByText } = renderPanel();
		await waitFor(() => expect(weatherConfigStatus).toHaveBeenCalled());
		await act(async () => {});
		fireEvent.click(getByRole('button', { name: /Save & fetch/ }));
		expect(await findByText('Saved ✓')).toBeTruthy();
		fireEvent.change(getByLabelText('Weather provider'), { target: { value: 'met-no' } });
		expect(queryByText('Saved ✓')).toBeNull();
	});

	it('saves the chosen provider then restarts the task', async () => {
		const { getByLabelText, getByRole } = renderPanel();
		await waitFor(() => expect(weatherConfigStatus).toHaveBeenCalled());
		await act(async () => {});
		fireEvent.change(getByLabelText('Weather provider'), { target: { value: 'met-no' } });
		fireEvent.click(getByRole('button', { name: /Save & fetch/ }));
		await waitFor(() =>
			expect(saveWeatherConfig).toHaveBeenCalledWith({
				latitude: 51.5072,
				longitude: -0.1276,
				unit: 'fahrenheit',
				pollSeconds: 1800,
				provider: 'met-no'
			})
		);
		await waitFor(() => expect(weatherReconnect).toHaveBeenCalled());
		expect(vi.mocked(saveWeatherConfig).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(weatherReconnect).mock.invocationCallOrder[0]
		);
	});
});

it('reports save failure without showing Saved', async () => {
	vi.mocked(saveWeatherConfig).mockRejectedValueOnce(new Error('disk full'));
	const { getByText, findByText } = renderPanel();
	await waitFor(() => expect((getByText(/Save/) as HTMLButtonElement).disabled).toBe(false));
	fireEvent.click(getByText(/Save/));
	expect(await findByText(/Couldn.t save: disk full/)).toBeTruthy();
});
