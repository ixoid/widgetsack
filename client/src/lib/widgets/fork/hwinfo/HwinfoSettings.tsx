// The HWiNFO plugin's settings pane (studio → Plugins → Hardware (HWiNFO)). A container (AGENTS.md
// §6): shows which HWiNFO interface answers, lets the user pick which readings become `hw.<slug>`
// sensors, and drives the Tauri commands via hwinfo-commands.ts. The live badge reads `hw.status`
// through the hub (reusing the HA status→badge mapping). Pure list/filter logic lives in
// core/fork/hwinfoCatalog.ts. Reuses the shared `has-*` settings styles (loaded by the HA plugin).
import { useEffect, useState } from 'react';
import Icon from '../../Icon';
import { useTelemetryHub } from '../../telemetryContext';
import { useSensor } from '../../useSensor';
import { haStatusBadge } from '../../../core/haStatus';
import {
	HW_STATUS_ID,
	WELL_KNOWN_ENTRIES,
	backendLabel,
	clampPollSeconds,
	filterReadings,
	formatReading,
	toggleSlug
} from './hwinfoCatalog';
import { copyToClipboard } from '../../../overlay';
import { useSettingsOperations } from '../../plugins/useSettingsOperations';
import { hwinfoConnect, hwinfoReconnect, saveHwinfoConfig } from './hwinfo-commands';
import { refreshHwinfoCatalog } from './hwinfo-source';
import type { HwinfoStatus } from './hwinfo-types';

export default function HwinfoSettings() {
	const hub = useTelemetryHub();
	const live = useSensor(hub, HW_STATUS_ID);
	const badge = haStatusBadge(live.value?.kind === 'text' ? live.value.value : null);

	const [status, setStatus] = useState<HwinfoStatus | null>(null);
	const [enabled, setEnabled] = useState<string[]>([]);
	const [pollSeconds, setPollSeconds] = useState(2);
	const [query, setQuery] = useState('');
	const [probing, setProbing] = useState(false);
	const { saving, saved, error: saveError, invalidate, save, latest } = useSettingsOperations();

	// Initial load: make sure the worker runs, then read the config + a live probe.
	useEffect(() => {
		hwinfoConnect().catch(() => undefined);
		void latest('status', refreshHwinfoCatalog, (s) => {
			if (!s) return;
			setStatus(s);
			setEnabled(s.enabled);
			setPollSeconds(s.pollSeconds);
		});
	}, [latest]);

	// Re-probe HWiNFO. Only `status` (backend truth) changes; the user's unsaved picks and interval
	// live in their own state, so a late result cannot clobber an edit.
	const onProbe = async () => {
		setProbing(true);
		const s = await refreshHwinfoCatalog();
		if (s) setStatus(s);
		setProbing(false);
	};

	const onSave = async () => {
		/* v8 ignore next -- the only Save control is disabled while a save is in flight. */
		if (saving) return;
		await save(
			async () => {
				await saveHwinfoConfig({ pollSeconds: clampPollSeconds(pollSeconds), enabled });
				await hwinfoReconnect();
				return refreshHwinfoCatalog();
			},
			(s) => {
				if (s) setStatus(s);
			}
		);
	};

	const readings = filterReadings(status?.readings ?? [], query);
	const detail = status ? `${backendLabel(status.backend)} · ${status.detail}` : 'Probing HWiNFO…';

	return (
		<div className="has">
			{saveError && <div className="has-test err">Couldn’t save: {saveError}</div>}
			<div className="has-statusline">
				<span className={`has-badge ${badge.tone}`} aria-live="polite">
					● {badge.label}
				</span>
				<span className="has-state-dim">{detail}</span>
			</div>

			<div className="has-help">
				Reads the sensors HWiNFO64 already measures — CPU temperature, effective clocks, package
				power and anything else you tick below. HWiNFO must be running. The free edition limits{' '}
				<strong>Shared Memory Support</strong> to 12 hours per launch; the gadget registry (what
				Rainmeter uses) has no limit but shows only the readings ticked in HWiNFO&rsquo;s Sensors
				window.
			</div>

			<label className="has-field">
				Poll interval (seconds)
				<input
					type="number"
					min={1}
					max={60}
					step={1}
					value={pollSeconds}
					onChange={(e) => {
						setPollSeconds(clampPollSeconds(Number(e.currentTarget.value)));
						invalidate();
					}}
				/>
			</label>

			<div className="rp-hd">Readings</div>
			<div className="has-browser-bar">
				<input
					type="search"
					className="has-search"
					placeholder="Filter readings…"
					value={query}
					onChange={(e) => setQuery(e.currentTarget.value)}
					aria-label="Filter readings"
				/>
				<button type="button" onClick={() => void onProbe()} disabled={probing}>
					{probing ? 'Probing…' : '↻ Refresh'}
				</button>
			</div>
			{readings.length ? (
				<ul className="has-entities" aria-label="HWiNFO readings">
					{readings.map((r) => (
						<li key={r.slug} className="has-entity">
							<label className="has-check" title={r.sensor}>
								<input
									type="checkbox"
									checked={enabled.includes(r.slug)}
									onChange={() => {
										setEnabled((prev) => toggleSlug(prev, r.slug));
										invalidate();
									}}
									aria-label={`Enable ${r.label}`}
								/>
								<span className="has-entity-name">{r.label}</span>
							</label>
							<span className="has-entity-state">{formatReading(r.value, r.unit)}</span>
							<code className="has-entity-id" title={r.id}>
								{r.id}
							</code>
							<button
								type="button"
								className="has-copy"
								title="Copy sensor id"
								aria-label={`Copy sensor id ${r.id}`}
								onClick={() => void copyToClipboard(r.id)}
							>
								⧉
							</button>
						</li>
					))}
				</ul>
			) : (
				<div className="has-help">
					{status?.readings.length
						? 'No reading matches the filter.'
						: 'No readings available — see the status line above.'}
				</div>
			)}

			<div className="has-actions">
				<button
					type="button"
					className="has-primary"
					onClick={() => void onSave()}
					disabled={saving}
					aria-busy={saving}
				>
					{saving ? 'Saving…' : 'Save & refresh'}
				</button>
				{saved && <span className="has-ok">Saved ✓</span>}
			</div>

			<div className="rp-hd">Built-in sensors</div>
			<div className="has-help">
				Always available while HWiNFO reports the CPU. Bind them to a Gauge or Text widget; ticked
				readings above appear as <code>hw.&lt;name&gt;</code>.
			</div>
			<ul className="has-entities" aria-label="Built-in HWiNFO sensors">
				{WELL_KNOWN_ENTRIES.map((e) => (
					<li key={e.id} className="has-entity">
						<span className="has-entity-name" title={e.id}>
							{e.label}
						</span>
						<code className="has-entity-id" title={e.id}>
							{e.id}
						</code>
						<button
							type="button"
							className="has-copy"
							title="Copy sensor id"
							aria-label={`Copy sensor id ${e.id}`}
							onClick={() => void copyToClipboard(e.id)}
						>
							⧉
						</button>
					</li>
				))}
			</ul>
			<div className="has-warn">
				<Icon name="alert" /> Per-core clocks (<code>hw.cpu.clock.core.N</code>) need the
				shared-memory interface; the gadget registry only carries what you ticked in HWiNFO.
			</div>
		</div>
	);
}
