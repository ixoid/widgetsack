// Camera widget (binds:'none', self-sourcing): a canvas the decoder draws into, and a text overlay
// for every non-live state. Black + «connecting» while waiting for the keyframe, never a stale
// frame: Camera.css hides the canvas unless data-view is 'live', and the session clears it when
// leaving live. The stream key is derived from the widget instance; one camera config serves them all.
import { useId, useRef } from 'react';
import { stateText } from './camera-model';
import { useCameraStream } from './useCameraStream';
import './Camera.css';

type Props = {
	fit?: 'contain' | 'cover';
	caption?: string;
	showState?: boolean;
};

/** Stream keys are 1-64 of [A-Za-z0-9_-]; useId yields ':r1:'. */
const keyOf = (id: string) => `cam-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

export default function Camera({ fit = 'contain', caption = '', showState = true }: Props) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const key = keyOf(useId());
	const view = useCameraStream(canvasRef, key);
	const text = stateText(view);
	return (
		<div className="cam" data-view={view}>
			<canvas ref={canvasRef} className={`cam-canvas cam-fit-${fit}`} />
			{showState && text && (
				<div className="cam-state" role="status">
					{text}
				</div>
			)}
			{caption && <div className="cam-caption">{caption}</div>}
		</div>
	);
}
