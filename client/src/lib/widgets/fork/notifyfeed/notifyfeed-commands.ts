// The notifyfeed Tauri command adapter (outer ring) — every `invoke` behind a typed function so
// the host + settings pane share the command-name strings and tests can mock this module.

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../../bridge/contract';
import type { NotifyConfigInput, NotifyConfigStatus } from './notifyfeed-types';

/** The saved config (non-secret; defaults when the file is absent). */
export const notifyConfigStatus = (): Promise<NotifyConfigStatus> =>
	invoke<NotifyConfigStatus>(COMMANDS.notifyConfigStatus);

/** Persist `plugins/notify.json` (studio only; snake_case keys, `{ config: … }` nested arg). */
export const saveNotifyConfig = (config: NotifyConfigInput): Promise<void> =>
	invoke(COMMANDS.saveNotifyConfig, { config });

/** Start the poll worker if not already running (idempotent; demand-gated server-side). */
export const notifyConnect = (): Promise<void> => invoke(COMMANDS.notifyConnect);

/** Replace the running worker with the saved configuration (studio only; the ring survives). */
export const notifyReconnect = (): Promise<void> =>
	invoke(COMMANDS.notifyConnect, { restart: true });

/** Stop the worker for every window (the ring is kept). */
export const notifyDisconnect = (): Promise<void> => invoke(COMMANDS.notifyDisconnect);

/** Mark every ring item seen and re-emit at once (studio passes; overlays are layout-gated). */
export const notifyMarkAllSeen = (): Promise<void> => invoke(COMMANDS.notifyMarkAllSeen);
