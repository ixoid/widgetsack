import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { invoke } from '@tauri-apps/api/core';
import {
	saveServerCheckConfig,
	serverCheckConfigStatus,
	serverCheckConnect,
	serverCheckDisconnect,
	serverCheckReconnect
} from './server-check-commands';
import { emptyTarget } from './serverCheckModel';

beforeEach(() => vi.clearAllMocks());

describe('server-check commands', () => {
	it('maps each adapter to its Rust command name and args', async () => {
		await serverCheckConfigStatus();
		expect(invoke).toHaveBeenLastCalledWith('server_check_config_status');
		const targets = [emptyTarget('a')];
		await saveServerCheckConfig(targets);
		expect(invoke).toHaveBeenLastCalledWith('save_server_check_config', { targets });
		await serverCheckConnect();
		expect(invoke).toHaveBeenLastCalledWith('server_check_connect');
		await serverCheckReconnect();
		expect(invoke).toHaveBeenLastCalledWith('server_check_connect', { restart: true });
		await serverCheckDisconnect();
		expect(invoke).toHaveBeenLastCalledWith('server_check_disconnect');
	});
});
