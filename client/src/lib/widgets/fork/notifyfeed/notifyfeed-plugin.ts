// The Notifications plugin (fork N-1): recent Windows toast notifications. NO source — the
// backend worker (widgetsack/src/fork/notifyfeed/) is demand-gated by the notify.* sensor ids
// the meta `sensors` map subscribes, and its lifetime belongs to the app. Also NO `statusSensor`:
// statusDotFrom doesn't know 'granted' and would label it "Not connected" in the Plugins list
// (the Camera plugin omits it for the same reason); the pane shows the true badge.

import { registerPlugin } from '../../plugin';
import { asMeter } from '../../registry';
import NotifyFeedHost from './NotifyFeedHost';
import NotifyFeedSettings from './NotifyFeedSettings';

export const registerNotifyFeedPlugin = (): void =>
	registerPlugin({
		id: 'notifyfeed',
		name: 'Notifications',
		description:
			'Recent Windows toast notifications (app, title, body, time), newest first and grouped by app. Unread rows stay highlighted until you mark all seen.',
		settings: NotifyFeedSettings,
		widgets: [
			{
				meta: {
					// Multi-sensor (binds:'none'): the static map makes WidgetHost subscribe to the
					// notify.* ids (which IS the demand gate) and pass the Host a `sensors` snapshot.
					type: 'notifyfeed',
					binds: 'none',
					interactive: true,
					label: 'Notifications',
					description:
						'Windows toast notifications that arrived while you were away or in a game — app, title, body and time, newest first, grouped by app.',
					defaultSize: { w: 320, h: 320 },
					defaultConfig: { title: '', maxRows: 20, showBody: true },
					sensors: () => ({ list: 'notify.list', count: 'notify.count', status: 'notify.status' }),
					configFields: [
						{
							key: 'title',
							label: 'header',
							kind: 'text',
							group: 'Data',
							help: 'optional title above the feed'
						},
						{
							key: 'maxRows',
							label: 'rows',
							kind: 'number',
							min: 1,
							max: 100,
							step: 1,
							group: 'Data',
							help: 'how many notifications to list (newest first; older ones still age out by the plugin depth)'
						},
						{
							key: 'showBody',
							label: 'body text',
							kind: 'toggle',
							group: 'Appearance',
							help: 'show the message body under each title'
						},
						{
							key: 'color',
							label: 'accent',
							kind: 'color',
							group: 'Appearance',
							help: 'unread edge / time colour (blank = theme accent)'
						}
					]
				},
				component: asMeter(NotifyFeedHost)
			}
		]
	});
