// The Camera plugin (fork C-1). Settings pane only for now; the `camera` widget and stream hook
// register here in a later batch. Named `camera-plugin.ts` so it never collides with a
// `Camera.tsx` component on the case-insensitive filesystem.

import { registerPlugin } from '../../plugin';
import CameraSettings from './CameraSettings';

export const registerCameraPlugin = (): void =>
	registerPlugin({
		id: 'camera',
		name: 'Camera',
		description:
			'A live RTSP camera on the overlay. Enter the stream address, login and password here; the login and password are stored encrypted and never shown again.',
		settings: CameraSettings
	});
