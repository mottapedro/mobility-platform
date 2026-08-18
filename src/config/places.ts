// config/places.ts — Google Places (New) configuration.
// GOOGLE_PLACES_API_KEY is required when PLACES_VALIDATION_ENABLED=true.
// The base URL targets the Place Details (New) endpoint family.
// GOOGLE_MAPS_SERVER_API_KEY is the server-side key used by DriverOriginResolver
// (Fase E) for Directions/textsearch fallback. Never share a client-side key.

export interface PlacesConfig {
  apiKey: string | null;
  serverApiKey: string | null;
  placesApiBaseUrl: string;
  fieldMask: string;
  coordinateToleranceKm: number;
  requestTimeoutMs: number;
}

const DEFAULT_PLACES_BASE_URL = "https://places.googleapis.com/v1/places";
const DEFAULT_FIELD_MASK = "id,displayName,formattedAddress,location";
const DEFAULT_COORDINATE_TOLERANCE_KM = 0.5;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

export function loadPlacesConfig(
  env: NodeJS.ProcessEnv = process.env,
): PlacesConfig {
  const apiKey = env.GOOGLE_PLACES_API_KEY?.trim() || null;
  const serverApiKey = env.GOOGLE_MAPS_SERVER_API_KEY?.trim() || null;
  const coordinateToleranceKm = Number(env.PLACES_COORDINATE_TOLERANCE_KM);
  const requestTimeoutMs = Number(env.PLACES_REQUEST_TIMEOUT_MS);
  return {
    apiKey,
    serverApiKey,
    placesApiBaseUrl: (
      env.GOOGLE_PLACES_BASE_URL?.trim() || DEFAULT_PLACES_BASE_URL
    ).replace(/\/+$/, ""),
    fieldMask: env.GOOGLE_PLACES_FIELD_MASK?.trim() || DEFAULT_FIELD_MASK,
    coordinateToleranceKm: Number.isFinite(coordinateToleranceKm)
      ? coordinateToleranceKm
      : DEFAULT_COORDINATE_TOLERANCE_KM,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs)
      ? requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS,
  };
}
