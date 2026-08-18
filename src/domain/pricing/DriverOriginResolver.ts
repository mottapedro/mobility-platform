// DriverOriginResolver — resolução da origem M para precificação (Fase E).
//
// A perna M→A parte de onde o motorista está. A prioridade depende do modo da
// corrida (decisão aprovada — contrato Fase E):
//
//   IMMEDIATE (sem scheduledAt):
//     1. DriverCurrentLocation — somente se a amostra for fresca
//        (CURRENT_LOCATION_FRESHNESS_MS, default 5min). Amostra velha é tratada
//        como não resolvida para não precificar M→A com posição obsoleta.
//     2. DriverOperationalBase (endereço cadastrado no onboarding) — fallback.
//     3. Nenhuma → UNRESOLVED.
//
//   SCHEDULED (com scheduledAt futuro):
//     1. DriverOperationalBase — somente esta fonte é válida para agendadas
//        (o motorista ainda não está deslocado para a origem da corrida).
//     2. Sem base → UNRESOLVED (posição corrente NUNCA é usada em agendadas).

import { prisma } from "../../infra/prisma/client";
import { loadDriverLocationConfig } from "../../config/driverLocation";
import { HaversineRouteCalculator } from "./RouteCalculator";

export type RideMode = "IMMEDIATE" | "SCHEDULED";

export type OriginSource = "REGISTERED_BASE" | "CURRENT_LOCATION";

export type ResolvedOrigin =
  | {
      resolved: true;
      source: OriginSource;
      lat: number;
      lng: number;
      distanceMtoAKm: number;
      estimatedDurationMin: number;
    }
  | {
      resolved: false;
      reason: "NO_BASE_NO_LOCATION" | "STALE_LOCATION" | "SCHEDULED_BASE_REQUIRED";
    };

export interface ResolveOriginInput {
  driverId: string;
  rideLat: number;
  rideLng: number;
  mode: RideMode;
}

const routeCalculator = new HaversineRouteCalculator();

export class DriverOriginResolver {
  constructor(private readonly freshnessMs: number | null = null) {}

  private resolveFreshnessCutoff(): Date {
    const freshnessMs =
      this.freshnessMs ?? loadDriverLocationConfig().freshnessMs;
    return new Date(Date.now() - freshnessMs);
  }

  async resolveOriginForDriver(
    input: ResolveOriginInput,
  ): Promise<ResolvedOrigin> {
    const base = await prisma.driverOperationalBase.findUnique({
      where: { driverId: input.driverId },
    });

    // SCHEDULED — somente a base operacional é origem válida.
    if (input.mode === "SCHEDULED") {
      if (!base) {
        return { resolved: false, reason: "SCHEDULED_BASE_REQUIRED" };
      }
      return this.withDistance(
        "REGISTERED_BASE",
        base.latitude,
        base.longitude,
        input,
      );
    }

    // IMMEDIATE — posição corrente fresca é a origem preferencial; a base é o
    // fallback quando a amostra é velha ou inexistente.
    const location = await prisma.driverCurrentLocation.findUnique({
      where: { driverId: input.driverId },
    });

    if (location) {
      const cutoff = this.resolveFreshnessCutoff();
      if (location.recordedAt >= cutoff) {
        return this.withDistance(
          "CURRENT_LOCATION",
          location.latitude,
          location.longitude,
          input,
        );
      }
    }

    if (base) {
      return this.withDistance(
        "REGISTERED_BASE",
        base.latitude,
        base.longitude,
        input,
      );
    }

    return location
      ? { resolved: false, reason: "STALE_LOCATION" }
      : { resolved: false, reason: "NO_BASE_NO_LOCATION" };
  }

  private async withDistance(
    source: OriginSource,
    lat: number,
    lng: number,
    input: ResolveOriginInput,
  ): Promise<ResolvedOrigin> {
    const route = await routeCalculator.calculate(
      { lat, lng },
      { lat: input.rideLat, lng: input.rideLng },
    );
    return {
      resolved: true,
      source,
      lat,
      lng,
      distanceMtoAKm: route.distanceKm,
      estimatedDurationMin: route.estimatedDurationMin,
    };
  }
}
