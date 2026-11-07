// Pure helpers for the server-check widget and its settings pane. No React / Tauri / DOM — unit-tested
// in serverCheckModel.test.ts. The meter and the pane stay thin containers over these.

import type { CheckKind, ServerCheckRow, ServerCheckTarget } from './server-check-types';

export const KINDS: CheckKind[] = ['icmp', 'tcp', 'http'];

const isKind = (v: unknown): v is CheckKind =>
	typeof v === 'string' && KINDS.includes(v as CheckKind);

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

/** Defensively shape the `srv.list` JSON sensor into typed rows (malformed entries dropped). */
export function parseServerList(value: unknown): ServerCheckRow[] {
	if (!Array.isArray(value)) return [];
	const out: ServerCheckRow[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		if (typeof r.id !== 'string' || !r.id) continue;
		out.push({
			id: r.id,
			name: typeof r.name === 'string' && r.name ? r.name : r.id,
			kind: isKind(r.kind) ? r.kind : 'tcp',
			up: typeof r.up === 'boolean' ? r.up : null,
			ms: numOrNull(r.ms),
			reason: typeof r.reason === 'string' ? r.reason : '',
			downSince: numOrNull(r.downSince),
			history: Array.isArray(r.history) ? r.history.map(numOrNull) : []
		});
	}
	return out;
}

export type RowLevel = 'up' | 'slow' | 'down' | 'unknown';

/** Status-dot level: `unknown` before the first probe, `down`, `slow` at/above `slowMs`, else `up`. */
export function rowLevel(row: Pick<ServerCheckRow, 'up' | 'ms'>, slowMs = 150): RowLevel {
	if (row.up === null) return 'unknown';
	if (!row.up) return 'down';
	if (row.ms !== null && row.ms >= slowMs) return 'slow';
	return 'up';
}

/** "12 ms" / "—". Sub-millisecond latencies (a LAN TCP connect) show as "<1 ms", not "0 ms". */
export function formatLatency(ms: number | null): string {
	if (ms === null) return '—';
	if (ms < 1) return '<1 ms';
	return `${Math.round(ms)} ms`;
}

/** How long a target has been down, coarse: "down <1 min" … "down 3 d". Empty when not down. */
export function formatDownSince(downSince: number | null, nowMs: number): string {
	if (downSince === null) return '';
	const secs = Math.max(0, Math.floor((nowMs - downSince) / 1000));
	if (secs < 60) return 'down <1 min';
	if (secs < 3600) return `down ${Math.floor(secs / 60)} min`;
	if (secs < 86_400) return `down ${Math.floor(secs / 3600)} h`;
	return `down ${Math.floor(secs / 86_400)} d`;
}

/** The sparkline series: a failed probe draws as 0 so outages read as dips, not gaps. */
export function sparkHistory(history: (number | null)[]): number[] {
	return history.map((v) => v ?? 0);
}

/** A stable id from a display name (a-z0-9-, ≤24 chars), made unique against `existing`. The id is
 * part of every sensor id (`srv.<id>.ms`), so it never changes once a target is saved. */
export function newTargetId(name: string, existing: string[]): string {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 24)
			.replace(/-+$/g, '') || 'target';
	if (!existing.includes(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}-${n}`;
		if (!existing.includes(candidate)) return candidate;
	}
}

/** A fresh target row with the backend's defaults. */
export function emptyTarget(id: string): ServerCheckTarget {
	return {
		id,
		name: '',
		kind: 'icmp',
		host: '',
		port: 0,
		url: '',
		expectStatus: null,
		expectKeyword: '',
		intervalSecs: 30,
		timeoutMs: 3000
	};
}

const HOST_OK = /^[^\s/@:?#\\]+$/;

/** Client-side mirror of the backend's `validate_target`, for inline feedback. Null = looks fine. */
export function targetProblem(t: ServerCheckTarget): string | null {
	if (t.kind === 'http') {
		if (!/^https?:\/\/\S+$/i.test(t.url.trim())) return 'Enter a full http(s):// URL';
		if (/^https?:\/\/[^/]*@/i.test(t.url.trim())) return 'Remove the credentials from the URL';
		if (t.expectStatus !== null && (t.expectStatus < 100 || t.expectStatus > 599))
			return 'Expected status must be 100–599';
	} else {
		if (!HOST_OK.test(t.host.trim()))
			return 'Enter a bare host name or IP (no scheme, path or port)';
		if (t.kind === 'tcp' && (t.port < 1 || t.port > 65535)) return 'Port must be 1–65535';
	}
	if (t.intervalSecs < 5) return 'Interval must be at least 5 s';
	if (t.timeoutMs < 200) return 'Timeout must be at least 200 ms';
	return null;
}

/** Catalog ids a saved target exposes for Text / Gauge / Sparkline binding. */
export function targetSensorIds(id: string): { id: string; label: string; unit?: string }[] {
	return [
		{ id: `srv.${id}.up`, label: `${id} up` },
		{ id: `srv.${id}.ms`, label: `${id} latency`, unit: 'ms' },
		{ id: `srv.${id}.status`, label: `${id} status` },
		{ id: `srv.${id}.lastDown`, label: `${id} down since` }
	];
}
