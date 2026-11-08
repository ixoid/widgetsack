import { describe, expect, it } from 'vitest';
import { VIEW_TEXT, viewFromStatus, viewFromWire } from './camera-view';
import type { CameraWireState } from './camera-types';

describe('camera view', () => {
	it('folds every wire state into a view and every view has copy', () => {
		const wire: CameraWireState[] = [
			'notConfigured',
			'idle',
			'connecting',
			'live',
			'retrying',
			'authFailed',
			'unsupportedCodec'
		];
		expect(wire.map(viewFromWire)).toEqual([
			'notConfigured',
			'connecting',
			'connecting',
			'live',
			'noSignal',
			'authFailed',
			'unsupportedCodec'
		]);
		expect(VIEW_TEXT.live).toBe('');
		expect(VIEW_TEXT.authFailed).toBe('auth failed — see Plugins → Camera');
		expect(VIEW_TEXT.noSignal).toBe('no signal');
	});

	it('treats retrying without retryInMs as a parked, actionable state', () => {
		const retry = (extra: object) =>
			viewFromStatus({ kind: 'status', state: 'retrying', ...extra });
		expect(retry({ error: 'notFound' })).toBe('notFound');
		expect(retry({ error: 'protocol' })).toBe('protocolError');
		expect(VIEW_TEXT.notFound).toContain('Plugins → Camera');
		// transient: has retryInMs, or an unrelated error, stays "no signal"
		expect(retry({ error: 'notFound', retryInMs: 2000 })).toBe('noSignal');
		expect(retry({ error: 'streamLost', retryInMs: 2000 })).toBe('noSignal');
		expect(retry({ error: 'timeout' })).toBe('noSignal');
		expect(viewFromStatus({ kind: 'status', state: 'live' })).toBe('live');
	});
});
