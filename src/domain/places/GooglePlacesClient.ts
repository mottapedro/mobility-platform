// GooglePlacesClient — Place Details (New) adapter.
//
// Decision B: the operational base is validated server-side via Google Place
// Details (New) using providerPlaceId. The client sends place ids from the
// Places Autocomplete widget; the server never trusts raw lat/lng as the
// source of truth for a ride's operational base.
//
// Endpoint: GET https://places.googleapis.com/v1/places/{placeId}
// Headers:  X-Goog-Api-Key + X-Goog-FieldMask

import { PlacesConfig, loadPlacesConfig } from "../../config/places";

export interface PlaceDetailsResult {
  placeId: string;
  displayName: string | null;
  formattedAddress: string | null;
  latitude: number;
  longitude: number;
}

export class PlacesValidationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "API_KEY_MISSING"
      | "PLACE_NOT_FOUND"
      | "INVALID_RESPONSE"
      | "UPSTREAM_ERROR",
  ) {
    super(message);
    this.name = "PlacesValidationError";
  }
}

export class GooglePlacesClient {
  private readonly config: PlacesConfig;

  constructor(config: PlacesConfig = loadPlacesConfig()) {
    this.config = config;
  }

  get isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async getPlaceDetails(placeId: string): Promise<PlaceDetailsResult> {
    if (!placeId || !placeId.trim()) {
      throw new PlacesValidationError(
        "providerPlaceId is required",
        "PLACE_NOT_FOUND",
      );
    }

    if (!this.config.apiKey) {
      throw new PlacesValidationError(
        "GOOGLE_PLACES_API_KEY is not configured",
        "API_KEY_MISSING",
      );
    }

    const url = `${this.config.placesApiBaseUrl}/${encodeURIComponent(
      placeId.trim(),
    )}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.config.apiKey,
          "X-Goog-FieldMask": this.config.fieldMask,
        },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      throw new PlacesValidationError(
        `Google Places request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "UPSTREAM_ERROR",
      );
    }

    if (response.status === 404) {
      throw new PlacesValidationError(
        `Place not found: ${placeId}`,
        "PLACE_NOT_FOUND",
      );
    }

    if (!response.ok) {
      throw new PlacesValidationError(
        `Google Places returned ${response.status}`,
        "UPSTREAM_ERROR",
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PlacesValidationError(
        "Google Places returned a non-JSON response",
        "INVALID_RESPONSE",
      );
    }

    return this.parsePlaceDetails(payload, placeId);
  }

  private parsePlaceDetails(payload: unknown, fallbackPlaceId: string): PlaceDetailsResult {
    const body = payload as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      throw new PlacesValidationError(
        "Google Places returned an unexpected payload",
        "INVALID_RESPONSE",
      );
    }

    const location = body.location as Record<string, unknown> | null;
    const latitude = Number(location?.latitude);
    const longitude = Number(location?.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new PlacesValidationError(
        "Google Places response is missing location coordinates",
        "INVALID_RESPONSE",
      );
    }

    const displayName = body.displayName as Record<string, unknown> | null;
    return {
      placeId: typeof body.id === "string" ? body.id : fallbackPlaceId,
      displayName:
        typeof displayName?.text === "string" ? displayName.text : null,
      formattedAddress:
        typeof body.formattedAddress === "string" ? body.formattedAddress : null,
      latitude,
      longitude,
    };
  }
}
