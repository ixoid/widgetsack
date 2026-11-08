// TS mirrors of the camera Rust structs that cross the bridge (widgetsack/src/fork/camera/types.rs,
// serde camelCase). Nothing here can carry a secret: the status holds the BARE address only
// (never userinfo) and the login/password are reported as booleans.

export type CameraWireState =
	| 'notConfigured'
	| 'idle'
	| 'connecting'
	| 'live'
	| 'retrying'
	| 'authFailed'
	| 'unsupportedCodec';

export type CameraErrorKind =
	| 'unreachable'
	| 'authFailed'
	| 'timeout'
	| 'notFound'
	| 'protocol'
	| 'unsupportedCodec'
	| 'streamLost';

/** `camera_config_status` / `camera_subscribe`. */
export type CameraStatus = {
	configured: boolean;
	host: string;
	port: number;
	path: string;
	hasUsername: boolean;
	hasPassword: boolean;
	credentialsSet: boolean;
	codec: string | null;
	width: number | null;
	height: number | null;
	state: CameraWireState;
};

/** `save_camera_config` argument. Blank/absent login or password = keep the stored value. */
export type CameraConfigInput = {
	/** Stream address; a pasted `user:pass@` is split by the backend. */
	url: string;
	username?: string;
	password?: string;
	clearCredentials?: boolean;
};

/** `save_camera_config` result. */
export type SaveResult = {
	credentialsMoved: boolean;
	credentialsDropped: boolean;
};

/** `camera_probe` (DESCRIBE only, studio only). */
export type ProbeResult = {
	ok: boolean;
	kind?: CameraErrorKind;
	codec?: string;
	width?: number;
	height?: number;
	fps?: number;
};
