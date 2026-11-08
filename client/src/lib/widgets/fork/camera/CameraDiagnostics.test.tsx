import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import CameraDiagnostics from './CameraDiagnostics';
import { publishDiagnostics } from './camera-diagnostics';

afterEach(() => act(() => publishDiagnostics(null)));

describe('CameraDiagnostics', () => {
	it('shows a hint without a stream, then the live numbers', () => {
		render(<CameraDiagnostics />);
		expect(screen.getByText(/No stream running/)).toBeTruthy();
		act(() =>
			publishDiagnostics({
				codec: 'avc1.4d002a',
				width: 1920,
				height: 1080,
				gopSeconds: 2,
				ttfkMs: 400,
				kbps: 1500,
				frames: 10,
				dropped: 1
			})
		);
		expect(screen.getByText('1920×1080')).toBeTruthy();
		expect(screen.getByText('1500 kbit/s')).toBeTruthy();
		expect(screen.getByText('GOP')).toBeTruthy();
	});
});
