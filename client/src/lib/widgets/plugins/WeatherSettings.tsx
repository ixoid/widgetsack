import { useSettingsOperations } from './useSettingsOperations';
// The Weather plugin's settings pane (studio → Plugins → Weather). A container (AGENTS.md §6): owns
// the form state, drives the Tauri commands via weather-commands.ts. Both providers (Open-Meteo,
// MET Norway) are keyless, so this is just a location + units + refresh + provider form. The live
// badge reads the `weather.status` telemetry sample through the hub, the same path meters use.
// Reuses the shared `has-*` settings styling.
import { useEffect, useState } from 'react';
import { useTelemetryHub } from '../telemetryContext';
import { useSensor } from '../useSensor';
import { haStatusBadge } from '../../core/haStatus';
import {
	weatherConfigStatus,
	saveWeatherConfig,
	weatherConnect,
	weatherReconnect
} from './weather-commands';
import type { WeatherProvider } from './weather-types';

export default function WeatherSettings() {
	const hub = useTelemetryHub();
	const status = useSensor(hub, 'weather.status');
	const statusText = status.value?.kind === 'text' ? status.value.value : null;
	const badge = haStatusBadge(statusText);

	const [lat, setLat] = useState('');
	const [lon, setLon] = useState('');
	const [unit, setUnit] = useState('celsius');
	const [poll, setPoll] = useState(15); // minutes (the backend stores seconds)
	const [provider, setProvider] = useState<WeatherProvider>('open-meteo');
	const [configured, setConfigured] = useState(false);
	const { saving, saved, error: saveError, invalidate, capture, save } = useSettingsOperations();

	useEffect(() => {
		let alive = true;
		const current = capture();
		weatherConnect().catch(() => undefined);
		weatherConfigStatus()
			.then((s) => {
				if (!alive || !current()) return;
				setLat(s.latitude ? String(s.latitude) : '');
				setLon(s.longitude ? String(s.longitude) : '');
				setUnit(s.unit || 'celsius');
				setProvider(s.provider === 'met-no' ? 'met-no' : 'open-meteo');
				setPoll(Math.round((s.pollSeconds || 900) / 60));
				setConfigured(s.configured);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [capture]);

	const latN = parseFloat(lat);
	const lonN = parseFloat(lon);
	const latValid = Number.isFinite(latN) && latN >= -90 && latN <= 90;
	const lonValid = Number.isFinite(lonN) && lonN >= -180 && lonN <= 180;
	const valid = latValid && lonValid;

	const dirtied = invalidate;

	const onSave = async () => {
		/* v8 ignore next -- the only Save control is disabled for invalid or in-flight submissions. */
		if (!valid || saving) return;
		await save(
			async () => {
				await saveWeatherConfig({
					latitude: latN,
					longitude: lonN,
					unit,
					pollSeconds: Math.max(5, poll) * 60,
					provider
				});
				await weatherReconnect();
			},
			() => setConfigured(true)
		);
	};
	return (
		<div className="has">
			{saveError && <div className="has-test err">Couldn’t save: {saveError}</div>}
			<div className="has-statusline">
				<span className={`has-badge ${badge.tone}`} aria-live="polite">
					● {badge.label}
				</span>
				<span className="has-state-dim">{configured ? 'configured' : 'not configured'}</span>
			</div>

			<div className="rp-hd">Provider</div>
			<label className="has-field">
				Weather provider
				<select
					value={provider}
					aria-describedby={provider === 'met-no' ? 'weather-metno-hint' : undefined}
					onChange={(e) => {
						setProvider(e.currentTarget.value as WeatherProvider);
						dirtied();
					}}
				>
					<option value="open-meteo">Open-Meteo</option>
					<option value="met-no">MET Norway (met.no)</option>
				</select>
			</label>
			{provider === 'met-no' && (
				<small className="has-help" id="weather-metno-hint">
					MET Norway does not provide air quality, UV index, feels-like temperature, or sunrise and
					sunset times. Today’s high and low cover the remaining hours only. Data: MET Norway.
				</small>
			)}

			<div className="rp-hd">Location</div>
			<div className="has-help">
				{/* Plain text, not a link: an <a href> would navigate the studio webview itself (the
				    navguard blocks it) and the backend open_url only opens project URLs. */}
				{provider === 'met-no'
					? 'Weather uses MET Norway. No API key is needed. Enter the latitude and longitude of your location. Find these values in a map app.'
					: 'Weather uses Open-Meteo (open-meteo.com). No API key is needed. Enter the latitude and longitude of your location. Find these values on the Open-Meteo website.'}
			</div>

			<label className="has-field">
				Latitude
				<input
					type="text"
					inputMode="decimal"
					placeholder="51.5072"
					value={lat}
					aria-invalid={lat !== '' && !latValid}
					onChange={(e) => {
						setLat(e.currentTarget.value);
						dirtied();
					}}
				/>
				{lat !== '' && !latValid && (
					<small className="has-field-err">Must be a number between −90 and 90.</small>
				)}
			</label>
			<label className="has-field">
				Longitude
				<input
					type="text"
					inputMode="decimal"
					placeholder="-0.1276"
					value={lon}
					aria-invalid={lon !== '' && !lonValid}
					onChange={(e) => {
						setLon(e.currentTarget.value);
						dirtied();
					}}
				/>
				{lon !== '' && !lonValid && (
					<small className="has-field-err">Must be a number between −180 and 180.</small>
				)}
			</label>
			<label className="has-field">
				Units
				<select
					value={unit}
					onChange={(e) => {
						setUnit(e.currentTarget.value);
						dirtied();
					}}
				>
					<option value="celsius">Celsius (°C, km/h)</option>
					<option value="fahrenheit">Fahrenheit (°F, mph)</option>
				</select>
			</label>
			<label className="has-field">
				Refresh (minutes)
				<input
					type="number"
					min={5}
					max={360}
					value={poll}
					onChange={(e) => {
						setPoll(Number(e.currentTarget.value));
						dirtied();
					}}
				/>
			</label>

			<div className="has-actions">
				<button
					type="button"
					className="has-primary"
					onClick={onSave}
					disabled={!valid || saving}
					aria-busy={saving}
				>
					{saving ? 'Saving…' : 'Save & fetch'}
				</button>
				{saved && <span className="has-ok">Saved ✓</span>}
			</div>

			<div className="has-help">
				Add a <strong>Weather</strong> widget from the widget list. You can also bind{' '}
				<code>weather.*</code> sensors to other widgets.
			</div>
		</div>
	);
}
