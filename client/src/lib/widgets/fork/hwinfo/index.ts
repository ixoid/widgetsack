// The Hardware (HWiNFO) plugin (fork, roadmap H-1): a server-side HWiNFO reader
// (widgetsack/src/fork/hwinfo/) exposed as `hw.*` sensors, plus a settings pane to pick readings.
// Adds no widget type — the well-known ids bind to the built-in Gauge / Text / Sparkline meters.
// Registered from one line in plugins/index.ts.

import { registerPlugin } from '../../plugin';
import { HW_STATUS_ID } from './hwinfoCatalog';
import { hwinfoSource } from './hwinfo-source';
import HwinfoSettings from './HwinfoSettings';

export const registerHwinfoPlugin = (): void =>
	registerPlugin({
		id: 'hwinfo',
		name: 'Hardware (HWiNFO)',
		description:
			'CPU temperature, effective clocks and package power from a running HWiNFO64, plus any HWiNFO reading you tick — as hw.* sensors for Gauge / Text widgets.',
		sources: [hwinfoSource],
		settings: HwinfoSettings,
		statusSensor: HW_STATUS_ID
	});
