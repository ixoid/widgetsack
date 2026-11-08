// TS mirrors of the notifyfeed Rust structs that cross the bridge
// (widgetsack/src/fork/notifyfeed/{ring,config}.rs). The list payload is camelCase inside
// SensorValue::Json; the config SAVE goes out snake_case (camelCase aliases are accepted
// server-side) and the status comes back camelCase. Nothing here is secret — the ring never
// leaves the machine and the config holds no credentials.

/** One toast notification — an item of the `notify.list` JSON sensor, newest first. */
export type NotifyItem = {
	key: string;
	app: string;
	title: string;
	body: string;
	tsMs: number;
	seen: boolean;
};

/** The full `notify.list` payload: `{ version: 1, items: [...] }`, a full replace per emit. */
export type NotifyListPayload = {
	version: number;
	items: NotifyItem[];
};

/** The `notify.status` text sensor — kinds only, never content. */
export type NotifyStatusKind = 'granted' | 'denied' | 'unavailable' | 'off';

/** How depth ages the feed (the `plugins/notify.json` `depth_mode` word). */
export type NotifyDepthMode = 'count' | 'hours';

/** `notify_config_status` — camelCase, the normalized saved config (defaults when absent). */
export type NotifyConfigStatus = {
	configured: boolean;
	pollSeconds: number;
	depthMode: NotifyDepthMode;
	depthCount: number;
	depthHours: number;
	exclusions: string[];
};

/** The `save_notify_config` argument — snake_case keys, matching the file on disk. */
export type NotifyConfigInput = {
	poll_secs: number;
	depth_mode: NotifyDepthMode;
	depth_count: number;
	depth_hours: number;
	exclusions: string[];
};
