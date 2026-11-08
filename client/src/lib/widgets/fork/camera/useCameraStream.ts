// React glue for one camera stream: runs the session for the mounted canvas and reports the view.
import { useEffect, useState, type RefObject } from 'react';
import { defaultSessionDeps, runCameraStream, type SessionDeps } from './camera-session';
import type { CameraView } from './camera-model';

export function useCameraStream(
	canvasRef: RefObject<HTMLCanvasElement | null>,
	key: string,
	deps: SessionDeps = defaultSessionDeps
): CameraView {
	const [view, setView] = useState<CameraView>('connecting');
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		setView('connecting');
		return runCameraStream(key, canvas, setView, deps);
	}, [canvasRef, key, deps]);
	return view;
}
