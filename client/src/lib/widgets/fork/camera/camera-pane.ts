// Pure copy + form helpers for the camera settings pane (no React, no Tauri).

import type {
	CameraConfigInput,
	CameraErrorKind,
	CameraStatus,
	ProbeResult,
	SaveResult
} from './camera-types';

export const MOVED_TEXT = 'Credentials moved to secure storage.';
export const DROPPED_TEXT = 'Address changed — login and password cleared, enter them again.';

const AUTH_TEXT =
	'Wrong login or password. If «RTSP LAN Preview» was toggled in the Aqara Home app, the camera regenerated its credentials — enter the new ones. Retries pause for a minute so the camera account is not locked.';

const ERROR_TEXT: Record<CameraErrorKind, string> = {
	unreachable: 'Camera not reachable — check the address and that this PC is on the same network.',
	authFailed: AUTH_TEXT,
	timeout: 'The camera did not answer in time.',
	notFound: 'The stream path was not found — check the part after the port (for example /ch2).',
	protocol: 'The camera answered something unexpected.',
	unsupportedCodec: 'The camera stream is not H.264, which is the only supported codec.',
	streamLost: 'The stream was interrupted.'
};

/** One notice per SaveResult flag, in display order. */
export function saveNotices(r: SaveResult): string[] {
	const out: string[] = [];
	if (r.credentialsMoved) out.push(MOVED_TEXT);
	if (r.credentialsDropped) out.push(DROPPED_TEXT);
	return out;
}

/** The Test-connection line. A failure without a kind still gets a fixed text. */
export function probeLine(r: ProbeResult): { tone: 'ok' | 'err'; text: string } {
	if (r.ok) {
		const size = r.width && r.height ? ` ${r.width}×${r.height}` : '';
		const fps = r.fps ? ` · ${Math.round(r.fps)} fps` : '';
		return { tone: 'ok', text: `Connected: ${r.codec ?? 'video'}${size}${fps}` };
	}
	return { tone: 'err', text: r.kind ? ERROR_TEXT[r.kind] : 'The camera test failed.' };
}

/** The bare address the status describes (no userinfo by construction); '' when unset. */
export function addressOf(s: CameraStatus): string {
	return s.host ? `rtsp://${s.host}:${s.port}${s.path}` : '';
}

export const addressValid = (url: string): boolean => /^rtsp:\/\/\S+$/i.test(url.trim());

/** Build the save argument; blank login/password are omitted (= keep the stored value). */
export function buildInput(
	url: string,
	username: string,
	password: string,
	clearCredentials = false
): CameraConfigInput {
	const input: CameraConfigInput = { url: url.trim() };
	if (username !== '') input.username = username;
	if (password !== '') input.password = password;
	if (clearCredentials) input.clearCredentials = true;
	return input;
}
