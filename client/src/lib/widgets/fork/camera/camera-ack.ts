// Flow-control cadence for `camera_ack`: Rust drops deltas for a subscriber with more than 24
// frames in flight and drops a subscriber that stays silent for 15 s, so the client acknowledges
// the last frame it received every 8 frames and on every keyframe (the resync point).

export const ACK_EVERY = 8;

/** Call once per received frame; true when this frame's seq should be acknowledged. */
export function createAckPolicy(every = ACK_EVERY): (keyframe: boolean) => boolean {
	let since = 0;
	return (keyframe) => {
		since++;
		if (!keyframe && since < every) return false;
		since = 0;
		return true;
	};
}
