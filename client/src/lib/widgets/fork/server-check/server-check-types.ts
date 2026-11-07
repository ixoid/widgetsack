// TS mirrors of the server-check Rust structs that cross the bridge
// (widgetsack/src/fork/server_check.rs). camelCase: the Rust side is `#[serde(rename_all =
// "camelCase")]`. Nothing here is secret — the backend rejects URLs with embedded credentials.

export type CheckKind = 'icmp' | 'tcp' | 'http';

/** One configured target — both the config-file row and the `save_server_check_config` arg. */
export type ServerCheckTarget = {
	id: string;
	name: string;
	kind: CheckKind;
	/** icmp / tcp: bare host name or IPv4 literal. */
	host: string;
	/** tcp only (0 otherwise). */
	port: number;
	/** http only. */
	url: string;
	/** http: the exact status that counts as up; null = any 2xx/3xx. */
	expectStatus: number | null;
	/** http: a substring the body must contain (empty = don't read the body). */
	expectKeyword: string;
	intervalSecs: number;
	timeoutMs: number;
};

/** `server_check_config_status`. */
export type ServerCheckStatus = {
	configured: boolean;
	targets: ServerCheckTarget[];
};

/** One row of the `srv.list` JSON sensor (mirrors `list_sample` in server_check.rs). `up` is null
 * until the first probe; `history` holds the last latencies, null where the probe failed. */
export type ServerCheckRow = {
	id: string;
	name: string;
	kind: CheckKind;
	up: boolean | null;
	ms: number | null;
	reason: string;
	downSince: number | null;
	history: (number | null)[];
};
