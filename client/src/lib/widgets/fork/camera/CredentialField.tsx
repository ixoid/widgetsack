// One write-only credential input (login or password) for the camera pane. The stored value is
// never known to the webview: when one is saved the input is locked and says "set" until the
// owner presses Replace; a blank value on save means "keep the stored one".

type Props = {
	label: string;
	kind: 'text' | 'password';
	isSet: boolean;
	replacing: boolean;
	value: string;
	onChange: (value: string) => void;
	onReplace: () => void;
};

export default function CredentialField({
	label,
	kind,
	isSet,
	replacing,
	value,
	onChange,
	onReplace
}: Props) {
	const locked = isSet && !replacing;
	return (
		<div className="has-field cam-cred">
			<label>
				{label}
				<input
					type={kind}
					autoComplete="off"
					spellCheck={false}
					disabled={locked}
					placeholder={locked ? 'set' : 'not set'}
					value={value}
					onChange={(e) => onChange(e.currentTarget.value)}
				/>
			</label>
			{isSet && (
				<button type="button" onClick={onReplace} disabled={replacing}>
					Replace
				</button>
			)}
		</div>
	);
}
