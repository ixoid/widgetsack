// The Forecast plugin (fork, W-3): one extra widget type over the stock Weather plugin's data. It has
// no source and no settings — the location stays in Plugins → Weather and the weather.* sensors (and
// their demand gate) are shared — so this registration is just the meta + component. Called via
// plugins/index.ts. File name differs from the component's on purpose (case-insensitive FS).

import { registerPlugin } from '../../plugin';
import { asMeter } from '../../registry';
import { forecastSensors } from '../../../core/fork/weatherForecast';
import WeatherForecast from './WeatherForecast';

export const registerWeatherForecastPlugin = (): void =>
	registerPlugin({
		id: 'weatherforecast',
		name: 'Forecast',
		description:
			'Current conditions, an hourly strip and day-by-day rows. Uses the location configured under Weather.',
		statusSensor: 'weather.status',
		widgets: [
			{
				meta: {
					// Self-sourcing (binds:'none') on the Weather plugin's weather.* sensors, which
					// demand-gate the backend poll for both widgets.
					type: 'weatherforecast',
					binds: 'none',
					sensors: forecastSensors,
					label: 'Forecast',
					description:
						'Current weather, a strip of the next hours and the coming days with high / low, in Russian or English.',
					defaultSize: { w: 312, h: 280 },
					defaultConfig: { days: 5, hours: 12, locale: 'ru', showCurrent: true, showDetail: true },
					configFields: [
						{
							key: 'days',
							label: 'days',
							kind: 'number',
							min: 1,
							max: 7,
							step: 1,
							group: 'Data',
							help: 'how many day rows to show (1–7)'
						},
						{
							key: 'hours',
							label: 'hours',
							kind: 'number',
							min: 0,
							max: 24,
							step: 1,
							group: 'Data',
							help: 'how many hours in the strip (0 = hide it; more than 12 wrap to a second row)'
						},
						{
							key: 'locale',
							label: 'language',
							kind: 'select',
							options: ['ru', 'en'],
							group: 'Appearance',
							help: 'language of the condition, weekday and month labels'
						},
						{
							key: 'showCurrent',
							label: 'current block',
							kind: 'toggle',
							group: 'Appearance',
							help: 'show the big current temperature with its condition'
						},
						{
							key: 'showDetail',
							label: 'feels-like / humidity / wind',
							kind: 'toggle',
							group: 'Appearance',
							help: 'show the feels-like, humidity and wind column beside the temperature'
						},
						{
							key: 'color',
							label: 'accent',
							kind: 'color',
							group: 'Appearance',
							help: 'current-hour and today colour (blank = theme accent)'
						}
					]
				},
				component: asMeter(WeatherForecast)
			}
		]
	});
