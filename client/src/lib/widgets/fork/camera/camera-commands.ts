// The camera Tauri command adapter (outer ring) — every `invoke` behind a typed function so the
// settings pane, the stream hook and tests share the command-name strings.

import { invoke, type Channel } from '@tauri-apps/api/core';
import { COMMANDS } from '../../../bridge/contract';
import type { CameraConfigInput, CameraStatus, ProbeResult, SaveResult } from './camera-types';

/** The saved address (bare) and credential flags — never the login or password. */
export const cameraConfigStatus = (): Promise<CameraStatus> =>
	invoke<CameraStatus>(COMMANDS.cameraConfigStatus);

/** Persist the camera config (studio only; the backend validates and splits `user:pass@`). */
export const saveCameraConfig = (cfg: CameraConfigInput): Promise<SaveResult> =>
	invoke<SaveResult>(COMMANDS.saveCameraConfig, { ...cfg });

/** DESCRIBE the SAVED config (studio only; throttled and lockout-aware server-side). */
export const cameraProbe = (): Promise<ProbeResult> => invoke<ProbeResult>(COMMANDS.cameraProbe);

/** Start receiving frames on `channel` under `key` (one key per mounted widget). */
export const cameraSubscribe = (channel: Channel<unknown>, key: string): Promise<CameraStatus> =>
	invoke<CameraStatus>(COMMANDS.cameraSubscribe, { channel, key });

export const cameraUnsubscribe = (key: string): Promise<void> =>
	invoke(COMMANDS.cameraUnsubscribe, { key });

/** Flow-control acknowledgement: the last frame `seq` the decoder consumed. */
export const cameraAck = (key: string, seq: number): Promise<void> =>
	invoke(COMMANDS.cameraAck, { key, seq });
