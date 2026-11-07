// Agenda+ meter (fork, K-1): the Agenda widget's events regrouped into Today / Tomorrow / This week
// (/ Later) with a countdown to the next event. Self-sourcing (binds:'none') on the SAME
// `agenda.list` / `agenda.parse` sensors as the stock Agenda meter, so the Agenda plugin's feed and
// demand gate are reused — this file adds presentation only; the rules live in
// core/fork/agendaGroups.ts. Rides the shared minute clock. BARE DOM; styled via --np-*.
import { useContext, type CSSProperties } from 'react';
import { TelemetryHubContext } from '../../telemetryContext';
import { useNow } from '../../useNow';
import { useSensor } from '../../useSensor';
import { formatEventWhen, parseAgendaFeedback, parseAgendaList } from '../../../core/agenda';
import {
	eventStartMs,
	formatCountdown,
	groupAgenda,
	nextEvent,
	type AgendaGroupKey
} from '../../../core/fork/agendaGroups';
import type { AgendaEvent } from '../../../core/agenda';
import '../../meters/Agenda.css';
import './AgendaPlus.css';

type Props = {
	title?: string;
	maxRows?: number;
	showCountdown?: boolean;
	showLater?: boolean;
	color?: string;
};

/** The row's left column: time for today/tomorrow, weekday + time further out, date for "Later". */
function whenLabel(e: AgendaEvent, group: AgendaGroupKey, nowMs: number): string {
	if (e.allDay) return 'All day';
	const full = formatEventWhen(e.start, false, nowMs);
	return group === 'today' || group === 'tomorrow' ? full.slice(-5) : full;
}

export default function AgendaPlus({
	title = '',
	maxRows = 8,
	showCountdown = true,
	showLater = false,
	color
}: Props) {
	const hub = useContext(TelemetryHubContext);
	const now = useNow(60_000);
	const list = useSensor(hub, 'agenda.list');
	const state = useSensor(hub, 'agenda.parse');
	const events = parseAgendaList(list.value?.kind === 'json' ? list.value.value : null);
	const { warnings, pending } = parseAgendaFeedback(
		state.value?.kind === 'json' ? state.value.value : null
	);
	const { groups, hidden } = groupAgenda(events, now, { includeLater: showLater, maxRows });
	const next = showCountdown ? nextEvent(events, now) : null;
	const vars = color ? ({ '--ag-accent': color } as CSSProperties) : undefined;

	return (
		<div className="agenda agendaplus np-agendaplus" style={vars}>
			{title && (
				<div className="ag-head">
					<span className="ag-title">{title}</span>
				</div>
			)}
			{next && (
				<div className="agp-next" data-part="next">
					<span className="agp-next-label">Next</span>
					<span className="agp-next-summary" title={next.summary}>
						{next.summary}
					</span>
					<span className="agp-next-in">in {formatCountdown(eventStartMs(next), now)}</span>
				</div>
			)}
			{groups.length === 0 ? (
				<div className="ag-empty" data-part="empty">
					{pending
						? 'Reading calendar…'
						: warnings.length
							? 'Calendar unavailable'
							: 'No upcoming events'}
				</div>
			) : (
				<div className="agp-groups" aria-label="Upcoming events by day">
					{groups.map((g) => (
						<section className="agp-group" key={g.key} data-group={g.key}>
							<h3 className="agp-group-title">{g.label}</h3>
							<ol className="ag-list agp-list">
								{g.events.map((e, i) => (
									<li className="ag-row" key={`${e.start}-${e.summary}-${i}`}>
										<div className="ag-event">
											<time className="ag-when" dateTime={e.start}>
												{whenLabel(e, g.key, now)}
											</time>
											<div className="ag-details">
												<div className="ag-summary" title={e.summary}>
													{e.summary}
												</div>
												{e.location && (
													<div className="ag-location" title={e.location}>
														{e.location}
													</div>
												)}
											</div>
										</div>
									</li>
								))}
							</ol>
						</section>
					))}
				</div>
			)}
			{warnings.length > 0 && (
				<div className="ag-status" role="status">
					{warnings.join(' ')}
				</div>
			)}
			{hidden > 0 && (
				<div className="ag-more">
					+{hidden} more {hidden === 1 ? 'event' : 'events'}
				</div>
			)}
		</div>
	);
}
