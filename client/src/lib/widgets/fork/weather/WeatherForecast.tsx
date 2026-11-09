// Forecast meter (fork, W-3): current conditions, an hourly strip and per-day rows in one card.
// Multi-sensor (binds:'none'): the plugin meta's `sensors` map subscribes the weather.* ids and
// WidgetHost passes the props-only `sensors` snapshot. The rules (hour bucketing, labels, day/night)
// live in core/fork/weatherForecast.ts; this file wires them. The current hour comes from the shared
// minute clock, so the strip advances at HH:00 without waiting for a poll. BARE DOM; --np-* tokens.
import type { CSSProperties } from 'react';
import type { SensorState } from '../../../core/telemetry';
import {
	anchorDate,
	conditionLabel,
	dayCount,
	dayRows,
	forecastText,
	glyphFor,
	hourCount,
	isDayFromSun,
	localHourKey,
	normalizeLocale,
	pickHours,
	type RawDay,
	type RawHour
} from '../../../core/fork/weatherForecast';
import Icon from '../../Icon';
import { useNow } from '../../useNow';
import { DayTable, HourStrip, deg } from './WeatherForecastParts';
import './WeatherForecast.css';

type Props = {
	sensors?: Record<string, SensorState>;
	days?: number;
	hours?: number;
	locale?: string;
	showCurrent?: boolean;
	showDetail?: boolean;
	color?: string;
};

const scalar = (s?: SensorState): number | null =>
	s?.value && s.value.kind === 'scalar' ? s.value.value : null;
const textOf = (s?: SensorState): string | null =>
	s?.value && s.value.kind === 'text' ? s.value.value : null;

export default function WeatherForecast({
	sensors = {},
	days = 5,
	hours = 12,
	locale: rawLocale = 'ru',
	showCurrent = true,
	showDetail = true,
	color
}: Props) {
	const now = useNow(60_000);
	const locale = normalizeLocale(rawLocale);
	const text = forecastText(locale);
	const temp = scalar(sensors.temp);
	const code = scalar(sensors.code);
	const status = textOf(sensors.status);

	if (temp == null && code == null) {
		const msg =
			status === 'connecting' ? text.loading : status === 'error' ? text.error : text.noLocation;
		return (
			<div className="wf np-weatherforecast">
				<div className="wf-empty" data-part="empty" role="status">
					{msg}
				</div>
			</div>
		);
	}

	const nowKey = localHourKey(now, -new Date(now).getTimezoneOffset());
	const todayDate = nowKey.slice(0, 10);
	const sun = { rise: textOf(sensors.rise), set: textOf(sensors.set) };
	const nHours = hourCount(hours);
	const raw: RawHour[] = [];
	for (let i = 0; i < nHours; i++) {
		raw.push({
			time: textOf(sensors[`hour${i}time`]),
			temp: scalar(sensors[`hour${i}temp`]),
			code: scalar(sensors[`hour${i}code`]),
			isDay: scalar(sensors[`hour${i}isday`])
		});
	}
	const cells = pickHours(raw, nowKey, nHours, sun, locale);

	const rawDays: RawDay[] = [];
	for (let i = 0; i < dayCount(days); i++) {
		rawDays.push({
			high: scalar(sensors[`day${i}high`]),
			low: scalar(sensors[`day${i}low`]),
			code: scalar(sensors[`day${i}code`])
		});
	}
	const anchor = anchorDate(textOf(sensors.hour0time), todayDate);
	const rows = dayRows(rawDays, anchor, todayDate, locale);

	const isDay = scalar(sensors.is_day);
	const day = isDay != null ? isDay >= 1 : (isDayFromSun(nowKey, sun.rise, sun.set) ?? true);
	const unit = textOf(sensors.unit) || 'C';
	const apparent = scalar(sensors.apparent);
	const humidity = scalar(sensors.humidity);
	const wind = scalar(sensors.wind);
	const vars = color ? ({ '--wf-accent': color } as CSSProperties) : undefined;

	return (
		<div className="wf np-weatherforecast" style={vars}>
			{showCurrent && (
				<div className="wf-now" data-part="now">
					<span className="wf-ico" role="img" aria-label={conditionLabel(code, locale)}>
						<Icon name={glyphFor(code, day)} />
					</span>
					<div>
						<div className="wf-t" data-part="value">
							{temp == null ? '—' : `${Math.round(temp)}°${unit}`}
						</div>
						<div className="wf-c">{conditionLabel(code, locale)}</div>
					</div>
					{showDetail && (apparent != null || humidity != null || wind != null) && (
						<div className="wf-d" data-part="detail">
							{apparent != null && (
								<div>
									{text.feels} <b>{deg(apparent)}</b>
								</div>
							)}
							{humidity != null && (
								<div>
									{text.humidity} <b>{Math.round(humidity)} %</b>
								</div>
							)}
							{wind != null && (
								<div>
									{text.wind} <b>{`${Math.round(wind)} ${unit === 'F' ? text.mph : text.kmh}`}</b>
								</div>
							)}
						</div>
					)}
				</div>
			)}
			{cells.length > 0 && <HourStrip cells={cells} />}
			{rows.length > 0 && <DayTable rows={rows} locale={locale} />}
		</div>
	);
}
