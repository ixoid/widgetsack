import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraView } from './camera-view';

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
	connecting: 'connecting',
	live: '',
	noSignal: 'no signal',
	authFailed: 'auth failed — see Plugins → Camera',
	unsupportedCodec: 'unsupported codec',
	notFound: 'stream not found — check the address in Plugins → Camera',
	protocolError: 'protocol error — check the stream path',
	notConfigured: 'not configured',
	decodeError: 'decode error',
	unavailable: 'camera unavailable'
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
