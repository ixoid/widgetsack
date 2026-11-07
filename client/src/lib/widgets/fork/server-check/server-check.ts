// The Server check plugin (fork stage 1): a server-side prober (widgetsack/src/fork/server_check.rs),
// a settings pane (the target list), and a self-sourcing `servercheck` card widget. Calling
// `registerServerCheckPlugin()` (via plugins/index.ts) registers the source + pane + widget type.

import { registerPlugin } from '../../plugin';
import { asMeter } from '../../registry';
import { serverCheckSource } from './server-check-source';
import ServerCheckSettings from './ServerCheckSettings';
import ServerCheck from './ServerCheck';

export const registerServerCheckPlugin = (): void =>
	registerPlugin({
		id: 'server-check',
		name: 'Server check',
		description:
			'Is my VPS / NAS / router up? Ping, TCP-port and HTTP probes on their own intervals, with latency and down-since per target. Add targets in this panel, then drop a Server check widget.',
		sources: [serverCheckSource],
		settings: ServerCheckSettings,
		statusSensor: 'srv.status',
		widgets: [
			{
				meta: {
					// Self-sourcing (binds:'none'): reads the srv.list JSON sensor from the hub, which
					// both demand-gates the backend probes and carries the rows (like the RSS widget).
					type: 'servercheck',
					binds: 'none',
					label: 'Server check',
					description:
						'One row per watched host: status dot, name, latency sparkline and how long it has been down.',
					defaultSize: { w: 320, h: 160 },
					defaultConfig: { title: 'Servers', maxRows: 8, showSparkline: true, slowMs: 150 },
					configFields: [
						{
							key: 'title',
							label: 'header',
							kind: 'text',
							group: 'Data',
							help: 'optional title above the rows'
						},
						{
							key: 'maxRows',
							label: 'rows',
							kind: 'number',
							min: 1,
							max: 32,
							step: 1,
							group: 'Data',
							help: 'how many targets to show (in the order they are configured)'
						},
						{
							key: 'slowMs',
							label: 'slow above (ms)',
							kind: 'number',
							min: 1,
							max: 10000,
							step: 10,
							group: 'Data',
							help: 'latency at or above this turns the dot amber'
						},
						{
							key: 'showSparkline',
							label: 'sparkline',
							kind: 'toggle',
							group: 'Appearance',
							help: 'draw the last 20 probes next to each name'
						},
						{
							key: 'color',
							label: 'accent',
							kind: 'color',
							group: 'Appearance',
							help: 'up-dot / latency colour (blank = theme accent)'
						}
					]
				},
				component: asMeter(ServerCheck)
			}
		]
	});
