import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraView } from './camera-model';

let view: CameraView = 'connecting';
let codec: string | undefined;
const seen: { key?: string; ref?: unknown } = {};
vi.mock('./useCameraStream', () => ({
	useCameraStream: (ref: unknown, key: string) => {
		seen.ref = ref;
		seen.key = key;
		return { view, codec };
	}
}));

import Camera from './Camera';

beforeEach(() => {
	view = 'connecting';
	codec = undefined;
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
	refused: 'Save the layout in Studio',
	unavailable: 'Camera unavailable — check Plugins → Camera'
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

	// The one test that reads Camera.css: happy-dom applies no stylesheet (CSS imports are stubbed),
	// so a rule can only be proven from the file. Everything else here is behaviour.
	it('ships the CSS rules: hidden canvas unless live, no dimming, a fixed stage text colour', () => {
		const css = readFileSync('src/lib/widgets/fork/camera/Camera.css', 'utf8');
		expect(css).toMatch(
			/\.cam:not\(\[data-view='live'\]\) \.cam-canvas\s*\{\s*visibility:\s*hidden;/
		);
		expect(css).not.toMatch(/filter\s*:/);
		expect(css).not.toMatch(/opacity\s*:/);
		expect(css).toMatch(/\.cam\s*\{[^}]*--cam-stage-fg:\s*rgba\(255, 255, 255, 0\.7\);/);
		expect(css).toMatch(/\.cam-state\s*\{[^}]*color:\s*var\(--cam-stage-fg\);/);
		expect(css).not.toMatch(/\.cam-state\s*\{[^}]*--np-muted/);
	});

	it('a waiting view leaves no stale-frame class on the stage', () => {
		view = 'noSignal';
		const { container } = render(<Camera />);
		expect(container.querySelector('.cam')?.className).toBe('cam');
	});

	it('names the codec in the unsupported-codec text when the hook knows it', () => {
		view = 'unsupportedCodec';
		codec = 'H265';
		render(<Camera />);
		expect(screen.getByRole('status').textContent).toBe(
			'Unsupported codec (H265): the camera must send H.264. Change the stream in Plugins → Camera.'
		);
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
