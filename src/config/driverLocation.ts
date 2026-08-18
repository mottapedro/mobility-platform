// config/driverLocation.ts — frescor da posição global do motorista (Fase E).
// O DriverOriginResolver só usa a posição corrente se a amostra for recente
// o suficiente para a precificação da perna M→A. Amostra antiga é tratada
// como origem não resolvida (a corrida segue o fluxo clássico).

export interface DriverLocationConfig {
  /** Idade máxima de uma amostra para ser considerada origem válida. */
  freshnessMs: number;
}

const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutos

export function loadDriverLocationConfig(
  env: NodeJS.ProcessEnv = process.env,
): DriverLocationConfig {
  const freshnessMs = Number(env.CURRENT_LOCATION_FRESHNESS_MS);
  return {
    freshnessMs: Number.isFinite(freshnessMs) && freshnessMs > 0
      ? freshnessMs
      : DEFAULT_FRESHNESS_MS,
  };
}
