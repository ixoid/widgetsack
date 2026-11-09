// Pure rules for the Forecast widget (fork, W-3): hour bucketing, day rows, day/night glyph pick and
// Russian/English labels. No React, no DOM, no clock and no machine locale — every input is explicit
// so tests are deterministic. The meter (WeatherForecast.tsx) only wires sensors into these helpers.
import { weatherInfo } from '../weather';

export type ForecastLocale = 'ru' | 'en';

/** Anything but 'en' is Russian (the owner's default), so a corrupt config value never breaks labels. */
export const normalizeLocale = (v: unknown): ForecastLocale => (v === 'en' ? 'en' : 'ru');

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number =>
	typeof v === 'number' && Number.isFinite(v)
		? Math.max(lo, Math.min(hi, Math.floor(v)))
		: fallback;

/** Shared by the sensors map and the meter, so a cleared Studio field (null/NaN) subscribes and
 * renders the same number of cells: the defaults, not zero. */
export const hourCount = (v: unknown): number => clampInt(v, 0, 24, 12);
export const dayCount = (v: unknown): number => clampInt(v, 1, 7, 5);

/** The `sensors` map the plugin meta hands to WidgetHost. `rise`/`set` are always subscribed: the
 * client cannot tell which provider is active, and on met.no those ids simply never arrive. */
export function forecastSensors(config: Record<string, unknown>): Record<string, string> {
	const map: Record<string, string> = {
		status: 'weather.status',
		temp: 'weather.temp',
		apparent: 'weather.apparent',
		humidity: 'weather.humidity',
		wind: 'weather.wind',
		code: 'weather.code',
		is_day: 'weather.is_day',
		unit: 'weather.unit',
		rise: 'weather.sun.rise',
		set: 'weather.sun.set',
		// Always on: the day rows are anchored to the date of hour 0, even when the strip is hidden.
		hour0time: 'weather.hour.0.time'
	};
	const days = dayCount(config?.days);
	for (let i = 0; i < days; i++) {
		map[`day${i}high`] = `weather.day.${i}.high`;
		map[`day${i}low`] = `weather.day.${i}.low`;
		map[`day${i}code`] = `weather.day.${i}.code`;
	}
	const hours = hourCount(config?.hours);
	for (let i = 0; i < hours; i++) {
		map[`hour${i}time`] = `weather.hour.${i}.time`;
		map[`hour${i}temp`] = `weather.hour.${i}.temp`;
		map[`hour${i}code`] = `weather.hour.${i}.code`;
		map[`hour${i}isday`] = `weather.hour.${i}.is_day`;
	}
	return map;
}

/** Location-local `YYYY-MM-DDTHH:00` for an epoch and an explicit UTC offset in minutes. */
export function localHourKey(nowMs: number, utcOffsetMin: number): string {
	return `${new Date(nowMs + utcOffsetMin * 60_000).toISOString().slice(0, 13)}:00`;
}

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const CLOCK_RE = /(\d{2}):(\d{2})$/;

const minutesOf = (s: string | null): number | null => {
	const m = s == null ? null : CLOCK_RE.exec(s);
	return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Day/night from today's sunrise/sunset, by time of day only (they are today's values). null when
 * any input is missing or malformed. */
export function isDayFromSun(
	time: string,
	rise: string | null,
	set: string | null
): boolean | null {
	const t = minutesOf(time);
	const r = minutesOf(rise);
	const s = minutesOf(set);
	if (t == null || r == null || s == null) return null;
	return t >= r && t < s;
}

const RU_LABELS: Record<string, string> = {
	Clear: 'Ясно',
	'Mainly clear': 'Преимущественно ясно',
	'Partly cloudy': 'Переменная облачность',
	Overcast: 'Пасмурно',
	Fog: 'Туман',
	Drizzle: 'Морось',
	'Freezing drizzle': 'Ледяная морось',
	Rain: 'Дождь',
	'Freezing rain': 'Ледяной дождь',
	Snow: 'Снег',
	'Snow grains': 'Снежные зёрна',
	'Rain showers': 'Ливень',
	'Snow showers': 'Снегопад',
	Thunderstorm: 'Гроза',
	'Thunderstorm + hail': 'Гроза с градом'
};

export function conditionLabel(code: number | null, locale: ForecastLocale): string {
	if (code == null) return '—';
	const en = weatherInfo(code).label;
	return locale === 'en' ? en : (RU_LABELS[en] ?? en);
}

const TEXT = {
	ru: {
		feels: 'ощущается',
		humidity: 'влажность',
		wind: 'ветер',
		kmh: 'км/ч',
		mph: 'миль/ч',
		day: 'день',
		high: 'макс',
		low: 'мин',
		loading: 'Загрузка погоды…',
		error: 'Погода недоступна — проверьте подключение',
		noLocation: 'Укажите место в Plugins → Weather'
	},
	en: {
		feels: 'feels like',
		humidity: 'humidity',
		wind: 'wind',
		kmh: 'km/h',
		mph: 'mph',
		day: 'day',
		high: 'max',
		low: 'min',
		loading: 'Loading weather…',
		error: 'Weather unavailable — check your connection',
		noLocation: 'Set your location in Plugins → Weather'
	}
};

export function forecastText(locale: ForecastLocale): (typeof TEXT)['ru'] {
	return TEXT[locale];
}

export type RawHour = {
	time: string | null;
	temp: number | null;
	code: number | null;
	isDay: number | null;
};
export type HourCell = {
	key: string;
	hour: string;
	temp: number | null;
	icon: string;
	label: string;
	now: boolean;
};

/** Glyph for a code at day or night. Owner's rule (2026-11-09): a partly cloudy night also shows the
 * moon (the stock mapping shows a cloud there); overcast, fog, rain, snow and storms keep their own
 * glyph day and night. */
export const glyphFor = (code: number | null, day: boolean): string =>
	code == null ? 'help' : !day && code === 2 ? 'moon' : weatherInfo(code, day).icon;

/** Hour cells from the raw `weather.hour.N.*` readings. Neither the hub nor the sample cache ever
 * retracts an id, so after a poll that returns fewer hours the old tail would linger: only the
 * leading run of valid, strictly increasing times is trusted, and past hours are dropped. */
export function pickHours(
	raw: RawHour[],
	nowKey: string,
	max: number,
	sun: { rise: string | null; set: string | null },
	locale: ForecastLocale
): HourCell[] {
	const run: (RawHour & { time: string })[] = [];
	for (const h of raw) {
		if (h.time == null || !TIME_RE.test(h.time)) break;
		if (run.length > 0 && h.time <= run[run.length - 1].time) break;
		run.push({ ...h, time: h.time });
	}
	const nowHour = nowKey.slice(0, 13);
	return run
		.filter((h) => h.time.slice(0, 13) >= nowHour)
		.slice(0, Math.max(0, max))
		.map((h) => {
			const day =
				h.isDay != null ? h.isDay >= 1 : (isDayFromSun(h.time, sun.rise, sun.set) ?? true);
			const icon = glyphFor(h.code, day);
			return {
				key: h.time,
				hour: h.time.slice(11, 13),
				temp: h.temp,
				icon,
				label: conditionLabel(h.code, locale),
				now: h.time.slice(0, 13) === nowHour
			};
		});
}

const utcNoon = (date: string, plusDays = 0): Date => {
	const [y, m, d] = date.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + plusDays, 12));
};

/** `YYYY-MM-DD` of the row-i date: anchor + i days (UTC arithmetic at noon, so no DST drift). */
const addDays = (date: string, n: number): string => utcNoon(date, n).toISOString().slice(0, 10);

/** The date the day rows start from: hour 0's date if it is valid, else today. */
export const anchorDate = (hour0time: string | null, todayDate: string): string =>
	hour0time != null && TIME_RE.test(hour0time) ? hour0time.slice(0, 10) : todayDate;

/** Short weekday, day and 3-letter month, via the explicit locale and UTC (the date is a calendar
 * date, not an instant). Month is cut to 3 letters so ICU variants (`нояб.` / `ноя`) agree. */
function dateParts(date: string, locale: ForecastLocale): { weekday: string; sub: string } {
	const d = utcNoon(date);
	const get = (opts: Intl.DateTimeFormatOptions, type: string): string =>
		new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' })
			.formatToParts(d)
			.find((p) => p.type === type)!.value;
	const wd = get({ weekday: 'short' }, 'weekday');
	const month = get({ day: 'numeric', month: 'short' }, 'month').replace('.', '').slice(0, 3);
	return {
		weekday: wd.charAt(0).toUpperCase() + wd.slice(1),
		sub: `${d.getUTCDate()} ${month}`
	};
}

export function dayLabel(
	date: string,
	todayDate: string,
	locale: ForecastLocale
): { name: string; sub: string } {
	const { weekday, sub } = dateParts(date, locale);
	if (date === todayDate) {
		return { name: locale === 'en' ? 'Today' : 'Сегодня', sub: `${weekday} ${sub}` };
	}
	return { name: weekday, sub };
}

export type RawDay = { high: number | null; low: number | null; code: number | null };
export type DayRow = {
	date: string;
	name: string;
	sub: string;
	today: boolean;
	high: number | null;
	low: number | null;
	icon: string;
	label: string;
};

export function dayRows(
	raw: RawDay[],
	anchor: string,
	todayDate: string,
	locale: ForecastLocale
): DayRow[] {
	const rows: DayRow[] = [];
	raw.forEach((r, i) => {
		const date = addDays(anchor, i);
		if (date < todayDate || (r.high == null && r.low == null && r.code == null)) return;
		rows.push({
			date,
			...dayLabel(date, todayDate, locale),
			today: date === todayDate,
			high: r.high,
			low: r.low,
			// A daily summary has no night variant, like the stock meter.
			icon: r.code == null ? 'help' : weatherInfo(r.code, true).icon,
			label: conditionLabel(r.code, locale)
		});
	});
	return rows;
}
