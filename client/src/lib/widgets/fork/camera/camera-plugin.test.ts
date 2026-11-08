import { describe, expect, it } from 'vitest';
import { registerCameraPlugin } from './camera-plugin';
import Camera from './Camera';
import CameraSettings from './CameraSettings';
import { listPlugins } from '../../plugin';
import { getMeta } from '../../../core/widget';
import { registry } from '../../registry';

describe('camera plugin', () => {
	it('registers the settings pane and the self-sourcing camera widget', () => {
		registerCameraPlugin();
		const plugin = listPlugins().find((p) => p.id === 'camera');
		expect(plugin?.name).toBe('Camera');
		expect(plugin?.settings).toBe(CameraSettings);
		expect(plugin?.sources).toBeUndefined();
		expect(plugin?.widgets).toHaveLength(1);
	});

	it('the camera meta is self-sourcing, 320x180, with fit / caption / showState', () => {
		registerCameraPlugin();
		const meta = getMeta('camera');
		expect(meta?.binds).toBe('none');
		expect(meta?.sensors).toBeUndefined();
		expect(meta?.defaultSize).toEqual({ w: 320, h: 180 });
		expect(meta?.defaultConfig).toEqual({ fit: 'contain', caption: '', showState: true });
		expect(meta?.configFields?.map((f) => f.key)).toEqual(['fit', 'caption', 'showState']);
		expect(registry.camera).toBeTruthy();
		expect(Camera).toBeTruthy();
	});
});
