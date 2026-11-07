// TypeScript mirror of the HWiNFO Rust structs that cross the bridge
// (widgetsack/src/fork/hwinfo/mod.rs: HwinfoStatus, Backend; model.rs: CatalogEntry). One place so
// the field casing stays in lock-step with serde (camelCase; Backend is kebab-case). Nothing here is
// secret — HWiNFO exposes hardware readings only.

/** Which HWiNFO interface answered the last probe. */
export type HwinfoBackend = 'shared-memory' | 'registry' | 'none';

/** One HWiNFO reading with its stable `hw.<slug>` id (model.rs CatalogEntry). */
export type HwinfoReading = {
	slug: string;
	id: string;
	label: string;
	sensor: string;
	unit: string;
	value: number;
};

/** The config plus a live probe, from `hwinfo_config_status`. */
export type HwinfoStatus = {
	configured: boolean;
	pollSeconds: number;
	enabled: string[];
	running: boolean;
	backend: HwinfoBackend;
	gadgetEnabled: boolean | null;
	detail: string;
	readings: HwinfoReading[];
};
