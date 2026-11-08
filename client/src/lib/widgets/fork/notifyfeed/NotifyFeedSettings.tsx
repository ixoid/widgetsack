// The Notifications plugin's settings pane (studio → Plugins → Notifications). A container
// (ServerCheckSettings shape): owns the depth/exclusion form, drives the Tauri commands via
// notifyfeed-commands.ts, and reads the live badge + unseen count from the hub. Poll cadence is
// DISPLAY-ONLY (hand-editable in plugins/notify.json; it round-trips unchanged on save). Nothing
// here is secret — the config holds no credentials.
import { useEffect, useState } from 'react';
import { useTelemetryHub } from '../../telemetryContext';
import { useSensor } from '../../useSensor';
import { useSettingsOperations } from '../../plugins/useSettingsOperations';
import TokenListField from '../../plugins/TokenListField';
import {
	notifyConfigStatus,
	notifyConnect,
	notifyMarkAllSeen,
	notifyReconnect,
	saveNotifyConfig
} from './notifyfeed-commands';
import {
	exclusionProblem,
	isStatusKind,
	MAX_DEPTH_COUNT,
	MAX_DEPTH_HOURS,
	MIN_DEPTH_COUNT,
	MIN_DEPTH_HOURS,
	paneStatusBadge,
	parseExclusions,
	parseNotifyList,
	unseenCount
} from './notifyfeedModel';
import type { NotifyConfigStatus, NotifyDepthMode } from './notifyfeed-types';
import './NotifyFeedSettings.css';

const DEFAULTS: NotifyConfigStatus = {
	configured: false,
	pollSeconds: 3,
	depthMode: 'count',
	depthCount: 50,
	depthHours: 24,
	exclusions: []
};

export default function NotifyFeedSettings() {
	const hub = useTelemetryHub();
	const status = useSensor(hub, 'notify.status');
	const rawStatus = status.value?.kind === 'text' ? status.value.value : null;
	const badge = paneStatusBadge(isStatusKind(rawStatus) ? rawStatus : null);
	// The pane's own list read drives the Mark-all-seen button; the forced re-emit after marking
	// (or after an exclusion purge) flips it through this same subscription.
	const list = useSensor(hub, 'notify.list');
	const unseen = unseenCount(
		parseNotifyList(list.value?.kind === 'json' ? list.value.value : null)
	);

	const [configured, setConfigured] = useState(DEFAULTS.configured);
	const [pollSeconds, setPollSeconds] = useState(DEFAULTS.pollSeconds);
	const [depthMode, setDepthMode] = useState<NotifyDepthMode>(DEFAULTS.depthMode);
	const [depthCount, setDepthCount] = useState(DEFAULTS.depthCount);
	const [depthHours, setDepthHours] = useState(DEFAULTS.depthHours);
	const [exclusions, setExclusions] = useState<string[]>(DEFAULTS.exclusions);
	const { saving, saved, error: saveError, invalidate, capture, save } = useSettingsOperations();

	useEffect(() => {
		let alive = true;
		const current = capture();
		notifyConnect().catch(() => undefined);
		notifyConfigStatus()
			.then((s) => {
				if (!alive || !current()) return;
				setConfigured(s.configured);
				setPollSeconds(s.pollSeconds);
				setDepthMode(s.depthMode);
				setDepthCount(s.depthCount);
				setDepthHours(s.depthHours);
				setExclusions(s.exclusions);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [capture]);

	const problem = exclusionProblem(exclusions);
	const valid = problem === null;
	// A cleared or non-numeric field keeps the mode's floor instead of becoming 0/NaN.
	const num = (raw: string, fallback: number): number => {
		const n = Number(raw);
		return raw.trim() !== '' && Number.isFinite(n) ? n : fallback;
	};

	const onMarkAll = (): void => {
		notifyMarkAllSeen().catch((err: unknown) => console.warn('notify_mark_all_seen failed', err));
	};

	const onSave = async () => {
		/* v8 ignore next -- the only Save control is disabled for invalid or in-flight submissions. */
		if (!valid || saving) return;
		await save(
			async () => {
				await saveNotifyConfig({
					poll_secs: pollSeconds,
					depth_mode: depthMode,
					// Clamp client-side exactly as the server does (config.rs guardrails).
					depth_count: Math.min(MAX_DEPTH_COUNT, Math.max(MIN_DEPTH_COUNT, depthCount)),
					depth_hours: Math.min(MAX_DEPTH_HOURS, Math.max(MIN_DEPTH_HOURS, depthHours)),
					exclusions
				});
				// restart:true swaps the worker atomically; the in-memory ring survives the swap.
				await notifyReconnect();
			},
			() => setConfigured(true)
		);
	};

	return (
		<div className="has ntf-settings">
			{saveError && <div className="has-test err">Couldn’t save: {saveError}</div>}
			<div className="has-statusline">
				<span className={`has-badge ${badge.tone}`} aria-live="polite">
					● {badge.label}
				</span>
				<span className="has-state-dim">
					{configured ? 'configured' : 'not configured'} · poll {pollSeconds} s
				</span>
			</div>

			<div className="rp-hd">Depth</div>
			<div className="has-help">
				Keep the newest notifications: a fixed number of items, or everything from the last hours.
			</div>
			<div className="ntf-depth-row">
				<label className="has-field">
					Mode
					<select
						value={depthMode}
						onChange={(e) => {
							setDepthMode(e.currentTarget.value as NotifyDepthMode);
							invalidate();
						}}
					>
						<option value="count">Number of items</option>
						<option value="hours">Hours</option>
					</select>
				</label>
				{depthMode === 'count' ? (
					<label className="has-field">
						Items
						<input
							type="number"
							min={MIN_DEPTH_COUNT}
							max={MAX_DEPTH_COUNT}
							step={1}
							value={depthCount}
							onChange={(e) => {
								setDepthCount(num(e.currentTarget.value, MIN_DEPTH_COUNT));
								invalidate();
							}}
						/>
					</label>
				) : (
					<label className="has-field">
						Hours
						<input
							type="number"
							min={MIN_DEPTH_HOURS}
							max={MAX_DEPTH_HOURS}
							step={1}
							value={depthHours}
							onChange={(e) => {
								setDepthHours(num(e.currentTarget.value, MIN_DEPTH_HOURS));
								invalidate();
							}}
						/>
					</label>
				)}
			</div>

			<div className="rp-hd">Exclusions</div>
			<div className="has-help">
				Apps whose notifications are never captured. Matching ignores case and checks both the app
				name and its internal id — a partial name like {'"tele"'} matches Telegram. Saving removes
				already-captured notifications of excluded apps.
			</div>
			<TokenListField
				label="Excluded apps"
				values={exclusions}
				onChange={(next) => {
					setExclusions(next);
					invalidate();
				}}
				parse={parseExclusions}
				placeholder="Telegram — Enter to add"
				emptyHint="No excluded apps — add one above."
				addLabel="Add"
			/>
			{problem && <small className="has-field-err">{problem}</small>}

			<div className="has-actions">
				<button type="button" onClick={onMarkAll} disabled={unseen === 0}>
					Mark all seen
				</button>
			</div>

			<div className="has-actions">
				<button
					type="button"
					className="has-primary"
					onClick={onSave}
					disabled={!valid || saving}
					aria-busy={saving}
				>
					{saving ? 'Saving…' : 'Save & apply'}
				</button>
				{saved && <span className="has-ok">Saved ✓</span>}
			</div>

			<div className="has-help">
				Add a <strong>Notifications</strong> widget from the widget list to show the feed on the
				overlay.
			</div>
		</div>
	);
}
