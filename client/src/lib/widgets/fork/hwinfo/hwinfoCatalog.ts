// Pure helpers for the HWiNFO plugin: the bindable-id catalog the Inspector dropdown shows, the
// reading filter/toggle logic of the settings pane, and the status wording. No React/Tauri (AGENTS.md
// §5) so the pane stays a thin container and all of this is unit-tested directly — the same split
// as plugins/stocks-symbols.ts. The id strings mirror widgetsack/src/fork/hwinfo/model.rs.

import type { SensorCatalogEntry } from '../../../core/plugin';
import type { HwinfoBackend, HwinfoReading, HwinfoStatus } from './hwinfo-types';

export const HW_STATUS_ID = 'hw.status';
export const HW_CPU_TEMP_ID = 'hw.cpu.temp';
export const HW_CPU_CLOCK_MAX_ID = 'hw.cpu.clock.max';
export const HW_CPU_POWER_ID = 'hw.cpu.power';
/** `hw.cpu.clock.core.<n>` — one per core; the count is only known once readings arrive. */
export const HW_CPU_CLOCK_CORE_PREFIX = 'hw.cpu.clock.core.';

/** The ids every install gets without configuration (derived from HWiNFO's CPU labels). */
export const WELL_KNOWN_ENTRIES: SensorCatalogEntry[] = [
	{ id: HW_STATUS_ID, label: 'HWiNFO status' },
	{ id: HW_CPU_TEMP_ID, label: 'CPU temperature (Tctl/Tdie)', unit: '°C' },
	{ id: HW_CPU_CLOCK_MAX_ID, label: 'CPU clock (fastest core)', unit: 'MHz' },
	{ id: HW_CPU_POWER_ID, label: 'CPU package power', unit: 'W' }
];

/** The Inspector catalog: the well-known ids plus every ENABLED reading of the last status. A
 * reading that is not enabled is not emitted, so listing it would bind to a sensor that never
 * updates. */
export function catalogEntries(status: HwinfoStatus | null): SensorCatalogEntry[] {
	const out = WELL_KNOWN_ENTRIES.slice();
	if (!status) return out;
	const enabled = new Set(status.enabled);
	for (const r of status.readings) {
		if (!enabled.has(r.slug)) continue;
		out.push({ id: r.id, label: r.label, unit: r.unit || undefined });
	}
	return out;
}

/** Readings whose label, sensor line or id contains `query` (case-insensitive, trimmed). An empty
 * query keeps everything. Order is preserved (HWiNFO's own). */
export function filterReadings(readings: HwinfoReading[], query: string): HwinfoReading[] {
	const q = query.trim().toLowerCase();
	if (!q) return readings;
	return readings.filter(
		(r) =>
			r.label.toLowerCase().includes(q) ||
			r.sensor.toLowerCase().includes(q) ||
			r.id.toLowerCase().includes(q)
	);
}

/** Add `slug` to the enabled list if absent, else remove it. Returns a new array. */
export function toggleSlug(enabled: string[], slug: string): string[] {
	return enabled.includes(slug) ? enabled.filter((s) => s !== slug) : [...enabled, slug];
}

/** A compact `value unit` for the picker row: integers as-is, otherwise one decimal. */
export function formatReading(value: number, unit: string): string {
	const num = Number.isInteger(value) ? String(value) : value.toFixed(1);
	return unit ? `${num} ${unit}` : num;
}

/** Human name of the interface that answered. */
export function backendLabel(backend: HwinfoBackend): string {
	switch (backend) {
		case 'shared-memory':
			return 'Shared memory';
		case 'registry':
			return 'Gadget registry';
		default:
			return 'Not available';
	}
}

/** Clamp the poll period to the backend's accepted range (model.rs MIN/MAX_POLL_SECS). */
export function clampPollSeconds(raw: number): number {
	if (!Number.isFinite(raw)) return 2;
	return Math.min(60, Math.max(1, Math.round(raw)));
}
