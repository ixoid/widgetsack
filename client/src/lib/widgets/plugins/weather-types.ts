// TS mirror of the weather Rust structs that cross the bridge (widgetsack/src/weather.rs). camelCase
// (the struct is `#[serde(rename_all = "camelCase")]`). Both providers are keyless — nothing is secret.

/** The weather data source (wire values). */
export type WeatherProvider = 'open-meteo' | 'met-no';

/** Non-secret weather config from `weather_config_status`. */
export type WeatherStatus = {
	configured: boolean;
	latitude: number;
	longitude: number;
	unit: string;
	pollSeconds: number;
	/** Optional so an older backend degrades to Open-Meteo; unknown values are treated the same. */
	provider?: string;
};
