import { describe, expect, it } from 'vitest';
import type { ProbeResult } from './camera-types';
import {
	addressOf,
	addressValid,
	buildInput,
	diagnosticRows,
	DROPPED_TEXT,
	lockoutText,
	MOVED_TEXT,
	probeLine,
	saveNotices
} from './camera-pane';
import type { CameraErrorKind, CameraStatus } from './camera-types';

const STATUS: CameraStatus = {
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

const probe = (over: Partial<ProbeResult>): ProbeResult => ({
	ok: false,
	kind: null,
	codec: null,
	width: null,
	height: null,
	fps: null,
	...over
});

describe('camera pane helpers', () => {
	it('builds notices from the save flags', () => {
		expect(saveNotices({ credentialsMoved: false, credentialsDropped: false })).toEqual([]);
		expect(saveNotices({ credentialsMoved: true, credentialsDropped: false })).toEqual([
			MOVED_TEXT
		]);
		expect(saveNotices({ credentialsMoved: true, credentialsDropped: true })).toEqual([
			MOVED_TEXT,
			DROPPED_TEXT
		]);
	});

	it('renders a probe success, with and without details', () => {
		expect(
			probeLine(probe({ ok: true, codec: 'H264', width: 1920, height: 1080, fps: 14.6 }))
		).toEqual({
			tone: 'ok',
			text: 'Connected: H264 1920×1080 · 15 fps'
		});
		expect(probeLine(probe({ ok: true })).text).toBe('Connected: video');
	});

	it('maps every probe error kind to text, auth names the Aqara toggle', () => {
		const kinds: CameraErrorKind[] = [
			'unreachable',
			'authFailed',
			'timeout',
			'notFound',
			'protocol',
			'unsupportedCodec',
			'streamLost'
		];
		const texts = kinds.map((kind) => probeLine(probe({ kind })).text);
		expect(new Set(texts).size).toBe(kinds.length);
		expect(texts[1]).toContain('RTSP LAN Preview');
		expect(probeLine(probe({}))).toEqual({ tone: 'err', text: 'The camera test failed.' });
	});

	it('shows the bare address back and validates the scheme', () => {
		expect(addressOf(STATUS)).toBe('rtsp://192.168.1.5:8554/ch2');
		expect(addressOf({ ...STATUS, host: '' })).toBe('');
		expect(addressValid(' rtsp://h/ch2 ')).toBe(true);
		expect(addressValid('http://h')).toBe(false);
		expect(addressValid('rtsp://')).toBe(false);
	});

	it('omits blank login/password and sets clearCredentials only when asked', () => {
		expect(buildInput(' rtsp://h/x ', '', '')).toEqual({ url: 'rtsp://h/x' });
		expect(buildInput('rtsp://h/x', 'u', 'p')).toEqual({
			url: 'rtsp://h/x',
			username: 'u',
			password: 'p'
		});
		expect(buildInput('rtsp://h/x', '', '', true)).toEqual({
			url: 'rtsp://h/x',
			clearCredentials: true
		});
	});
});

describe('lockoutText', () => {
	it('is null without an active lockout', () => {
		expect(lockoutText(null, 1000)).toBeNull();
		expect(lockoutText(1000, 1000)).toBeNull();
		expect(lockoutText(500, 1000)).toBeNull();
	});

	it('names the remaining seconds, rounded up', () => {
		expect(lockoutText(1000 + 42_001, 1000)).toContain('about 43 s');
	});
});

describe('diagnosticRows', () => {
	it('shows dashes for unknowns and rounded numbers otherwise', () => {
		const empty = diagnosticRows({
			codec: null,
			width: null,
			height: null,
			gopSeconds: null,
			ttfkMs: null,
			kbps: null,
			frames: 0,
			dropped: 0
		});
		expect(empty.map(([, v]) => v)).toEqual(['—', '—', '—', '—', '—', '0', '0']);
		const full = diagnosticRows({
			codec: 'avc1.4d002a',
			width: 1920,
			height: 1080,
			gopSeconds: 2.04,
			ttfkMs: 412.6,
			kbps: 1499.6,
			frames: 120,
			dropped: 3
		});
		expect(Object.fromEntries(full)).toEqual({
			Codec: 'avc1.4d002a',
			Size: '1920×1080',
			GOP: '2.0 s',
			'First keyframe': '413 ms',
			Bitrate: '1500 kbit/s',
			Frames: '120',
			Dropped: '3'
		});
	});
});
