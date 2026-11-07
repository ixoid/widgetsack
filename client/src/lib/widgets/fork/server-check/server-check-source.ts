// Backend worker lifetime belongs to the app. Window cleanup releases only local subscriptions.
// The server-check data source (peer to rss-source / stocks-source). A Rust proxy source: the probes
// run server-side (widgetsack/src/fork/server_check.rs) and results arrive over the EXISTING
// `telemetry` event as `srv.*` samples. This source only ensures polling is running and provides the
// bindable-id catalog (one set per saved target) for the inspector dropdown.

import type { SensorCatalogEntry, SensorSource } from '../../../core/plugin';
import { serverCheckConfigStatus, serverCheckConnect } from './server-check-commands';
import { targetSensorIds } from './serverCheckModel';

let targetIds: string[] = [];

function entries(): SensorCatalogEntry[] {
	const out: SensorCatalogEntry[] = [
		{ id: 'srv.status', label: 'Server check status' },
		{ id: 'srv.list', label: 'Server check list' }
	];
	for (const id of targetIds) out.push(...targetSensorIds(id));
	return out;
}

/** Re-read the saved target ids (drives the catalog). Silent on failure (not configured). */
export async function refreshServerCheckCatalog(): Promise<string[]> {
	try {
		targetIds = (await serverCheckConfigStatus()).targets.map((t) => t.id);
	} catch {
		// not configured / unavailable: keep the prior list
	}
	return targetIds;
}

export const serverCheckSource: SensorSource = {
	id: 'server-check',
	start: async () => {
		await refreshServerCheckCatalog();
		await serverCheckConnect().catch(() => undefined);
		return () => undefined;
	},
	catalog: () => entries().map((e) => e.id),
	catalogEntries: entries
};
