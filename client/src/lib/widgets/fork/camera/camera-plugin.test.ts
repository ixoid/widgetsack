import { describe, expect, it } from 'vitest';
import { registerCameraPlugin } from './camera-plugin';
import CameraSettings from './CameraSettings';
import { listPlugins } from '../../plugin';

describe('camera plugin', () => {
	it('registers a settings-only plugin (the widget lands in a later batch)', () => {
		registerCameraPlugin();
		const plugin = listPlugins().find((p) => p.id === 'camera');
		expect(plugin?.name).toBe('Camera');
		expect(plugin?.settings).toBe(CameraSettings);
		expect(plugin?.widgets).toBeUndefined();
		expect(plugin?.sources).toBeUndefined();
	});
});
