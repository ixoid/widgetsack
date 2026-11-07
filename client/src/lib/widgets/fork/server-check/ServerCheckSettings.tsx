// The Server check plugin's settings pane (studio → Plugins → Server check). A container (AGENTS.md
// §6): owns the target list, drives the Tauri commands via server-check-commands.ts. The live badge
// reads `srv.status` through the hub, the same path meters use. Nothing here is secret — the backend
// rejects URLs with credentials. Reuses the shared `has-*` settings styling.
import { useEffect, useState } from 'react';
import { useTelemetryHub } from '../../telemetryContext';
import { useSensor } from '../../useSensor';
import { haStatusBadge } from '../../../core/haStatus';
import { useSettingsOperations } from '../../plugins/useSettingsOperations';
import {
	saveServerCheckConfig,
	serverCheckConfigStatus,
	serverCheckConnect,
	serverCheckReconnect
} from './server-check-commands';
import { refreshServerCheckCatalog } from './server-check-source';
import { emptyTarget, newTargetId, targetProblem } from './serverCheckModel';
import type { ServerCheckTarget } from './server-check-types';
import TargetRowEditor from './TargetRowEditor';
import './ServerCheckSettings.css';

export default function ServerCheckSettings() {
	const hub = useTelemetryHub();
	const status = useSensor(hub, 'srv.status');
	const statusText = status.value?.kind === 'text' ? status.value.value : null;
	const badge = haStatusBadge(statusText);

	const [targets, setTargets] = useState<ServerCheckTarget[]>([]);
	const [configured, setConfigured] = useState(false);
	const { saving, saved, error: saveError, invalidate, capture, save } = useSettingsOperations();

	useEffect(() => {
		let alive = true;
		const current = capture();
		serverCheckConnect().catch(() => undefined);
		serverCheckConfigStatus()
			.then((s) => {
				if (!alive || !current()) return;
				setTargets(s.targets);
				setConfigured(s.configured);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [capture]);

	const problems = targets.map(targetProblem);
	const valid = problems.every((p) => p === null);

	const update = (i: number, next: ServerCheckTarget) => {
		setTargets((list) => list.map((t, j) => (j === i ? next : t)));
		invalidate();
	};
	const remove = (i: number) => {
		setTargets((list) => list.filter((_, j) => j !== i));
		invalidate();
	};
	const add = () => {
		setTargets((list) => [
			...list,
			emptyTarget(
				newTargetId(
					`target ${list.length + 1}`,
					list.map((t) => t.id)
				)
			)
		]);
		invalidate();
	};

	const onSave = async () => {
		/* v8 ignore next -- the only Save control is disabled for invalid or in-flight submissions. */
		if (!valid || saving) return;
		await save(
			async () => {
				await saveServerCheckConfig(targets);
				await serverCheckReconnect();
				await refreshServerCheckCatalog();
			},
			() => setConfigured(targets.length > 0)
		);
	};

	return (
		<div className="has srvc-settings">
			{saveError && <div className="has-test err">Couldn’t save: {saveError}</div>}
			<div className="has-statusline">
				<span className={`has-badge ${badge.tone}`} aria-live="polite">
					● {badge.label}
				</span>
				<span className="has-state-dim">{configured ? 'configured' : 'not configured'}</span>
			</div>

			<div className="rp-hd">Targets</div>
			<div className="has-help">
				Hosts to watch: a ping, a TCP port or an HTTP page. Each is probed on its own interval while
				a Server check widget is on screen. Credentials in URLs are rejected.
			</div>

			{targets.map((t, i) => (
				<TargetRowEditor
					key={t.id}
					target={t}
					problem={problems[i]}
					onChange={(next) => update(i, next)}
					onRemove={() => remove(i)}
				/>
			))}

			<div className="has-actions">
				<button type="button" onClick={add}>
					Add target
				</button>
				<button
					type="button"
					className="has-primary"
					onClick={onSave}
					disabled={!valid || saving}
					aria-busy={saving}
				>
					{saving ? 'Saving…' : 'Save & check'}
				</button>
				{saved && <span className="has-ok">Saved ✓</span>}
			</div>

			<div className="has-help">
				Add a <strong>Server check</strong> widget from the widget list to show these on the
				overlay.
			</div>
		</div>
	);
}
