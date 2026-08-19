import {
  GooglePlacesClient,
  PlacesValidationError,
} from "../src/domain/places/GooglePlacesClient";
import { PlaceValidationService } from "../src/domain/places/PlaceValidationService";
import { loadPlacesConfig } from "../src/config/places";

class FakeConfiguredClient extends GooglePlacesClient {
  async getPlaceDetails(placeId: string) {
    if (placeId === "ChIJ_invalid") {
      throw new PlacesValidationError(
        "Place not found: ChIJ_invalid",
        "PLACE_NOT_FOUND",
      );
    }
    if (placeId === "ChIJ_no_geometry") {
      // Google responde com local existente porém sem geometria utilizável.
      return {
        placeId,
        displayName: "Local sem geometria",
        formattedAddress: "Águas internacionais",
        latitude: 0,
        longitude: 0,
      };
    }
    return {
      placeId,
      displayName: "Barra da Tijuca",
      formattedAddress: "Av. das Américas, 5000 — Barra da Tijuca, Rio de Janeiro",
      latitude: -23.0012,
      longitude: -43.3587,
    };
  }
}

describe("PlaceValidationService — Decision B (server-side operational base)", () => {
  const config = loadPlacesConfig({ GOOGLE_PLACES_API_KEY: "test-key" });

  it("resolves authoritative coordinates from providerPlaceId via Google", async () => {
    const service = new PlaceValidationService(
      new FakeConfiguredClient(config),
      config,
    );

    const result = await service.validateBase({
      providerPlaceId: "ChIJ_barra",
      address: "Barra da Tijuca",
      lat: -23.0,
      lng: -43.35,
    });

    expect(result).toMatchObject({
      valid: true,
      providerPlaceId: "ChIJ_barra",
      source: "GOOGLE_PLACE_DETAILS",
      lat: -23.0012,
      lng: -43.3587,
    });
  });

  it("rejects an invalid providerPlaceId", async () => {
    const service = new PlaceValidationService(
      new FakeConfiguredClient(config),
      config,
    );

    const result = await service.validateBase({
      providerPlaceId: "ChIJ_invalid",
      address: "Endereço inexistente",
      lat: 0,
      lng: 0,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("PLACE_NOT_FOUND");
    }
  });

  it("passes through client coordinates when no providerPlaceId and no key", async () => {
    const noKeyConfig = loadPlacesConfig({});
    const service = new PlaceValidationService(
      new GooglePlacesClient(noKeyConfig),
      noKeyConfig,
    );

    const result = await service.validateBase({
      address: "Centro",
      lat: -22.9068,
      lng: -43.1729,
    });

    expect(result).toMatchObject({
      valid: true,
      providerPlaceId: null,
      source: "CLIENT_FALLBACK",
      lat: -22.9068,
      lng: -43.1729,
    });
  });

  it("falls back to client pass-through when providerPlaceId present but key missing", async () => {
    const noKeyConfig = loadPlacesConfig({});
    const service = new PlaceValidationService(
      new GooglePlacesClient(noKeyConfig),
      noKeyConfig,
    );

    const result = await service.validateBase({
      providerPlaceId: "ChIJ_sem_key",
      address: "Qualquer",
      lat: -22.9,
      lng: -43.1,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.source).toBe("CLIENT_FALLBACK");
    }
  });

  it("reports unresolvable base when nothing is provided", async () => {
    const noKeyConfig = loadPlacesConfig({});
    const service = new PlaceValidationService(
      new GooglePlacesClient(noKeyConfig),
      noKeyConfig,
    );

    const result = await service.validateBase({
      address: "Lugar desconhecido",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("BASE_NOT_RESOLVABLE");
    }
  });

  it("providerPlaceId sem chave e sem coordenadas → BASE_NOT_RESOLVABLE (nunca fabrica 0/0)", async () => {
    const noKeyConfig = loadPlacesConfig({});
    const service = new PlaceValidationService(
      new GooglePlacesClient(noKeyConfig),
      noKeyConfig,
    );

    const result = await service.validateBase({
      providerPlaceId: "ChIJ_sem_geometria",
      address: "Endereço sem geometria",
    });

    // Antes do fix isto retornava valid:true com lat/lng = 0 — a base (0,0)
    // inflou a perna M→A para 5.325 km e o preço para R$ 6.428,98.
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("BASE_NOT_RESOLVABLE");
    }
  });

  it("coordenadas degeneradas (0,0) são rejeitadas mesmo no pass-through sem chave", async () => {
    const noKeyConfig = loadPlacesConfig({});
    const service = new PlaceValidationService(
      new GooglePlacesClient(noKeyConfig),
      noKeyConfig,
    );

    const result = await service.validateBase({
      address: "Centro",
      lat: 0,
      lng: 0,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("BASE_NOT_RESOLVABLE");
    }
  });

  it("Google com geometria degenerada (0,0) → BASE_NOT_RESOLVABLE", async () => {
    const service = new PlaceValidationService(
      new FakeConfiguredClient(config),
      config,
    );

    const result = await service.validateBase({
      providerPlaceId: "ChIJ_no_geometry",
      address: "Local sem geometria",
      lat: -23.0,
      lng: -43.35,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("BASE_NOT_RESOLVABLE");
    }
  });

  it("detects coordinate divergence beyond tolerance", () => {
    const service = new PlaceValidationService(
      new GooglePlacesClient(config),
      config,
    );
    const authoritative = { lat: -23.0012, lng: -43.3587 };

    expect(service.isWithinTolerance(authoritative, authoritative)).toBe(true);
    expect(
      service.isWithinTolerance(authoritative, {
        lat: -23.0010,
        lng: -43.3585,
      }),
    ).toBe(true);
    expect(
      service.isWithinTolerance(authoritative, { lat: -22.5, lng: -43.3 }),
    ).toBe(false);
  });
});
