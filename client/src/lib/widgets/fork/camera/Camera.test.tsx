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
import { VIEW_TEXT } from './camera-view';

beforeEach(() => {
	view = 'connecting';
});

describe('Camera widget', () => {
	it.each([
		'connecting',
		'noSignal',
		'authFailed',
		'unsupportedCodec',
		'notConfigured',
		'notFound',
		'protocolError'
	] as const)('renders the %s text', (v) => {
		view = v;
		render(<Camera />);
		expect(screen.getByRole('status').textContent).toBe(VIEW_TEXT[v]);
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
