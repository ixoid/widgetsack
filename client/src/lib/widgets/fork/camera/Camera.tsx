// Camera widget (binds:'none', self-sourcing): a canvas the decoder draws into, and a text overlay
// for every non-live state (black + «connecting» while waiting for the keyframe, never a stale
// frame). The stream key is derived from the widget instance; one camera config serves them all.
import { useId, useRef } from 'react';
import { VIEW_TEXT } from './camera-view';
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
	const text = VIEW_TEXT[view];
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
