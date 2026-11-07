// The Agenda+ plugin (fork, K-1): one extra widget type over the stock Agenda plugin's data. It has
// no source and no settings of its own — the feed URL stays in Plugins → Agenda and the `agenda.list`
// sensor is shared — so this registration is just the meta + component. Called via plugins/index.ts.

import { registerPlugin } from '../../plugin';
import { asMeter } from '../../registry';
import AgendaPlus from './AgendaPlus';

export const registerAgendaPlusPlugin = (): void =>
	registerPlugin({
		id: 'agendaplus',
		name: 'Agenda+',
		description:
			'The Agenda feed regrouped into Today / Tomorrow / This week with a countdown to the next event. Uses the calendar configured under Agenda.',
		statusSensor: 'agenda.status',
		widgets: [
			{
				meta: {
					// Self-sourcing (binds:'none') on the Agenda plugin's agenda.list JSON sensor, which
					// demand-gates the backend poll for both widgets.
					type: 'agendaplus',
					binds: 'none',
					interactive: true,
					label: 'Agenda+',
					description:
						'Upcoming events grouped into Today, Tomorrow and This week, with a countdown to the next one.',
					defaultSize: { w: 300, h: 320 },
					defaultConfig: { title: '', maxRows: 8, showCountdown: true, showLater: false },
					configFields: [
						{
							key: 'title',
							label: 'header',
							kind: 'text',
							group: 'Data',
							help: 'optional title above the groups'
						},
						{
							key: 'maxRows',
							label: 'events',
							kind: 'number',
							min: 1,
							max: 30,
							step: 1,
							group: 'Data',
							help: 'how many events to show across all groups (soonest first)'
						},
						{
							key: 'showCountdown',
							label: 'countdown',
							kind: 'toggle',
							group: 'Data',
							help: 'show a "Next … in 25 min" strip above the groups'
						},
						{
							key: 'showLater',
							label: 'later',
							kind: 'toggle',
							group: 'Data',
							help: 'also list events a week or more away under "Later"'
						},
						{
							key: 'color',
							label: 'accent',
							kind: 'color',
							group: 'Appearance',
							help: 'time / countdown / today colour (blank = theme accent)'
						}
					]
				},
				component: asMeter(AgendaPlus)
			}
		]
	});
