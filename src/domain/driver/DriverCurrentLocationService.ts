// DriverCurrentLocationService — posição global corrente do motorista (Fase E).
//
// Uma única linha por driver (upsert por driverId). Não é histórico: para
// trilha usar DriverLocationPing. A amostra carrega precisão, velocidade e
// odômetro opcionais; o frescor é validado pelo DriverOriginResolver.

import { prisma } from "../../infra/prisma/client";

export interface RecordLocationInput {
  driverId: string;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  odometer?: number | null;
  speed?: number | null;
  recordedAt?: Date;
}

export interface LocationSample {
  driverId: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  odometer: number | null;
  speed: number | null;
  recordedAt: Date;
}

function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be finite, got ${value}`);
  }
}

export class DriverCurrentLocationService {
  /**
   * Grava a amostra mais recente da posição do motorista. Upsert idempotente.
   * A única leitura usada downstream é a linha corrente — nunca o histórico.
   */
  async record(input: RecordLocationInput): Promise<LocationSample> {
    const { driverId, latitude, longitude } = input;
    if (typeof driverId !== "string" || !driverId) {
      throw new Error("driverId is required");
    }
    assertFinite(latitude, "latitude");
    assertFinite(longitude, "longitude");

    const recordedAt = input.recordedAt ?? new Date();

    const row = await prisma.driverCurrentLocation.upsert({
      where: { driverId },
      update: {
        latitude,
        longitude,
        accuracy: input.accuracy ?? null,
        odometer: input.odometer ?? null,
        speed: input.speed ?? null,
        recordedAt,
      },
      create: {
        driverId,
        latitude,
        longitude,
        accuracy: input.accuracy ?? null,
        odometer: input.odometer ?? null,
        speed: input.speed ?? null,
        recordedAt,
      },
    });

    return {
      driverId: row.driverId,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracy: row.accuracy,
      odometer: row.odometer,
      speed: row.speed,
      recordedAt: row.recordedAt,
    };
  }
}