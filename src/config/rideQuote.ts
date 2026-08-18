import { parseDurationSeconds } from "./auth";

const DEFAULT_RIDE_QUOTE_TTL = "15m";

/**
 * Vida útil de uma RideQuote em ms. Default: 15 minutos (decisão aprovada).
 * A quote expira em `expiresAt = createdAt + RIDE_QUOTE_TTL`; expirada nunca
 * confirma. Override: RIDE_QUOTE_TTL (ex.: "5m", "30m", "1h").
 */
export function loadRideQuoteTtlMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    parseDurationSeconds(
      env.RIDE_QUOTE_TTL ?? DEFAULT_RIDE_QUOTE_TTL,
      "RIDE_QUOTE_TTL",
    ) * 1_000
  );
}

export const RIDE_QUOTE_TTL_MS_DEFAULT = 15 * 60 * 1_000;