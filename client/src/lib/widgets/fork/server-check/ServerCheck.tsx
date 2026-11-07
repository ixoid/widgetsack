// Server check card (binds:'none', self-sourcing like the RSS meter): one row per configured target —
// status dot, name, latency, a sparkline of the last probes, and "down N min" while unreachable.
// Subscribing to the `srv.list` JSON sensor both demand-gates the backend probes AND delivers the
// rows; nothing is probed unless this card is mounted. BARE DOM, styled via --np-* / --srvc-* tokens.
import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { TelemetryHubContext } from '../../telemetryContext';
import Sparkline from '../../meters/Sparkline';
import {
	formatDownSince,
	formatLatency,
	parseServerList,
	rowLevel,
	sparkHistory
} from './serverCheckModel';
import type { ServerCheckRow } from './server-check-types';
import './ServerCheck.css';

const LIST = 'srv.list';

type Props = {
	title?: string;
	maxRows?: number;
	showSparkline?: boolean;
	slowMs?: number;
	color?: string;
	/** Test seam: "now" for the down-since label (defaults to the wall clock). */
	now?: () => number;
};

export default function ServerCheck({
	title = '',
	maxRows = 8,
	showSparkline = true,
	slowMs = 150,
	color,
	now = Date.now
}: Props) {
	const hub = useContext(TelemetryHubContext);
	const [rows, setRows] = useState<ServerCheckRow[]>([]);

	useEffect(() => {
		if (!hub) return;
		let sig = '';
		const read = (): void => {
			const v = hub.sensor(LIST).getSnapshot().value;
			const next = parseServerList(v && v.kind === 'json' ? v.value : []);
			const ns = JSON.stringify(next);
			if (ns !== sig) {
				sig = ns;
				setRows(next);
			}
		};
		const off = hub.sensor(LIST).subscribe(read); // demand-gate + change notification
		read();
		return off;
	}, [hub]);

	const vis = rows.slice(0, Math.max(0, maxRows));
	const vars = color ? ({ '--srvc-accent': color } as CSSProperties) : undefined;
	const nowMs = now();

	return (
		<div className="srvc np-servercheck" style={vars}>
			{title && (
				<div className="srvc-head">
					<span className="srvc-title">{title}</span>
				</div>
			)}
			{vis.length === 0 ? (
				<div className="srvc-empty" data-part="empty">
					No targets — add some in Plugins → Server check
				</div>
			) : (
				<ul className="srvc-list">
					{vis.map((row) => {
						const level = rowLevel(row, slowMs);
						const spark = sparkHistory(row.history);
						return (
							<li className="srvc-row" key={row.id} data-level={level} data-id={row.id}>
								<span className="srvc-dot" aria-hidden="true" />
								<span className="srvc-name" title={row.reason || row.name}>
									{row.name}
								</span>
								{showSparkline && spark.length >= 2 && (
									<span className="srvc-spark" data-part="spark">
										<Sparkline history={spark} color="currentColor" seconds={spark.length} />
									</span>
								)}
								<span className="srvc-value" data-part="value">
									{level === 'down'
										? formatDownSince(row.downSince, nowMs) || 'down'
										: formatLatency(row.ms)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
