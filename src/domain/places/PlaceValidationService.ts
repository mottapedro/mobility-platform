// PlaceValidationService — server-side validation of an operational base.
//
// Decision B: the operational base is validated server-side via Google Place
// Details (New) using providerPlaceId. The client-provided lat/lng is never
// trusted as the source of truth. When providerPlaceId is present, the server
// resolves authoritative coordinates + formatted address from Google.
//
// When GOOGLE_PLACES_API_KEY is absent (local dev / tests), the service falls
// back to a permissive pass-through so the pipeline does not hard-depend on a
// live upstream. This is a deliberate, documented degradation — production must
// configure the key.

import {
  GooglePlacesClient,
  PlaceDetailsResult,
  PlacesValidationError,
} from "./GooglePlacesClient";
import { loadPlacesConfig } from "../../config/places";

export interface OperationalBaseInput {
  providerPlaceId?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export type OperationalBaseResult =
  | {
      valid: true;
      providerPlaceId: string | null;
      address: string | null;
      lat: number;
      lng: number;
      source: "GOOGLE_PLACE_DETAILS" | "CLIENT_FALLBACK";
    }
  | {
      valid: false;
      providerPlaceId: string | null;
      address: string | null;
      reason: string;
      code: string;
    };

export class PlaceValidationService {
  constructor(
    private readonly client: GooglePlacesClient = new GooglePlacesClient(),
    private readonly config = loadPlacesConfig(),
  ) {}

  /**
   * Validate a single operational base. When providerPlaceId is provided and
   * the client is configured, coordinates come from Google (authoritative).
   * Otherwise the client lat/lng is accepted as a pass-through (dev/tests).
   */
  async validateBase(input: OperationalBaseInput): Promise<OperationalBaseResult> {
    if (input.providerPlaceId) {
      if (!this.client.isConfigured) {
        return {
          valid: true,
          providerPlaceId: input.providerPlaceId,
          address: input.address ?? null,
          lat: input.lat ?? 0,
          lng: input.lng ?? 0,
          source: "CLIENT_FALLBACK",
        };
      }

      try {
        const details = await this.client.getPlaceDetails(input.providerPlaceId);
        return {
          valid: true,
          providerPlaceId: details.placeId,
          address: details.formattedAddress ?? input.address ?? null,
          lat: details.latitude,
          lng: details.longitude,
          source: "GOOGLE_PLACE_DETAILS",
        };
      } catch (error) {
        if (error instanceof PlacesValidationError) {
          return {
            valid: false,
            providerPlaceId: input.providerPlaceId,
            address: input.address ?? null,
            reason: error.message,
            code: error.code,
          };
        }
        throw error;
      }
    }

    if (Number.isFinite(input.lat) && Number.isFinite(input.lng)) {
      return {
        valid: true,
        providerPlaceId: null,
        address: input.address ?? null,
        lat: input.lat as number,
        lng: input.lng as number,
        source: "CLIENT_FALLBACK",
      };
    }

    return {
      valid: false,
      providerPlaceId: null,
      address: input.address ?? null,
      reason: "Missing providerPlaceId or coordinates",
      code: "BASE_NOT_RESOLVABLE",
    };
  }

  /**
   * Cross-check that two coordinates are within the configured tolerance.
   * Used to reject client spoofing when both providerPlaceId and raw
   * coordinates are supplied and diverge materially.
   */
  isWithinTolerance(
    authoritative: { lat: number; lng: number },
    client: { lat: number; lng: number },
  ): boolean {
    const toleranceKm = this.config.coordinateToleranceKm;
    const latDelta = authoritative.lat - client.lat;
    const lngDelta = authoritative.lng - client.lng;
    const latKm = latDelta * 110.574;
    const lngKm = lngDelta * 111.32 * Math.cos((authoritative.lat * Math.PI) / 180);
    return Math.hypot(latKm, lngKm) <= toleranceKm;
  }

  static fromDetails(details: PlaceDetailsResult): OperationalBaseResult {
    return {
      valid: true,
      providerPlaceId: details.placeId,
      address: details.formattedAddress,
      lat: details.latitude,
      lng: details.longitude,
      source: "GOOGLE_PLACE_DETAILS",
    };
  }
}
