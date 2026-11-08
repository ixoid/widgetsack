import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraView } from './camera-model';

let view: CameraView = 'connecting';
const seen: { key?: string; ref?: unknown } = {};
vi.mock('./useCameraStream', () => ({
	useCameraStream: (ref: unknown, key: string) => {
		seen.ref = ref;
		seen.key = key;
		return view;
	}
}));

import Camera from './Camera';

beforeEach(() => {
	view = 'connecting';
});

// Literal copy for every state (not VIEW_TEXT itself), so a wrong string fails here.
const EXPECTED: Record<CameraView, string> = {
	connecting: 'Connecting',
	live: '',
	noSignal: 'No signal, retrying',
	authFailed:
		'Wrong login or password. If you toggled RTSP LAN Preview in the Aqara Home app, the credentials were regenerated. Enter the new ones in Plugins → Camera.',
	unsupportedCodec:
		'Unsupported codec: the camera must send H.264. Change the stream in Plugins → Camera.',
	notFound: 'Stream not found. Check the address in Plugins → Camera.',
	protocolError: 'Protocol error. Check the stream path in Plugins → Camera.',
	notConfigured: 'Camera not set up. Open Plugins → Camera in Studio.',
	credentialsMissing: 'Login or password not set. Enter them in Plugins → Camera.',
	decoderUnavailable: 'Video decoder unavailable',
	decodeError: 'Decode error',
	refused: 'Save the layout in Studio'
};

describe('Camera widget', () => {
	it.each(Object.keys(EXPECTED).filter((v) => v !== 'live') as CameraView[])(
		'renders the literal %s text',
		(v) => {
			view = v;
			render(<Camera />);
			expect(screen.getByRole('status').textContent).toBe(EXPECTED[v]);
		}
	);

	it('marks the stage with the view: live only while live, so the canvas shows only then', () => {
		view = 'noSignal';
		const { container, rerender } = render(<Camera />);
		const stage = container.querySelector('.cam');
		expect(stage?.getAttribute('data-view')).toBe('noSignal');
		view = 'live';
		rerender(<Camera />);
		expect(stage?.getAttribute('data-view')).toBe('live');
		view = 'connecting';
		rerender(<Camera />);
		expect(stage?.getAttribute('data-view')).toBe('connecting');
	});

	it('ships the CSS rule that hides the canvas whenever the view is not live', () => {
		// vitest runs from client/; CSS imports are stubbed to '' so read the file itself
		const css = readFileSync('src/lib/widgets/fork/camera/Camera.css', 'utf8');
		expect(css).toMatch(
			/\.cam:not\(\[data-view='live'\]\) \.cam-canvas\s*\{\s*visibility:\s*hidden;/
		);
	});

	it('keeps the stage plain black while waiting: no dimming filter, no stale-frame class', () => {
		const css = readFileSync('src/lib/widgets/fork/camera/Camera.css', 'utf8');
		expect(css).not.toMatch(/filter\s*:/);
		expect(css).not.toMatch(/opacity\s*:/);
		view = 'noSignal';
		const { container } = render(<Camera />);
		expect(container.querySelector('.cam')?.className).toBe('cam');
	});

	it('shows no text when live, and hides the text when showState is off', () => {
		view = 'live';
		const { unmount } = render(<Camera />);
		expect(screen.queryByRole('status')).toBeNull();
		unmount();
		view = 'noSignal';
		render(<Camera showState={false} />);
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('applies fit and caption, and passes a valid stream key', () => {
		const { container } = render(<Camera fit="cover" caption="Front door" />);
		expect(container.querySelector('canvas')?.className).toContain('cam-fit-cover');
		expect(screen.getByText('Front door')).toBeTruthy();
		expect(seen.key).toMatch(/^cam-[A-Za-z0-9_-]{1,60}$/);
	});

	it('defaults to contain without a caption', () => {
		const { container } = render(<Camera />);
		expect(container.querySelector('canvas')?.className).toContain('cam-fit-contain');
		expect(container.querySelector('.cam-caption')).toBeNull();
	});
});
