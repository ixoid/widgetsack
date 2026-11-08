// The Camera plugin (fork C-1): a settings pane (address + write-only credentials + diagnostics) and
// the self-sourcing `camera` widget. Named `camera-plugin.ts` so it never collides with `Camera.tsx`
// on the case-insensitive filesystem.

import { registerPlugin } from '../../plugin';
import { asMeter } from '../../registry';
import Camera from './Camera';
import CameraSettings from './CameraSettings';

export const registerCameraPlugin = (): void =>
	registerPlugin({
		id: 'camera',
		name: 'Camera',
		description:
			'A live RTSP camera on the overlay. Enter the stream address, login and password here; the login and password are stored encrypted and never shown again.',
		settings: CameraSettings,
		widgets: [
			{
				meta: {
					// Self-sourcing (binds:'none'): the widget opens its own backend stream channel.
					type: 'camera',
					binds: 'none',
					label: 'Camera',
					description:
						'Live video from the RTSP camera configured in Plugins → Camera. Shows a short status line instead of a picture while connecting, offline or misconfigured.',
					defaultSize: { w: 320, h: 180 },
					defaultConfig: { fit: 'contain', caption: '', showState: true },
					configFields: [
						{
							key: 'fit',
							label: 'fit',
							kind: 'select',
							options: ['contain', 'cover'],
							group: 'Appearance',
							help: 'contain keeps the whole picture, cover fills the box and crops'
						},
						{
							key: 'caption',
							label: 'caption',
							kind: 'text',
							group: 'Appearance',
							help: 'optional label along the bottom edge'
						},
						{
							key: 'showState',
							label: 'status text',
							kind: 'toggle',
							group: 'Appearance',
							help: 'show «connecting», «no signal» and similar over the picture'
						}
					]
				},
				component: asMeter(Camera)
			}
		]
	});
