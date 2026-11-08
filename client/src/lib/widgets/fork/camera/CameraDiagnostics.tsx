// Spike readout in the Camera settings pane: what the running stream looks like (codec, size,
// GOP, time to first keyframe, bitrate, frame counts). Empty until a Camera widget is streaming.
import { useSyncExternalStore } from 'react';
import { getDiagnostics, subscribeDiagnostics } from './camera-diagnostics';
import { diagnosticRows } from './camera-pane';

export default function CameraDiagnostics() {
	const snap = useSyncExternalStore(subscribeDiagnostics, getDiagnostics);
	return (
		<div className="cam-diag">
			<div className="rp-hd">Diagnostics</div>
			{snap ? (
				<dl className="cam-diag-list">
					{diagnosticRows(snap).map(([label, value]) => (
						<div key={label} className="cam-diag-row">
							<dt>{label}</dt>
							<dd>{value}</dd>
						</div>
					))}
				</dl>
			) : (
				<div className="has-help">No stream running. Add a Camera widget to see live numbers.</div>
			)}
		</div>
	);
}
