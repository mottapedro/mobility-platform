// config/features.ts

export const FEATURES = {
  PRICING_ENABLED: true,
  DISTANCE_CALC_ENABLED: false,
  // Decision B — server-side operational base validation via Google Place
  // Details (New). When true and GOOGLE_PLACES_API_KEY is set, providerPlaceId
  // becomes the authoritative source of coordinates for ride creation.
  PLACES_VALIDATION_ENABLED: process.env.PLACES_VALIDATION_ENABLED === "true",
  // Fase E — quote de oferta: corridas M1 com origem resolvida (base operacional
  // ou posição corrente fresca) emitem RideQuote AGREED + primeira oferta com
  // snapshot síncrono. Corridas sem origem resolvida seguem o fluxo clássico.
  QUOTE_ENABLED: process.env.QUOTE_ENABLED !== "false",
};