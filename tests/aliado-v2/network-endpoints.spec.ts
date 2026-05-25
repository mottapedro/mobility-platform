import request from "supertest";
import bcrypt from "bcrypt";
import { ActorType, ReferralFlowType } from "@prisma/client";
import { app } from "../../src/app";
import { prisma } from "../setup";
import { recordRelationship } from "../../src/domain/referral-network/ReferralRelationshipService";

async function makeDriver(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email, email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

async function makePassenger(email: string, rootDriverId: string) {
  const u = await prisma.user.create({
    data: {
      name: email, email,
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
      rootDriverId,
    },
  });
}

describe("Aliado V2 network endpoints", () => {
  it("GET /onboarding/context/:slug — invite slug returns full context", async () => {
    const owner = await makeDriver("ep.onb.invite@test.com");
    await prisma.invite.create({
      data: {
        slug: "ep-invite-slug-001",
        ownerActorType: ActorType.DRIVER,
        ownerId: owner.id,
        expectedFlowType: ReferralFlowType.DRIVER_TO_PASSENGER,
        expectedActorType: ActorType.PASSENGER,
      },
    });
    const res = await request(app).get("/onboarding/context/ep-invite-slug-001");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("invite");
    expect(res.body.flowType).toBe(ReferralFlowType.DRIVER_TO_PASSENGER);
    expect(res.body.inviter).toMatchObject({ actorType: ActorType.DRIVER, id: owner.id });
    expect(res.body.rootDriver).toMatchObject({ id: owner.id });
    expect(res.body.operationalOwnership).toMatchObject({ driverId: owner.id });
  });

  it("GET /onboarding/context/:slug — 404 when not found", async () => {
    const res = await request(app).get("/onboarding/context/totally-missing-slug-xyz");
    expect(res.status).toBe(404);
  });

  it("GET /onboarding/context/:slug — 410 when invite expired", async () => {
    const owner = await makeDriver("ep.onb.expired@test.com");
    await prisma.invite.create({
      data: {
        slug: "ep-invite-expired-001",
        ownerActorType: ActorType.DRIVER,
        ownerId: owner.id,
        expectedFlowType: ReferralFlowType.DRIVER_TO_PASSENGER,
        expectedActorType: ActorType.PASSENGER,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const res = await request(app).get("/onboarding/context/ep-invite-expired-001");
    expect(res.status).toBe(410);
  });

  it("GET /passengers/:id/lineage — returns lineage payload", async () => {
    const root = await makeDriver("ep.lineage.root@test.com");
    const p = await makePassenger("ep.lineage.p@test.com", root.id);
    await recordRelationship({
      inviterActorType: ActorType.DRIVER, inviterId: root.id,
      invitedActorType: ActorType.PASSENGER, invitedId: p.id,
    });
    const res = await request(app).get(`/passengers/${p.id}/lineage`);
    expect(res.status).toBe(200);
    expect(res.body.passengerId).toBe(p.id);
    expect(res.body.rootDriverId).toBe(root.id);
    expect(res.body.ancestors).toHaveLength(1);
  });

  it("GET /drivers/:id/ownership — returns 7 metrics", async () => {
    const d = await makeDriver("ep.own@test.com");
    const res = await request(app).get(`/drivers/${d.id}/ownership`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      driverId: d.id,
      windowDays: 30,
      directDrivers: 0,
      totalDriversInTree: 0,
      directPassengers: 0,
      totalPassengersInTree: 0,
      completedRidesAttributedToTree: 0,
      settledRevenueShareCents: 0,
      retentionRate: 0,
    });
  });

  it("GET /drivers/:id/network/summary — aggregates relationships, ownership, skills", async () => {
    const root = await makeDriver("ep.net.root@test.com");
    const p = await makePassenger("ep.net.p@test.com", root.id);
    await recordRelationship({
      inviterActorType: ActorType.DRIVER, inviterId: root.id,
      invitedActorType: ActorType.PASSENGER, invitedId: p.id,
    });
    const res = await request(app).get(`/drivers/${root.id}/network/summary`);
    expect(res.status).toBe(200);
    expect(res.body.driverId).toBe(root.id);
    expect(res.body.relationships).toBeDefined();
    expect(res.body.relationships.totals.total).toBeGreaterThanOrEqual(1);
    expect(res.body.ownership).toMatchObject({ driverId: root.id });
    expect(Array.isArray(res.body.skills)).toBe(true);
  });
});
