// React glue for one camera stream: runs the session for the mounted canvas and reports the view.
import { useEffect, useState, type RefObject } from 'react';
import { defaultSessionDeps, runCameraStream, type SessionDeps } from './camera-session';
import type { CameraView } from './camera-model';

export type CameraState = { view: CameraView; codec?: string };

const CONNECTING: CameraState = { view: 'connecting' };

export function useCameraStream(
	canvasRef: RefObject<HTMLCanvasElement | null>,
	key: string,
	deps: SessionDeps = defaultSessionDeps
): CameraState {
	const [state, setState] = useState<CameraState>(CONNECTING);
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		setState(CONNECTING);
		return runCameraStream(key, canvas, (view, codec) => setState({ view, codec }), deps);
	}, [canvasRef, key, deps]);
	return state;
}
