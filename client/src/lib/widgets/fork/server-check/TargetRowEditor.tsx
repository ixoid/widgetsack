// One editable target row in the Server check settings pane. Presentational (AGENTS.md §6): the row
// owns nothing — the parent holds the list and passes the current target + its validation problem.
import type { CheckKind, ServerCheckTarget } from './server-check-types';
import { KINDS } from './serverCheckModel';

type Props = {
	target: ServerCheckTarget;
	problem: string | null;
	onChange: (next: ServerCheckTarget) => void;
	onRemove: () => void;
};

const KIND_LABEL: Record<CheckKind, string> = {
	icmp: 'Ping (ICMP)',
	tcp: 'TCP port',
	http: 'HTTP'
};

export default function TargetRowEditor({ target, problem, onChange, onRemove }: Props) {
	const set = <K extends keyof ServerCheckTarget>(key: K, value: ServerCheckTarget[K]) =>
		onChange({ ...target, [key]: value });
	// A cleared or non-numeric field keeps the previous/default value instead of becoming 0.
	const num = (raw: string, fallback: number): number => {
		const n = Number(raw);
		return raw.trim() !== '' && Number.isFinite(n) ? n : fallback;
	};

	return (
		<div className="srvc-target" data-id={target.id} data-invalid={problem !== null}>
			<div className="srvc-target-head">
				<label className="has-field srvc-grow">
					Name
					<input
						type="text"
						placeholder="My VPS"
						value={target.name}
						onChange={(e) => set('name', e.currentTarget.value)}
					/>
				</label>
				<label className="has-field">
					Check
					<select
						value={target.kind}
						onChange={(e) => set('kind', e.currentTarget.value as CheckKind)}
					>
						{KINDS.map((k) => (
							<option key={k} value={k}>
								{KIND_LABEL[k]}
							</option>
						))}
					</select>
				</label>
				<button
					type="button"
					className="srvc-remove"
					aria-label={`Remove ${target.name || target.id}`}
					onClick={onRemove}
				>
					×
				</button>
			</div>

			{target.kind === 'http' ? (
				<>
					<label className="has-field">
						URL
						<input
							type="text"
							inputMode="url"
							placeholder="https://example.org/health"
							value={target.url}
							aria-invalid={problem !== null && target.url !== ''}
							onChange={(e) => set('url', e.currentTarget.value)}
						/>
					</label>
					<div className="srvc-target-grid">
						<label className="has-field">
							Expected status
							<input
								type="number"
								min={100}
								max={599}
								placeholder="any 2xx/3xx"
								value={target.expectStatus ?? ''}
								onChange={(e) =>
									set(
										'expectStatus',
										e.currentTarget.value === '' ? null : num(e.currentTarget.value, 200)
									)
								}
							/>
						</label>
						<label className="has-field">
							Body must contain
							<input
								type="text"
								placeholder="optional keyword"
								value={target.expectKeyword}
								onChange={(e) => set('expectKeyword', e.currentTarget.value)}
							/>
						</label>
					</div>
				</>
			) : (
				<div className="srvc-target-grid">
					<label className="has-field srvc-grow">
						Host
						<input
							type="text"
							placeholder="192.168.1.10 or nas.local"
							value={target.host}
							aria-invalid={problem !== null && target.host !== ''}
							onChange={(e) => set('host', e.currentTarget.value)}
						/>
					</label>
					{target.kind === 'tcp' && (
						<label className="has-field">
							Port
							<input
								type="number"
								min={1}
								max={65535}
								value={target.port || ''}
								onChange={(e) => set('port', num(e.currentTarget.value, 0))}
							/>
						</label>
					)}
				</div>
			)}

			<div className="srvc-target-grid">
				<label className="has-field">
					Every (s)
					<input
						type="number"
						min={5}
						max={3600}
						value={target.intervalSecs}
						onChange={(e) => set('intervalSecs', num(e.currentTarget.value, 30))}
					/>
				</label>
				<label className="has-field">
					Timeout (ms)
					<input
						type="number"
						min={200}
						max={30000}
						step={100}
						value={target.timeoutMs}
						onChange={(e) => set('timeoutMs', num(e.currentTarget.value, 3000))}
					/>
				</label>
			</div>
			{problem && <small className="has-field-err">{problem}</small>}
		</div>
	);
}
