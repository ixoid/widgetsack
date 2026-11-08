import { describe, expect, it } from 'vitest';
import { ACK_EVERY, createAckPolicy } from './camera-ack';

describe('ack policy', () => {
	it('acks every 8th frame', () => {
		const ack = createAckPolicy();
		const hits = Array.from({ length: 24 }, (_, i) => (ack(false) ? i + 1 : 0)).filter(Boolean);
		expect(ACK_EVERY).toBe(8);
		expect(hits).toEqual([8, 16, 24]);
	});

	it('acks every keyframe and restarts the count from it', () => {
		const ack = createAckPolicy();
		expect(ack(true)).toBe(true); // the first keyframe
		for (let i = 0; i < 7; i++) expect(ack(false)).toBe(false);
		expect(ack(false)).toBe(true); // 8 deltas after the keyframe
		expect(ack(false)).toBe(false);
		expect(ack(true)).toBe(true);
		for (let i = 0; i < 7; i++) expect(ack(false)).toBe(false);
		expect(ack(false)).toBe(true);
	});

	it('honours a custom cadence', () => {
		const ack = createAckPolicy(2);
		expect([ack(false), ack(false), ack(false), ack(false)]).toEqual([false, true, false, true]);
	});
});
