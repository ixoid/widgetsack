// Container for the Notifications widget (AudioSwitcherHost shape): WidgetHost resolves the meta
// `sensors` map ({list, count, status}) and passes it here; this Host extracts the plain props,
// owns the minute clock and the mark-all-seen invoke, and renders the props-only NotifyFeed meter.
import { useEffect, useRef, useState } from 'react';
import type { SensorState } from '../../../core/telemetry';
import { useNow } from '../../useNow';
import { isRefusedError, isStatusKind, parseNotifyList } from './notifyfeedModel';
import { notifyMarkAllSeen } from './notifyfeed-commands';
import NotifyFeed from './NotifyFeed';

type HostProps = {
	sensors?: Record<string, SensorState>;
	title?: string;
	maxRows?: number;
	showBody?: boolean;
	color?: string;
};

// The two-line extraction idiom from Weather.tsx: pull the typed value out of a SensorState.
const scalar = (s?: SensorState): number | null =>
	s?.value && s.value.kind === 'scalar' ? s.value.value : null;
const textOf = (s?: SensorState): string | null =>
	s?.value && s.value.kind === 'text' ? s.value.value : null;

/** How long the gate-refusal hint stays on the meter. */
const HINT_MS = 3000;

export default function NotifyFeedHost({
	sensors = {},
	title = '',
	maxRows = 20,
	showBody = true,
	color
}: HostProps) {
	const nowMs = useNow(60_000);
	const items = parseNotifyList(
		sensors.list?.value?.kind === 'json' ? sensors.list.value.value : null
	);
	const count = scalar(sensors.count);
	// Unknown status text degrades to null (loading copy), never to a wrong-kind label.
	const rawStatus = textOf(sensors.status);
	const status = isStatusKind(rawStatus) ? rawStatus : null;
	const [marking, setMarking] = useState(false);
	const [markHint, setMarkHint] = useState<string | null>(null);
	const hintTimer = useRef<number | undefined>(undefined);

	// The hint timeout never outlives the widget.
	useEffect(
		() => () => {
			window.clearTimeout(hintTimer.current);
		},
		[]
	);

	const onMarkAllSeen = (): void => {
		setMarking(true);
		notifyMarkAllSeen()
			.catch((err: unknown) => {
				if (isRefusedError(err)) {
					// An unsaved overlay's button silently doing nothing breaks its contract — show
					// the camera-style "refused" hint for a moment instead (no new error surface).
					setMarkHint('Save the layout in Studio');
					hintTimer.current = window.setTimeout(() => {
						hintTimer.current = undefined;
						setMarkHint(null);
					}, HINT_MS);
				} else {
					console.warn('notify_mark_all_seen failed', err);
				}
			})
			.finally(() => setMarking(false));
	};

	return (
		<NotifyFeed
			title={title}
			maxRows={maxRows}
			showBody={showBody}
			color={color}
			items={items}
			count={count}
			status={status}
			nowMs={nowMs}
			marking={marking}
			markHint={markHint}
			onMarkAllSeen={onMarkAllSeen}
		/>
	);
}
