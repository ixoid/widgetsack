import type { Channel } from '@tauri-apps/api/core';
import { render, renderHook, act } from '@testing-library/react';
import { StrictMode, useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CameraDecoder, DecoderDeps, DecoderLike, FrameLike } from './camera-decoder';
import { createCameraDecoder } from './camera-decoder';
import type { SessionDeps } from './camera-session';
import type { CameraStatus } from './camera-types';
import { useCameraStream } from './useCameraStream';

const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)).buffer;
const CONFIG = hex(
	'0100000000000000800738040b617663312e346430303261014d002affe10004674d002a01000268ee'
);
const KEY = hex('020100000000000040420f000000000000000003658884');

const STATUS: CameraStatus = {
	configured: true,
	host: '',
	port: 0,
	path: '',
	hasUsername: false,
	hasPassword: false,
	credentialsSet: false,
	codec: null,
	width: null,
	height: null,
	state: 'connecting',
	authLockedUntilMs: null
};

// Real decoder adapter over a fake VideoDecoder: proves Channel -> protocol -> decode -> draw.
function rig() {
	const channels: { onmessage: (m: unknown) => void }[] = [];
	const decoded: unknown[] = [];
	let output: (f: FrameLike) => void = () => undefined;
	let raf: (() => void) | null = null;
	const drawImage = vi.fn();
	const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) };
	const dd: DecoderDeps = {
		isSupported: async () => true,
		create: (init) => {
			output = init.output;
			const d: DecoderLike = {
				configure: () => undefined,
				decode: (c) => decoded.push(c),
				close: () => undefined
			};
			return d;
		},
		chunk: (i) => i,
		schedule: (cb) => {
			raf = cb;
			return 1;
		},
		cancel: () => undefined,
		now: () => 0
	};
	const deps: SessionDeps = {
		createChannel: () => {
			const c = { onmessage: (_m: unknown) => undefined };
			channels.push(c);
			return c as unknown as Channel<unknown>;
		},
		subscribe: vi.fn(async () => STATUS),
		unsubscribe: vi.fn(async () => undefined),
		createDecoder: (_c, onProblem): CameraDecoder => createCameraDecoder(canvas, onProblem, dd),
		now: () => 0
	};
	return {
		deps,
		channels,
		decoded,
		drawImage,
		canvas,
		emit: (f: FrameLike) => output(f),
		paint: () => raf?.()
	};
}

function Probe({ deps }: { deps: SessionDeps }) {
	const ref = useRef<HTMLCanvasElement>(null);
	const view = useCameraStream(ref, 'k', deps);
	return (
		<>
			<canvas ref={ref} />
			<span data-testid="view">{view}</span>
		</>
	);
}

describe('useCameraStream', () => {
	it('reaches drawing: config + keyframe are decoded and the output is painted', async () => {
		const r = rig();
		const { getByTestId } = render(<Probe deps={r.deps} />);
		await act(async () => {
			await Promise.resolve();
		});
		expect(getByTestId('view').textContent).toBe('connecting');
		await act(async () => {
			r.channels[0].onmessage(CONFIG);
			await Promise.resolve();
			await Promise.resolve();
		});
		act(() => {
			r.channels[0].onmessage(KEY);
			r.channels[0].onmessage({ kind: 'status', state: 'live' });
		});
		expect(r.decoded).toHaveLength(1);
		expect(getByTestId('view').textContent).toBe('live');
		const frame = { close: vi.fn(), displayWidth: 640, displayHeight: 360 };
		r.emit(frame);
		r.paint();
		expect(r.drawImage).toHaveBeenCalledWith(frame, 0, 0);
		expect(frame.close).toHaveBeenCalledTimes(1);
	});

	it('under StrictMode every subscribe is paired with an unsubscribe and the last one stays live', async () => {
		const r = rig();
		const { unmount } = render(
			<StrictMode>
				<Probe deps={r.deps} />
			</StrictMode>
		);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		// the first (cancelled) mount never reached the backend; the second did
		expect(r.deps.subscribe).toHaveBeenCalledTimes(1);
		unmount();
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(r.deps.unsubscribe).toHaveBeenCalledWith('k');
	});

	it('does nothing without a mounted canvas', () => {
		const r = rig();
		const { result } = renderHook(() => useCameraStream({ current: null }, 'k', r.deps));
		expect(result.current).toBe('connecting');
		expect(r.deps.subscribe).not.toHaveBeenCalled();
	});
});
