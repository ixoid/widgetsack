// "Test connection" state for the camera pane: runs `camera_probe` and keeps the rendered line.
import { useState } from 'react';
import { cameraProbe } from './camera-commands';
import { probeLine } from './camera-pane';

export type ProbeLine = { tone: 'ok' | 'err'; text: string } | null;

export function useCameraProbe() {
	const [probe, setProbe] = useState<ProbeLine>(null);
	const [probing, setProbing] = useState(false);
	const clear = () => setProbe(null);
	const test = async () => {
		setProbing(true);
		setProbe(null);
		try {
			setProbe(probeLine(await cameraProbe()));
		} catch (e) {
			setProbe({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
		} finally {
			setProbing(false);
		}
	};
	return { probe, probing, test, clear };
}
