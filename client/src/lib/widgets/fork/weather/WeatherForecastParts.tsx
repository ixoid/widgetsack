// Presentational pieces of the Forecast meter (fork, W-3): the hour strip and the day table. Props
// only — the meter owns sensor reads and the clock. Styled in WeatherForecast.css (`wf-*`).
import type { CSSProperties } from 'react';
import type { DayRow, ForecastLocale, HourCell } from '../../../core/fork/weatherForecast';
import { forecastText } from '../../../core/fork/weatherForecast';
import Icon from '../../Icon';

export const deg = (n: number | null): string => (n == null ? '—' : `${Math.round(n)}°`);

// A CSS custom property is not part of CSSProperties' typings.
const COLS = (n: number): CSSProperties => ({ '--wf-cols': Math.min(n, 12) }) as CSSProperties;

export function HourStrip({ cells }: { cells: HourCell[] }) {
	return (
		<div className="wf-hours" data-part="hours" style={COLS(cells.length)}>
			{cells.map((c) => (
				<div className={c.now ? 'wf-h now' : 'wf-h'} data-part="hour" key={c.key}>
					<span className="wf-hh">{c.hour}</span>
					<span className="wf-hi-ico" role="img" aria-label={c.label}>
						<Icon name={c.icon} />
					</span>
					<span className="wf-ht">{deg(c.temp)}</span>
				</div>
			))}
		</div>
	);
}

export function DayTable({ rows, locale }: { rows: DayRow[]; locale: ForecastLocale }) {
	const text = forecastText(locale);
	return (
		<div className="wf-days" data-part="days">
			<div className="wf-head">
				<span>{text.day}</span>
				<span />
				<span>{text.high}</span>
				<span>{text.low}</span>
			</div>
			{rows.map((r) => (
				<div className={r.today ? 'wf-day today' : 'wf-day'} data-part="day" key={r.date}>
					<span className="wf-dn">
						<b>{r.name}</b> <small>{r.sub}</small>
					</span>
					<span className="wf-di" role="img" aria-label={r.label}>
						<Icon name={r.icon} />
					</span>
					<span className="wf-hi">{deg(r.high)}</span>
					<span className="wf-lo">{deg(r.low)}</span>
				</div>
			))}
		</div>
	);
}
