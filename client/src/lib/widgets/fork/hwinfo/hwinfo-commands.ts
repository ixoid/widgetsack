// The HWiNFO Tauri command adapter (outer ring) — every `invoke` behind a typed function, so the
// source + settings panel share the command-name strings and tests can mock this module.

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../../bridge/contract';
import type { HwinfoStatus } from './hwinfo-types';

export type HwinfoConfigInput = {
	pollSeconds: number;
	/** Catalog slugs (`hw.<slug>`) to emit besides the well-known hw.cpu.* ids. */
	enabled: string[];
};

/** The config plus a live probe of HWiNFO (which interface answers, the catalog). */
export const hwinfoConfigStatus = (): Promise<HwinfoStatus> =>
	invoke<HwinfoStatus>(COMMANDS.hwinfoConfigStatus);

/** Persist `plugins/hwinfo.json` (studio only). */
export const saveHwinfoConfig = (cfg: HwinfoConfigInput): Promise<void> =>
	invoke(COMMANDS.saveHwinfoConfig, { ...cfg });

/** Start the poll task (idempotent). */
export const hwinfoConnect = (): Promise<void> => invoke(COMMANDS.hwinfoConnect);

/** Stop the poll task (if any). */
export const hwinfoDisconnect = (): Promise<void> => invoke(COMMANDS.hwinfoDisconnect);

/** Atomically replace the app-owned worker with the saved configuration (studio only). */
export const hwinfoReconnect = (): Promise<void> =>
	invoke(COMMANDS.hwinfoConnect, { restart: true });
