/**
 * Spec: ride-execution-godnetwork
 *
 * Stage 2.C — Integration test for the ride lifecycle endpoints in the
 * context of Pedro's GodNetwork (Pedro → João → Gisele as passenger).
 *
 * Covers:
 *   - POST /rides/:id/lifecycle/start    (ACCEPTED → IN_PROGRESS)
 *   - POST /rides/:id/lifecycle/progress (IN_PROGRESS, no-op)
 *   - POST /rides/:id/lifecycle/complete (IN_PROGRESS → COMPLETED, emits RIDE_FINALIZED)
 *   - POST /rides/:id/lifecycle/cancel   (ACCEPTED → CANCELLED)
 *   - 422 for invalid transition (complete on PENDING ride)
 *   - RIDE_FINALIZED domain event persisted after complete
 */

import request from "supertest";
import bcrypt from "bcrypt";
import { DomainEventType, RideStatus } from "../../src/shared/enums";
import { prisma } from "../setup";
import { app } from "../../src/app";

import { ExperienceLevel } from "../../src/shared/enums";

async function makeDriver(email: string, experienceLevel: ExperienceLevel = ExperienceLevel.PROFISSIONAL) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: u.id, isActive: true, experienceLevel, regions: ["ZN"] },
  });
}

async function makePassenger(email: string, rootDriverId: string | null) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.passenger.create({
    data: {
      userId: u.id,
      referralCode: `r-${u.id.slice(0, 6)}`,
      publicSlug: `s-${u.id.slice(0, 6)}`,
      rootDriverId: rootDriverId ?? undefined,
    },
  });
}

async function makeRide(passengerId: string, driverId: string, status: RideStatus) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      origin: "Barra da Tijuca",
      destination: "Centro",
      scheduledAt: new Date(),
      status,
      selectedDriverId: driverId,
    },
  });
}

/** Sets up Pedro → João (driver) → Gisele (passenger) mini-network */
async function setupGodNetwork(tag: string) {
  const pedro = await makeDriver(`gn.pedro.${tag}@test.com`, ExperienceLevel.ELITE);
  const joao = await makeDriver(`gn.joao.${tag}@test.com`, ExperienceLevel.PROFISSIONAL);
  const gisele = await makePassenger(`gn.gisele.${tag}@test.com`, pedro.id);
  return { pedro, joao, gisele };
}

describe("RideExecution lifecycle routes (GodNetwork)", () => {
  it("start: ACCEPTED → IN_PROGRESS", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const { joao, gisele } = await setupGodNetwork(tag);
    const ride = await makeRide(gisele.id, joao.id, RideStatus.ACCEPTED);

    const res = await request(app).post(`/rides/${ride.id}/lifecycle/start`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(RideStatus.IN_PROGRESS);
    expect(res.body.started).toBe(true);

    const db = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });
    expect(db.status).toBe(RideStatus.IN_PROGRESS);
  });

  it("start: idempotent on already IN_PROGRESS ride", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const { joao, gisele } = await setupGodNetwork(tag);
    const ride = await makeRide(gisele.id, joao.id, RideStatus.IN_PROGRESS);

    const res = await request(app).post(`/rides/${ride.id}/lifecycle/start`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(RideStatus.IN_PROGRESS);
    expect(res.body.started).toBe(false);
  });

  it("start: 422 for invalid transition (COMPLETED → IN_PROGRESS)", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const { joao, gisele } = await setupGodNetwork(tag);
    const ride = await makeRide(gisele.id, joao.id, RideStatus.COMPLETED);

    const res = await request(app).post(`/rides/${ride.id}/lifecycle/start`);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/invalid transition/i);
  });

  it("progress: returns current status without changing it", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const { joao, gisele } = await setupGodNetwork(tag);
    const ride = await makeRide(gisele.id, joao.id, RideStatus.IN_PROGRESS);

    const res = await request(app).post(`/rides/${ride.id}/lifecycle/progress`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(RideStatus.IN_PROGRESS);

    // Status unchanged in DB
    const db = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });
    expect(db.status).toBe(RideStatus.IN_PROGRESS);
  });

  it("complete: IN_PROGRESS → COMPLETED and persists RIDE_FINALIZED event", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const { joao, gisele } = await setupGodNetwork(tag);
    const ride = await makeRide(gisele.id, joao.id, RideStatus.IN_PROGRESS);

    const res = await request(app).post(`/rides/${ride.id}/lifecycle/complete`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(RideStatus.COMPLETED);
    expect(res.body.finalized).toBe(true);

    const db = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });
    expect(db.status).toBe(RideStatus.COMPLETED);

    // NetworkMetricsUpdate hook: RIDE_FINALIZED event was persisted
    const event = await prisma.domainEvent.findFirst({
      where: { aggregateId: ride.id, type: DomainEventType.RIDE_FINALIZED },
    });
    expect(event).not.toBeNull();
    expect(event?.aggregateType).toBe("RideRequest");
  });

  it("complete: idempotent — second call returns finalized=false", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const { joao, gisele } = await setupGodNetwork(tag);
    const ride = await makeRide(gisele.id, joao.id, RideStatus.IN_PROGRESS);

    const first = await request(app).post(`/rides/${ride.id}/lifecycle/complete`);
    expect(first.status).toBe(200);
    expect(first.body.finalized).toBe(true);

    const second = await request(app).post(`/rides/${ride.id}/lifecycle/complete`);
    expect(second.status).toBe(200);
    expect(second.body.finalized).toBe(false);
    expect(second.body.status).toBe(RideStatus.COMPLETED);
  });

  it("cancel: ACCEPTED → CANCELLED", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const { joao, gisele } = await setupGodNetwork(tag);
    const ride = await makeRide(gisele.id, joao.id, RideStatus.ACCEPTED);

    const res = await request(app).post(`/rides/${ride.id}/lifecycle/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(RideStatus.CANCELLED);
    expect(res.body.cancelled).toBe(true);
  });

  it("cancel: 422 for invalid transition (COMPLETED → CANCELLED)", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const { joao, gisele } = await setupGodNetwork(tag);
    const ride = await makeRide(gisele.id, joao.id, RideStatus.COMPLETED);

    const res = await request(app).post(`/rides/${ride.id}/lifecycle/cancel`);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/invalid transition/i);
  });

  it("full GodNetwork flow: Pedro → João → Gisele ride from ACCEPTED to COMPLETED", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const { joao, gisele } = await setupGodNetwork(tag);
    const ride = await makeRide(gisele.id, joao.id, RideStatus.ACCEPTED);

    // Start the ride
    const startRes = await request(app).post(`/rides/${ride.id}/lifecycle/start`);
    expect(startRes.status).toBe(200);
    expect(startRes.body.status).toBe(RideStatus.IN_PROGRESS);

    // Check progress
    const progressRes = await request(app).post(`/rides/${ride.id}/lifecycle/progress`);
    expect(progressRes.status).toBe(200);
    expect(progressRes.body.status).toBe(RideStatus.IN_PROGRESS);

    // Complete the ride
    const completeRes = await request(app).post(`/rides/${ride.id}/lifecycle/complete`);
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe(RideStatus.COMPLETED);

    // Verify RIDE_FINALIZED event (NetworkMetricsUpdate hook trigger)
    const event = await prisma.domainEvent.findFirst({
      where: { aggregateId: ride.id, type: DomainEventType.RIDE_FINALIZED },
    });
    expect(event).not.toBeNull();
  });
});
