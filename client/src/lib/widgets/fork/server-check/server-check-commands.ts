// The server-check Tauri command adapter (outer ring) — every `invoke` behind a typed function so
// the source + settings pane share the command-name strings and tests can mock this module.

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../../bridge/contract';
import type { ServerCheckStatus, ServerCheckTarget } from './server-check-types';

/** The saved targets (non-secret). */
export const serverCheckConfigStatus = (): Promise<ServerCheckStatus> =>
	invoke<ServerCheckStatus>(COMMANDS.serverCheckConfigStatus);

/** Persist `plugins/server-check.json` (studio only; the backend validates every row). */
export const saveServerCheckConfig = (targets: ServerCheckTarget[]): Promise<void> =>
	invoke(COMMANDS.saveServerCheckConfig, { targets });

/** Start the poll task (idempotent; demand-gated server-side). */
export const serverCheckConnect = (): Promise<void> => invoke(COMMANDS.serverCheckConnect);

/** Stop the poll task (if any). */
export const serverCheckDisconnect = (): Promise<void> => invoke(COMMANDS.serverCheckDisconnect);

/** Replace the running worker with the saved configuration (studio only). */
export const serverCheckReconnect = (): Promise<void> =>
	invoke(COMMANDS.serverCheckConnect, { restart: true });
