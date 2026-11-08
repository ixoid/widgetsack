// Notifications feed meter (presentational, props-only — the Weather multi-sensor idiom): a
// header (optional title, the TOTAL count badge, a mark-all-seen button) over per-app groups of
// toast rows, newest first. The sibling NotifyFeedHost owns the sensor extraction and the invoke;
// this file renders whatever arrives as props. BARE DOM; styled via --np-* / --ntf-* tokens.
import type { CSSProperties } from 'react';
import { formatAge, groupItems, meterStateCopy, rowLines, unseenCount } from './notifyfeedModel';
import type { NotifyItem, NotifyStatusKind } from './notifyfeed-types';
import './NotifyFeed.css';

type Props = {
	title?: string;
	maxRows?: number;
	showBody?: boolean;
	color?: string;
	items: NotifyItem[];
	/** `notify.count` — the ring TOTAL (owner decision 7), null before the first sample. */
	count: number | null;
	status: NotifyStatusKind | null;
	/** "now" from the Host's shared minute clock, so relative ages refresh without own timers. */
	nowMs: number;
	marking?: boolean;
	markHint?: string | null;
	onMarkAllSeen?: () => void;
};

/** `maxRows` bounds what is RENDERED (the rect bounds what is visible — .ntf-body scrolls). */
const clampRows = (n: number): number => Math.min(100, Math.max(1, Math.floor(n) || 1));

export default function NotifyFeed({
	title = '',
	maxRows = 20,
	showBody = true,
	color,
	items,
	count,
	status,
	nowMs,
	marking = false,
	markHint = null,
	onMarkAllSeen
}: Props) {
	// Slice the FLAT newest-first list first, then group, so a sliced group shows partially.
	const rendered = items.slice(0, clampRows(maxRows));
	const hidden = items.length - rendered.length;
	const groups = groupItems(rendered);
	const unseen = unseenCount(items);
	const state = meterStateCopy(status, items.length);
	const vars = color ? ({ '--ntf-accent': color } as CSSProperties) : undefined;

	return (
		<div className="ntf np-notifyfeed" style={vars}>
			<div className="ntf-head">
				{title !== '' && <span className="ntf-title">{title}</span>}
				{count !== null && (
					<span className="ntf-count" aria-label={`${count} notifications`}>
						{count}
					</span>
				)}
				{/* A real <button> with a fixed box: meta interactive:true + this element is what
				    Canvas's INTERACTIVE_SELECTOR registers for click-through — no manual rect work. */}
				<button
					type="button"
					className="ntf-mark"
					aria-label="Mark all seen"
					data-has-unseen={unseen > 0 || undefined}
					disabled={unseen === 0 || marking}
					onClick={onMarkAllSeen}
				>
					✓
				</button>
			</div>
			{state.title === '' ? (
				<>
					<div className="ntf-body" aria-label="Notifications, newest first">
						{groups.map((g) => (
							<section className="ntf-group" data-app={g.app} key={g.app}>
								<h3 className="ntf-group-title">{g.app}</h3>
								<ul className="ntf-list">
									{g.items.map((item) => {
										const lines = rowLines(item);
										return (
											<li className="ntf-row" data-seen={item.seen} key={item.key}>
												<div className="ntf-item">
													<div className="ntf-line">
														<span className="ntf-title-text" title={lines.headline}>
															{lines.headline}
														</span>
														<time
															className="ntf-when"
															dateTime={new Date(item.tsMs).toISOString()}
															title={new Date(item.tsMs).toLocaleString()}
														>
															{formatAge(item.tsMs, nowMs)}
														</time>
													</div>
													{showBody && lines.body !== '' && (
														<div className="ntf-text">{lines.body}</div>
													)}
												</div>
											</li>
										);
									})}
								</ul>
							</section>
						))}
					</div>
					{hidden > 0 && (
						<div className="ntf-more">
							+{hidden} more {hidden === 1 ? 'item' : 'items'}
						</div>
					)}
				</>
			) : (
				<div className="ntf-state" data-kind={status ?? 'none'}>
					{state.title}
					{state.hint !== '' && <div className="ntf-state-hint">{state.hint}</div>}
				</div>
			)}
			{markHint && (
				<div className="ntf-hint" role="status">
					{markHint}
				</div>
			)}
		</div>
	);
}
