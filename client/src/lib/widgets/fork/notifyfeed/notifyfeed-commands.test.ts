import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { invoke } from '@tauri-apps/api/core';
import {
	notifyConfigStatus,
	notifyConnect,
	notifyDisconnect,
	notifyMarkAllSeen,
	notifyReconnect,
	saveNotifyConfig
} from './notifyfeed-commands';
import type { NotifyConfigInput } from './notifyfeed-types';

const CONFIG: NotifyConfigInput = {
	poll_secs: 3,
	depth_mode: 'count',
	depth_count: 50,
	depth_hours: 24,
	exclusions: ['Telegram']
};

beforeEach(() => vi.clearAllMocks());

describe('notifyfeed commands', () => {
	it('maps each adapter to its Rust command name and args', async () => {
		await notifyConfigStatus();
		expect(invoke).toHaveBeenLastCalledWith('notify_config_status');
		await saveNotifyConfig(CONFIG);
		// The save arg is nested ({ config: … }) and snake_case, matching the Rust command.
		expect(invoke).toHaveBeenLastCalledWith('save_notify_config', { config: CONFIG });
		await notifyConnect();
		expect(invoke).toHaveBeenLastCalledWith('notify_connect');
		await notifyReconnect();
		expect(invoke).toHaveBeenLastCalledWith('notify_connect', { restart: true });
		await notifyDisconnect();
		expect(invoke).toHaveBeenLastCalledWith('notify_disconnect');
		await notifyMarkAllSeen();
		expect(invoke).toHaveBeenLastCalledWith('notify_mark_all_seen');
	});
});
