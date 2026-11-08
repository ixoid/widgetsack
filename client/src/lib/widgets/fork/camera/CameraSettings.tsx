// The camera plugin's settings pane (studio → Plugins → Camera). A container (AGENTS.md §6): owns
// the form state and drives the Tauri commands via camera-commands.ts. Login and password are
// SECRETS and write-only — the status carries booleans and the bare address only, a blank field
// on save keeps the stored value, and typed values are dropped from React state after every save.
import { useEffect, useState } from 'react';
import { useSettingsOperations } from '../../plugins/useSettingsOperations';
import { cameraConfigStatus, saveCameraConfig } from './camera-commands';
import { addressOf, addressValid, buildInput, saveNotices } from './camera-pane';
import type { CameraStatus } from './camera-types';
import CredentialField from './CredentialField';
import { useCameraProbe } from './useCameraProbe';
import './CameraSettings.css';

export default function CameraSettings() {
	const [status, setStatus] = useState<CameraStatus | null>(null);
	const [address, setAddress] = useState('');
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [replaceUser, setReplaceUser] = useState(false);
	const [replacePass, setReplacePass] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [notices, setNotices] = useState<string[]>([]);
	const { probe, probing, test, clear: clearProbe } = useCameraProbe();
	const { saving, saved, error: saveError, invalidate, capture, save } = useSettingsOperations();

	const apply = (s: CameraStatus) => {
		setStatus(s);
		setAddress(addressOf(s));
		setUsername('');
		setPassword('');
		setReplaceUser(false);
		setReplacePass(false);
		setDirty(false);
	};

	useEffect(() => {
		const current = capture();
		cameraConfigStatus()
			.then((s) => current() && apply(s))
			.catch(() => undefined);
	}, [capture]);

	const edit = (set: (v: string) => void) => (v: string) => {
		set(v);
		setDirty(true);
		clearProbe();
		invalidate();
	};
	const valid = addressValid(address);

	const submit = async (clear: boolean) => {
		/* v8 ignore next -- the Save and Clear controls are disabled for invalid or in-flight submissions. */
		if (!valid || saving) return;
		await save(
			async () => {
				const result = await saveCameraConfig(buildInput(address, username, password, clear));
				return { result, status: await cameraConfigStatus() };
			},
			({ result, status: next }) => {
				apply(next);
				setNotices(saveNotices(result));
				clearProbe();
			}
		);
	};

	const configured = status?.configured ?? false;
	return (
		<div className="has cam-settings">
			{saveError && <div className="has-test err">Couldn’t save: {saveError}</div>}
			<div className="has-statusline">
				<span className="has-state-dim">
					{configured
						? status?.credentialsSet
							? 'configured'
							: 'login not set'
						: 'not configured'}
				</span>
			</div>

			<div className="rp-hd">Camera stream</div>
			<div className="has-help">
				RTSP address of the camera, for example <code>rtsp://192.168.1.50:8554/ch2</code>. Enter the
				login and password in their own fields; they are stored encrypted and never shown again.
			</div>
			<label className="has-field">
				Stream address
				<input
					type="text"
					inputMode="url"
					autoComplete="off"
					spellCheck={false}
					placeholder="rtsp://<ip>:8554/ch2"
					value={address}
					aria-invalid={address !== '' && !valid}
					onChange={(e) => edit(setAddress)(e.currentTarget.value)}
				/>
				{address !== '' && !valid && (
					<small className="has-field-err">Enter an rtsp:// address.</small>
				)}
			</label>
			<CredentialField
				label="Login"
				kind="text"
				isSet={status?.hasUsername ?? false}
				replacing={replaceUser}
				value={username}
				onChange={edit(setUsername)}
				onReplace={() => setReplaceUser(true)}
			/>
			<CredentialField
				label="Password"
				kind="password"
				isSet={status?.hasPassword ?? false}
				replacing={replacePass}
				value={password}
				onChange={edit(setPassword)}
				onReplace={() => setReplacePass(true)}
			/>

			<div className="has-actions">
				<button
					type="button"
					className="has-primary"
					onClick={() => submit(false)}
					disabled={!valid || saving}
					aria-busy={saving}
				>
					{saving ? 'Saving…' : 'Save'}
				</button>
				<button type="button" onClick={test} disabled={!configured || dirty || probing}>
					{probing ? 'Testing…' : 'Test connection'}
				</button>
				<button
					type="button"
					onClick={() => submit(true)}
					disabled={!valid || saving || !status?.credentialsSet}
				>
					Clear credentials
				</button>
				{saved && <span className="has-ok">Saved ✓</span>}
			</div>
			{notices.map((n) => (
				<div key={n} className="has-help cam-notice">
					{n}
				</div>
			))}
			{probe && (
				<div className={`has-test ${probe.tone}`} role="status">
					{probe.text}
				</div>
			)}
			<div className="has-help">
				Changing the address or port clears the saved login and password. Add a{' '}
				<strong>Camera</strong> widget from the widget list once it is available.
			</div>
		</div>
	);
}
