import { beforeEach, describe, expect, it, vi } from 'vitest';

// The adapter is the only place the command-name strings meet their arguments; pin both so a rename
// on either side of the bridge fails here, not in the studio.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));

import { invoke } from '@tauri-apps/api/core';
import {
	hwinfoConfigStatus,
	hwinfoConnect,
	hwinfoDisconnect,
	hwinfoReconnect,
	saveHwinfoConfig
} from './hwinfo-commands';

beforeEach(() => {
	vi.mocked(invoke).mockClear();
});

describe('hwinfo-commands', () => {
	it('maps each adapter to its Rust command name and args', async () => {
		await hwinfoConfigStatus();
		expect(invoke).toHaveBeenLastCalledWith('hwinfo_config_status');

		await saveHwinfoConfig({ pollSeconds: 5, enabled: ['gpu-power'] });
		expect(invoke).toHaveBeenLastCalledWith('save_hwinfo_config', {
			pollSeconds: 5,
			enabled: ['gpu-power']
		});

		await hwinfoConnect();
		expect(invoke).toHaveBeenLastCalledWith('hwinfo_connect');

		await hwinfoReconnect();
		expect(invoke).toHaveBeenLastCalledWith('hwinfo_connect', { restart: true });

		await hwinfoDisconnect();
		expect(invoke).toHaveBeenLastCalledWith('hwinfo_disconnect');
		expect(invoke).toHaveBeenCalledTimes(5);
	});

	it('returns the status the backend resolves', async () => {
		vi.mocked(invoke).mockResolvedValueOnce({ configured: false, readings: [] });
		await expect(hwinfoConfigStatus()).resolves.toEqual({ configured: false, readings: [] });
	});
});
