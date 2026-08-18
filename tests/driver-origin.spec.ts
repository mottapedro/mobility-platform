// Fase E — unidade: DriverOriginResolver (prioridade por modo e frescor) e
// DriverCurrentLocationService (upsert único por driver).
//
// Contrato Fase E revisado:
//   IMMEDIATE: CURRENT_LOCATION fresca (<=5min) primeiro; REGISTERED_BASE é
//              fallback (posição velha ou inexistente).
//   SCHEDULED: somente REGISTERED_BASE — posição corrente NUNCA é usada.

/// <reference types="jest" />
import { prisma } from "./setup";
import { DriverCurrentLocationService } from "../src/domain/driver/DriverCurrentLocationService";
import { DriverOperationalBaseService } from "../src/domain/driver/DriverOperationalBaseService";
import { DriverOriginResolver } from "../src/domain/pricing/DriverOriginResolver";

jest.setTimeout(15000);

let seq = 0;
function tag() {
  seq += 1;
  return `${Date.now()}.${seq}`;
}

async function createDriver(email: string) {
  const user = await prisma.user.create({
    data: {
      name: "Origin Driver",
      email,
      phone: "1193333000",
      role: "DRIVER",
      driver: {
        create: { experienceLevel: "INICIANTE", isActive: true },
      },
    },
    include: { driver: true },
  });
  return user.driver!;
}

const baseService = new DriverOperationalBaseService();
const locationService = new DriverCurrentLocationService();

describe("Fase E — DriverOriginResolver (IMMEDIATE)", () => {
  const resolver = new DriverOriginResolver(5 * 60 * 1000);

  it("sem base e sem posição → UNRESOLVED (NO_BASE_NO_LOCATION)", async () => {
    const driver = await createDriver(`origin.none.${tag()}@test.com`);
    const result = await resolver.resolveOriginForDriver({
      driverId: driver.id,
      rideLat: -23.55,
      rideLng: -46.63,
      mode: "IMMEDIATE",
    });
    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toBe("NO_BASE_NO_LOCATION");
    }
  });

  it("posição corrente fresca (sem base) resolve como CURRENT_LOCATION", async () => {
    const driver = await createDriver(`origin.fresh.${tag()}@test.com`);
    await locationService.record({
      driverId: driver.id,
      latitude: -23.55,
      longitude: -46.63,
    });

    const result = await resolver.resolveOriginForDriver({
      driverId: driver.id,
      rideLat: -23.55,
      rideLng: -46.63,
      mode: "IMMEDIATE",
    });

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.source).toBe("CURRENT_LOCATION");
      expect(result.distanceMtoAKm).toBe(0);
    }
  });

  it("posição obsoleta (além do frescor) sem base → UNRESOLVED (STALE_LOCATION)", async () => {
    const driver = await createDriver(`origin.stale.${tag()}@test.com`);
    await locationService.record({
      driverId: driver.id,
      latitude: -23.55,
      longitude: -46.63,
    });
    await prisma.driverCurrentLocation.update({
      where: { driverId: driver.id },
      data: { recordedAt: new Date(Date.now() - 6 * 60 * 1000) },
    });

    const result = await resolver.resolveOriginForDriver({
      driverId: driver.id,
      rideLat: -23.55,
      rideLng: -46.63,
      mode: "IMMEDIATE",
    });

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toBe("STALE_LOCATION");
    }
  });

  it("posição fresca tem prioridade sobre a base operacional", async () => {
    const driver = await createDriver(`origin.fresh.over.base.${tag()}@test.com`);
    await baseService.save(driver.id, {
      address: "Base Prio",
      lat: -23.55,
      lng: -46.63,
    });
    await locationService.record({
      driverId: driver.id,
      latitude: -22.9,
      longitude: -43.17,
    });

    const result = await resolver.resolveOriginForDriver({
      driverId: driver.id,
      rideLat: -23.55,
      rideLng: -46.63,
      mode: "IMMEDIATE",
    });

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.source).toBe("CURRENT_LOCATION");
      expect(result.distanceMtoAKm).toBeGreaterThan(300);
    }
  });

  it("posição obsoleta com base → fallback para REGISTERED_BASE", async () => {
    const driver = await createDriver(`origin.stale.with.base.${tag()}@test.com`);
    await baseService.save(driver.id, {
      address: "Base Centro",
      lat: -23.55,
      lng: -46.63,
    });
    await locationService.record({
      driverId: driver.id,
      latitude: -22.9,
      longitude: -43.17,
    });
    await prisma.driverCurrentLocation.update({
      where: { driverId: driver.id },
      data: { recordedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const result = await resolver.resolveOriginForDriver({
      driverId: driver.id,
      rideLat: -23.55,
      rideLng: -46.63,
      mode: "IMMEDIATE",
    });

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.source).toBe("REGISTERED_BASE");
      expect(result.distanceMtoAKm).toBe(0);
    }
  });

  it("base operacional (sem posição) resolve origem com distância M→A", async () => {
    const driver = await createDriver(`origin.base.${tag()}@test.com`);
    await baseService.save(driver.id, {
      address: "Base Centro",
      lat: -23.55,
      lng: -46.63,
    });

    const result = await resolver.resolveOriginForDriver({
      driverId: driver.id,
      // ~1.1 km norte de -23.55/-46.63 (delta de lat)
      rideLat: -23.54,
      rideLng: -46.63,
      mode: "IMMEDIATE",
    });

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.source).toBe("REGISTERED_BASE");
      expect(result.distanceMtoAKm).toBeGreaterThan(0.9);
      expect(result.distanceMtoAKm).toBeLessThan(1.3);
    }
  });
});

describe("Fase E — DriverOriginResolver (SCHEDULED)", () => {
  const resolver = new DriverOriginResolver(5 * 60 * 1000);

  it("com base → REGISTERED_BASE (mesmo com posição corrente fresca)", async () => {
    const driver = await createDriver(`origin.sched.base.${tag()}@test.com`);
    await baseService.save(driver.id, {
      address: "Base Centro",
      lat: -23.55,
      lng: -46.63,
    });
    await locationService.record({
      driverId: driver.id,
      latitude: -22.9,
      longitude: -43.17,
    });

    const result = await resolver.resolveOriginForDriver({
      driverId: driver.id,
      rideLat: -23.55,
      rideLng: -46.63,
      mode: "SCHEDULED",
    });

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.source).toBe("REGISTERED_BASE");
      expect(result.distanceMtoAKm).toBe(0);
    }
  });

  it("sem base, mesmo com posição fresca → UNRESOLVED (SCHEDULED_BASE_REQUIRED)", async () => {
    const driver = await createDriver(`origin.sched.nobase.${tag()}@test.com`);
    await locationService.record({
      driverId: driver.id,
      latitude: -23.55,
      longitude: -46.63,
    });

    const result = await resolver.resolveOriginForDriver({
      driverId: driver.id,
      rideLat: -23.55,
      rideLng: -46.63,
      mode: "SCHEDULED",
    });

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toBe("SCHEDULED_BASE_REQUIRED");
    }
  });
});

describe("Fase E — DriverCurrentLocationService", () => {
  const service = new DriverCurrentLocationService();

  it("upsert mantém uma única linha por driver", async () => {
    const driver = await createDriver(`loc.upsert.${tag()}@test.com`);

    await service.record({ driverId: driver.id, latitude: -23.55, longitude: -46.63 });
    await service.record({ driverId: driver.id, latitude: -23.56, longitude: -46.62, speed: 40 });

    const rows = await prisma.driverCurrentLocation.findMany({
      where: { driverId: driver.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].latitude).toBe(-23.56);
    expect(rows[0].speed).toBe(40);
  });

  it("rejeita coordenadas não finitas", async () => {
    const driver = await createDriver(`loc.invalid.${tag()}@test.com`);
    await expect(
      service.record({
        driverId: driver.id,
        latitude: Number.NaN,
        longitude: -46.63,
      }),
    ).rejects.toThrow(/latitude must be finite/);
  });
});
