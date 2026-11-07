// Backend worker lifetime belongs to the app. Window cleanup releases only local subscriptions.
// The HWiNFO data source (peer to stocks-source / weather-source). A Rust proxy source: the reads
// happen server-side (widgetsack/src/fork/hwinfo/, plugins/hwinfo.json) and samples arrive over the
// EXISTING `telemetry` event as `hw.*` — ingested by the unchanged hub. This source only ensures the
// poller is running and provides the catalog (well-known ids + enabled readings) for the inspector.

import type { SensorSource } from '../../../core/plugin';
import { catalogEntries } from './hwinfoCatalog';
import { hwinfoConfigStatus, hwinfoConnect } from './hwinfo-commands';
import type { HwinfoStatus } from './hwinfo-types';

let status: HwinfoStatus | null = null;

/** Re-read the status (drives the catalog). Silent on failure (keeps the prior status). */
export async function refreshHwinfoCatalog(): Promise<HwinfoStatus | null> {
	try {
		status = await hwinfoConfigStatus();
	} catch {
		// unavailable: keep the prior status
	}
	return status;
}

export const hwinfoSource: SensorSource = {
	id: 'hwinfo',
	start: async () => {
		await refreshHwinfoCatalog();
		await hwinfoConnect().catch(() => undefined);
		return () => undefined;
	},
	catalog: () => catalogEntries(status).map((e) => e.id),
	catalogEntries: () => catalogEntries(status)
};
