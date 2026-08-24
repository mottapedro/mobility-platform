import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../setup";
import { AuthSessionService } from "../../src/domain/auth/AuthSessionService";
import { AuthTokenService } from "../../src/domain/auth/AuthTokenService";

// Regression contract for GET /drivers/:driverId/rides — the driver read-model.
// See driver.controller.ts loadRidesForDriver. Covers the two-clause rule:
//   1. selectedDriverId = D → ride belongs to D (any driver-lifecycle status)
//   2. selectedDriverId = null + RideQuote.pricingDriverId = D + TERMINAL status
//      → ride belongs to D (M1 priced the quote but was never selected).
// Clause 2 must be strictly terminal and MUST NOT leak root-owner rides that
// were priced by another driver.

const ACTIVE_STATUSES = ["ACCEPTED", "STARTED", "IN_PROGRESS"];
const DRIVER_RIDE_STATUSES = ["ACCEPTED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "REJECTED", "EXPIRED", "PAID"];

let seq = 0;
function tag() {
  seq += 1;
  return `${Date.now()}.${seq}`;
}

async function makeDriver(role: "D" | "E", suffix: string) {
  const u = await prisma.user.create({
    data: {
      name: `RM ${role}`,
      email: `rm.${role.toLowerCase()}.${suffix}@test.com`,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: "test",
    },
  });
  return prisma.driver.create({
    data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

async function makePassenger(suffix: string) {
  const u = await prisma.user.create({
    data: {
      name: "RM Passenger",
      email: `rm.psg.${suffix}@test.com`,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
      passwordHash: "test",
    },
  });
  return prisma.passenger.create({
    data: {
      referralCode: `rm-psg-${suffix}`,
      publicSlug: `rm-psg-${suffix}`,
      userId: u.id,
    },
  });
}

async function bearerForUserId(userId: string) {
  const issued = await new AuthSessionService().createSession(userId);
  return new AuthTokenService().issueAccessToken({
    userId,
    sessionId: issued.session.id,
  });
}

async function bearerForDriver(driverId: string) {
  const driver = await prisma.driver.findUniqueOrThrow({
    where: { id: driverId },
    select: { userId: true },
  });
  return bearerForUserId(driver.userId);
}

function rideInput(passengerId: string) {
  return {
    passengerId,
    origin: "Rua A",
    destination: "Rua B",
    originLat: -22.9,
    originLng: -43.2,
    destinationLat: -23.0,
    destinationLng: -43.4,
    distanceKm: 12,
    durationMin: 30,
  };
}

function quoteInput(rideRequestId: string, pricingDriverId: string) {
  return {
    rideRequestId,
    pricingDriverId,
    originMLat: -22.9,
    originMLng: -43.2,
    originMSource: "REGISTERED_BASE",
    distanceMtoAKm: 3.2,
    distanceAtoBKm: 12,
    legCostMtoACents: 384,
    legPriceAtoBCents: 1440,
    grossFinalCents: 1824,
    driverReceivableAmountCents: 1733,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

describe("Driver rides read-model — GET /drivers/:driverId/rides", () => {
  it("retorna corridas de D por selectedDriverId (ACCEPTED/COMPLETED/CANCELLED) e a órfã terminal precificada por D; não vaza rides de raiz nem quotes não terminais", async () => {
    const suffix = tag();
    const D = await makeDriver("D", suffix);
    const E = await makeDriver("E", suffix);
    const passenger = await makePassenger(suffix);

    // 1) selectedDriverId = D, status ACCEPTED → pertence a D
    const rideAccepted = await prisma.rideRequest.create({
      data: { ...rideInput(passenger.id), status: "ACCEPTED", selectedDriverId: D.id },
    });
    // 2) selectedDriverId = D, status COMPLETED → pertence a D
    const rideCompleted = await prisma.rideRequest.create({
      data: { ...rideInput(passenger.id), status: "COMPLETED", selectedDriverId: D.id },
    });
    // 3) selectedDriverId = D, status CANCELLED → pertence a D
    const rideCancelledSelected = await prisma.rideRequest.create({
      data: { ...rideInput(passenger.id), status: "CANCELLED", selectedDriverId: D.id },
    });
    // 4) selectedDriverId = null + quote precificada por D + CANCELLED → pertence a D (órfã)
    const rideOrphanCancelled = await prisma.rideRequest.create({
      data: { ...rideInput(passenger.id), status: "CANCELLED", selectedDriverId: null, rootDriverId: D.id },
    });
    await prisma.rideQuote.create({
      data: { ...quoteInput(rideOrphanCancelled.id, D.id), status: "EXPIRED" },
    });
    // 5) selectedDriverId = null + rootDriverId = D + quote precificada por E + CANCELLED
    //    → NÃO pertence a D (apenas raiz não é vínculo)
    const rideRootOnlyCancelled = await prisma.rideRequest.create({
      data: { ...rideInput(passenger.id), status: "CANCELLED", selectedDriverId: null, rootDriverId: D.id },
    });
    await prisma.rideQuote.create({
      data: { ...quoteInput(rideRootOnlyCancelled.id, E.id), status: "EXPIRED" },
    });
    // 6) selectedDriverId = null + quote precificada por D + PENDING (não terminal)
    //    → NÃO aparece (cláusula 2 é estritamente terminal)
    const rideQuotedActive = await prisma.rideRequest.create({
      data: { ...rideInput(passenger.id), status: "PENDING", selectedDriverId: null },
    });
    await prisma.rideQuote.create({
      data: { ...quoteInput(rideQuotedActive.id, D.id), status: "QUOTED" },
    });

    const tokenD = await bearerForDriver(D.id);
    const res = await request(app)
      .get(`/drivers/${D.id}/rides`)
      .set("Authorization", `Bearer ${tokenD}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: string }) => r.id);

    // Pertencem a D.
    expect(ids).toContain(rideAccepted.id);
    expect(ids).toContain(rideCompleted.id);
    expect(ids).toContain(rideCancelledSelected.id);
    expect(ids).toContain(rideOrphanCancelled.id);

    // NÃO pertencem a D.
    expect(ids).not.toContain(rideRootOnlyCancelled.id);
    expect(ids).not.toContain(rideQuotedActive.id);

    // Separação Ativas/Histórico (mesma regra do frontend driver/rides/page.tsx).
    const active = res.body.filter((r: { status: string }) => ACTIVE_STATUSES.includes(r.status));
    const history = res.body.filter((r: { status: string }) => !ACTIVE_STATUSES.includes(r.status));
    expect(active.map((r: { id: string }) => r.id)).toContain(rideAccepted.id);
    expect(history.map((r: { id: string }) => r.id)).toContain(rideCompleted.id);
    expect(history.map((r: { id: string }) => r.id)).toContain(rideCancelledSelected.id);
    expect(history.map((r: { id: string }) => r.id)).toContain(rideOrphanCancelled.id);

    // Todos os status retornados são válidos para o read-model.
    for (const r of res.body as Array<{ status: string }>) {
      expect(DRIVER_RIDE_STATUSES).toContain(r.status);
    }
  });

  it("caso 4 idempotente: órfã CANCELLED com selectedDriverId=null e quote EXPIRED precificada por D aparece no histórico; E não a vê", async () => {
    const suffix = tag();
    const D = await makeDriver("D", suffix);
    const E = await makeDriver("E", suffix);
    const passenger = await makePassenger(suffix);

    const orphan = await prisma.rideRequest.create({
      data: { ...rideInput(passenger.id), status: "CANCELLED", selectedDriverId: null, rootDriverId: D.id },
    });
    await prisma.rideQuote.create({
      data: { ...quoteInput(orphan.id, D.id), status: "EXPIRED" },
    });

    const tokenD = await bearerForDriver(D.id);
    const tokenE = await bearerForDriver(E.id);
    const resD = await request(app)
      .get(`/drivers/${D.id}/rides`)
      .set("Authorization", `Bearer ${tokenD}`);
    expect(resD.status).toBe(200);
    expect(resD.body.map((r: { id: string }) => r.id)).toContain(orphan.id);

    const resE = await request(app)
      .get(`/drivers/${E.id}/rides`)
      .set("Authorization", `Bearer ${tokenE}`);
    expect(resE.status).toBe(200);
    expect(resE.body.map((r: { id: string }) => r.id)).not.toContain(orphan.id);
  });

  it("exige Bearer e impede spoof de route, driver cruzado e token de passageiro", async () => {
    const suffix = tag();
    const D = await makeDriver("D", suffix);
    const E = await makeDriver("E", suffix);
    const passenger = await makePassenger(suffix);
    const ride = await prisma.rideRequest.create({
      data: { ...rideInput(passenger.id), status: "COMPLETED", selectedDriverId: D.id },
    });
    const tokenD = await bearerForDriver(D.id);
    const tokenE = await bearerForDriver(E.id);
    const passengerToken = await bearerForUserId(passenger.userId);

    const anonymous = await request(app).get(`/drivers/${D.id}/rides`);
    const invalid = await request(app)
      .get(`/drivers/${D.id}/rides`)
      .set("Authorization", "Bearer invalid-token");
    const allowed = await request(app)
      .get(`/drivers/${D.id}/rides`)
      .set("Authorization", `Bearer ${tokenD}`);
    const routeSpoof = await request(app)
      .get(`/drivers/${E.id}/rides`)
      .set("Authorization", `Bearer ${tokenD}`);
    const passengerRead = await request(app)
      .get(`/drivers/${D.id}/rides`)
      .set("Authorization", `Bearer ${passengerToken}`);
    const spoofHeader = await request(app)
      .get(`/drivers/${D.id}/rides`)
      .set("Authorization", `Bearer ${tokenD}`)
      .set("x-driver-id", E.id);
    const driverB = await request(app)
      .get(`/drivers/${E.id}/rides`)
      .set("Authorization", `Bearer ${tokenE}`);

    expect(anonymous.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(allowed.body.map((r: { id: string }) => r.id)).toContain(ride.id);
    expect(routeSpoof.status).toBe(404);
    expect(passengerRead.status).toBe(401);
    expect(spoofHeader.status).toBe(200);
    expect(spoofHeader.body.map((r: { id: string }) => r.id)).toContain(ride.id);
    expect(driverB.status).toBe(200);
    expect(driverB.body.map((r: { id: string }) => r.id)).not.toContain(ride.id);
  });
});
