import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('./camera-commands', () => ({
	cameraConfigStatus: vi.fn(),
	saveCameraConfig: vi.fn(),
	cameraProbe: vi.fn()
}));

import CameraSettings from './CameraSettings';
import { cameraConfigStatus, cameraProbe, saveCameraConfig } from './camera-commands';
import { DROPPED_TEXT, MOVED_TEXT } from './camera-pane';
import type { CameraStatus } from './camera-types';

const BASE: CameraStatus = {
	configured: true,
	host: '192.168.1.5',
	port: 8554,
	path: '/ch2',
	hasUsername: true,
	hasPassword: true,
	credentialsSet: true,
	codec: null,
	width: null,
	height: null,
	state: 'idle',
	authLockedUntilMs: null
};
const EMPTY: CameraStatus = {
	...BASE,
	configured: false,
	host: '',
	port: 0,
	path: '',
	hasUsername: false,
	hasPassword: false,
	credentialsSet: false,
	state: 'notConfigured'
};
const SECRET = 'test_pw_x';

const addr = () => screen.getByLabelText(/^Stream address/) as HTMLInputElement;
const login = () => screen.getByLabelText('Login') as HTMLInputElement;
const pass = () => screen.getByLabelText('Password') as HTMLInputElement;
const btn = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

async function mount(status: CameraStatus) {
	vi.mocked(cameraConfigStatus).mockResolvedValue(status);
	const view = render(<CameraSettings />);
	await act(async () => {
		await Promise.resolve();
	});
	return view;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(saveCameraConfig).mockResolvedValue({
		credentialsMoved: false,
		credentialsDropped: false
	});
});

describe('CameraSettings', () => {
	it('shows the bare address back and locks saved credentials as "set"', async () => {
		await mount(BASE);
		expect(addr().value).toBe('rtsp://192.168.1.5:8554/ch2');
		expect(login().disabled).toBe(true);
		expect(login().placeholder).toBe('set');
		expect(pass().disabled).toBe(true);
		expect(pass().type).toBe('password');
		expect(login().type).toBe('password');
		expect(login().autocomplete).toBe('off');
		expect(login().value).toBe('');
		expect(pass().value).toBe('');
		expect(pass().autocomplete).toBe('off');
	});

	it('shows "not set" and editable fields when nothing is stored', async () => {
		await mount(EMPTY);
		expect(login().placeholder).toBe('not set');
		expect(login().disabled).toBe(false);
		expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
		expect(btn('Clear credentials').disabled).toBe(true);
		expect(btn('Test connection').disabled).toBe(true);
	});

	it('a blank save keeps the stored credentials (nothing but the url is sent)', async () => {
		await mount(BASE);
		type(addr(), 'rtsp://192.168.1.5:8554/ch3');
		fireEvent.click(btn('Save'));
		await waitFor(() => expect(saveCameraConfig).toHaveBeenCalled());
		expect(saveCameraConfig).toHaveBeenLastCalledWith({ url: 'rtsp://192.168.1.5:8554/ch3' });
	});

	it('Replace unlocks a field; the typed secret is sent once, then cleared and never re-rendered', async () => {
		const { container } = await mount(BASE);
		fireEvent.click(screen.getAllByRole('button', { name: 'Replace' })[0]);
		expect(login().disabled).toBe(false);
		fireEvent.click(screen.getAllByRole('button', { name: 'Replace' })[1]);
		expect(pass().disabled).toBe(false);
		type(pass(), SECRET);
		expect(btn('Test connection').disabled).toBe(true); // unsaved edits: probe tests the saved config
		fireEvent.click(btn('Save'));
		await waitFor(() => expect(saveCameraConfig).toHaveBeenCalled());
		expect(saveCameraConfig).toHaveBeenLastCalledWith({
			url: 'rtsp://192.168.1.5:8554/ch2',
			password: SECRET
		});
		await waitFor(() => expect(pass().disabled).toBe(true));
		expect(pass().value).toBe('');
		expect(container.innerHTML).not.toContain(SECRET);
		expect(container.querySelector('input[value]')).not.toBeNull();
		expect(Array.from(container.querySelectorAll('input')).some((i) => i.value === SECRET)).toBe(
			false
		);
	});

	it('Clear credentials sends clearCredentials with the current address', async () => {
		await mount(BASE);
		fireEvent.click(btn('Clear credentials'));
		await waitFor(() => expect(saveCameraConfig).toHaveBeenCalled());
		expect(saveCameraConfig).toHaveBeenLastCalledWith({
			url: 'rtsp://192.168.1.5:8554/ch2',
			clearCredentials: true
		});
	});

	it('shows the moved / dropped notices and refreshes the address from the status', async () => {
		await mount(EMPTY);
		vi.mocked(saveCameraConfig).mockResolvedValue({
			credentialsMoved: true,
			credentialsDropped: true
		});
		vi.mocked(cameraConfigStatus).mockResolvedValue(BASE);
		type(addr(), 'rtsp://user:pw@192.168.1.5:8554/ch2');
		fireEvent.click(btn('Save'));
		expect(await screen.findByText(MOVED_TEXT)).toBeTruthy();
		expect(screen.getByText(DROPPED_TEXT)).toBeTruthy();
		await waitFor(() => expect(addr().value).toBe('rtsp://192.168.1.5:8554/ch2'));
		expect(screen.getByText('Saved ✓')).toBeTruthy();
	});

	it('rejects a non-rtsp address and shows a save failure', async () => {
		await mount(BASE);
		type(addr(), 'http://x');
		expect(screen.getByText('Enter an rtsp:// address.')).toBeTruthy();
		expect(btn('Save').disabled).toBe(true);
		type(addr(), 'rtsp://h/x');
		vi.mocked(saveCameraConfig).mockRejectedValue(new Error('stream address must be rtsp://'));
		fireEvent.click(btn('Save'));
		expect(await screen.findByText(/Couldn’t save: stream address must be rtsp:\/\//)).toBeTruthy();
	});

	it('Test connection renders the probe result, an error kind, and a rejected call', async () => {
		await mount(BASE);
		vi.mocked(cameraProbe).mockResolvedValueOnce({
			ok: true,
			kind: null,
			codec: 'H264',
			width: 1920,
			height: 1080,
			fps: 15
		});
		fireEvent.click(btn('Test connection'));
		expect(await screen.findByText('Connected: H264 1920×1080 · 15 fps')).toBeTruthy();

		vi.mocked(cameraProbe).mockResolvedValueOnce({
			ok: false,
			kind: 'authFailed',
			codec: null,
			width: null,
			height: null,
			fps: null
		});
		fireEvent.click(btn('Test connection'));
		expect(await screen.findByText(/RTSP LAN Preview/)).toBeTruthy();

		vi.mocked(cameraProbe).mockRejectedValueOnce(new Error('wait a moment'));
		fireEvent.click(btn('Test connection'));
		expect(await screen.findByText('wait a moment')).toBeTruthy();
		vi.mocked(cameraProbe).mockRejectedValueOnce('plain string');
		fireEvent.click(btn('Test connection'));
		expect(await screen.findByText('plain string')).toBeTruthy();
	});

	it('survives a failing initial status load', async () => {
		vi.mocked(cameraConfigStatus).mockRejectedValue(new Error('x'));
		render(<CameraSettings />);
		await waitFor(() => expect(cameraConfigStatus).toHaveBeenCalled());
		expect(screen.getByText('not configured')).toBeTruthy();
		expect(await screen.findByText(/Couldn’t load the saved camera settings: x/)).toBeTruthy();
	});

	it('stringifies a non-Error load failure', async () => {
		vi.mocked(cameraConfigStatus).mockRejectedValue('boom');
		render(<CameraSettings />);
		expect(await screen.findByText(/saved camera settings: boom/)).toBeTruthy();
	});

	it('shows the login pause while the lockout is active, and not when it has passed', async () => {
		const { unmount } = await mount({ ...BASE, authLockedUntilMs: Date.now() + 60_000 });
		expect(screen.getByText(/Login attempts are paused/)).toBeTruthy();
		unmount();
		await mount({ ...BASE, authLockedUntilMs: Date.now() - 1 });
		expect(screen.queryByText(/Login attempts are paused/)).toBeNull();
	});

	it('renders the diagnostics block', async () => {
		await mount(BASE);
		expect(screen.getByText('Diagnostics')).toBeTruthy();
	});

	it('labels a configured camera without credentials', async () => {
		await mount({ ...BASE, hasUsername: false, hasPassword: false, credentialsSet: false });
		expect(screen.getByText('login not set')).toBeTruthy();
	});
});
