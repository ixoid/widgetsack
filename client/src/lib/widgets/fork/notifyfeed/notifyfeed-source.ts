// Backend worker lifetime belongs to the app. Window cleanup releases only local subscriptions.
// The notifyfeed data source (the agenda-source pattern): the WinRT poll worker runs server-side
// (widgetsack/src/fork/notifyfeed/) and its samples arrive over the EXISTING `telemetry` event;
// the backend primes late-mounting windows from its sample cache. This source exists so the
// worker is RUNNING from app init in BOTH window roles — demand gating cannot spawn a task, so
// without it a saved overlay widget would wait for the Plugins pane to open. `notify_connect` is
// idempotent (integration_task.rs: a live worker makes the call a no-op). It only provides the
// bindable-id catalog (the meta `sensors` map is config-independent but static).

import type { SensorCatalogEntry, SensorSource } from '../../../core/plugin';
import { notifyConnect } from './notifyfeed-commands';

const ENTRIES: SensorCatalogEntry[] = [
	{ id: 'notify.list', label: 'Notifications list' },
	{ id: 'notify.count', label: 'Notifications total' },
	{ id: 'notify.status', label: 'Notifications status' }
];

export const notifyFeedSource: SensorSource = {
	id: 'notifyfeed',
	start: async () => {
		await notifyConnect().catch(() => undefined);
		return () => undefined;
	},
	catalog: () => ENTRIES.map((e) => e.id),
	catalogEntries: () => ENTRIES
};
