// Tiny external store for the spike readout: the stream session publishes, the Camera settings
// pane subscribes (useSyncExternalStore). Module-level on purpose: both live in the studio window.
import type { StatsSnapshot } from './camera-stats';

let current: StatsSnapshot | null = null;
const listeners = new Set<() => void>();

export const getDiagnostics = (): StatsSnapshot | null => current;

export function subscribeDiagnostics(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

export function publishDiagnostics(next: StatsSnapshot | null): void {
	current = next;
	for (const cb of listeners) cb();
}
