import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { invoke, type Channel } from '@tauri-apps/api/core';
import {
	cameraAck,
	cameraConfigStatus,
	cameraProbe,
	cameraSubscribe,
	cameraUnsubscribe,
	saveCameraConfig
} from './camera-commands';

beforeEach(() => vi.clearAllMocks());

describe('camera commands', () => {
	it('maps each adapter to its Rust command name and args', async () => {
		await cameraConfigStatus();
		expect(invoke).toHaveBeenLastCalledWith('camera_config_status');
		await saveCameraConfig({ url: 'rtsp://h/ch2', password: 'x', clearCredentials: false });
		expect(invoke).toHaveBeenLastCalledWith('save_camera_config', {
			url: 'rtsp://h/ch2',
			password: 'x',
			clearCredentials: false
		});
		await cameraProbe();
		expect(invoke).toHaveBeenLastCalledWith('camera_probe');
		const channel = {} as Channel<unknown>;
		await cameraSubscribe(channel, 'w1');
		expect(invoke).toHaveBeenLastCalledWith('camera_subscribe', { channel, key: 'w1' });
		await cameraUnsubscribe('w1');
		expect(invoke).toHaveBeenLastCalledWith('camera_unsubscribe', { key: 'w1' });
		await cameraAck('w1', 8);
		expect(invoke).toHaveBeenLastCalledWith('camera_ack', { key: 'w1', seq: 8 });
	});
});
