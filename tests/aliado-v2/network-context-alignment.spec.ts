/**
 * Spec: network-context-alignment
 *
 * Integration tests for GET /network/context — validates that the response
 * matches the frontend NetworkContext contract exactly.
 *
 * Why these tests exist:
 *   The frontend's useNetworkContext calls GET /network/context and consumes
 *   the response verbatim (no adapter). The backend was previously returning
 *   a legacy shape; these tests verify the aligned shape is returned.
 *
 * Coverage:
 *  1. Root DRIVER with no referrals → empty descendants, depth=0, no ancestors
 *  2. Root DRIVER with 1 D2D child → descendants has 1 node, depth=1
 *  3. Non-root DRIVER → ancestors populated with inviter
 *  4. rootDriver is full object (name + slug), not just an ID string
 *  5. inviteUrls present for driver with referralCode
 *  6. PASSENGER → operationalOwner populated, targetActorExpected='passenger'
 *  7. PASSENGER → flowType=DRIVER_TO_PASSENGER
 *  8. Shape completeness: flowType, targetActorExpected, genealogy.me present
 *
 * Test data policy: all records use @test.com domain only.
 */

import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../src/app";
import { prisma, cleanTestData } from "../setup";
import { ActorType, ExperienceLevel, ReferralFlowType } from "../../src/shared/enums";
import { recordRelationship } from "../../src/domain/referral-network/ReferralRelationshipService";

// ── Helpers ────────────────────────────────────────────────────────────────

const hash = (pw: string) => bcrypt.hash(pw, 4);

async function makeDriver(
  tag: string,
  opts: { level?: ExperienceLevel; isActive?: boolean; referredByDriverId?: string } = {}
) {
  const email = `ctx.driver.${tag}@test.com`;
  const u = await prisma.user.create({
    data: {
      name: `Driver ${tag}`,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await hash("x"),
    },
  });
  return prisma.driver.create({
    data: {
      userId: u.id,
      isActive: opts.isActive ?? true,
      experienceLevel: opts.level ?? ExperienceLevel.PROFISSIONAL,
      regions: ["ZN"],
      referralCode: `rc-ctx-${tag}`,
      publicSlug: `slug-ctx-${tag}`,
      referredByDriverId: opts.referredByDriverId,
    },
  });
}

async function makePassenger(tag: string, referredByDriverId?: string) {
  const email = `ctx.passenger.${tag}@test.com`;
  const u = await prisma.user.create({
    data: {
      name: `Passenger ${tag}`,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
      passwordHash: await hash("x"),
    },
  });
  return prisma.passenger.create({
    data: {
      userId: u.id,
      referredByDriverId,
      referralCode: `prc-${tag}`,
      publicSlug: `pslug-${tag}`,
      networkLevel: 0,
    },
  });
}

/** Wire A → B as D2D referral (DriverReferral + ReferralRelationship). */
async function wireD2D(parentDriver: { id: string }, childDriver: { id: string }) {
  await prisma.driverReferral.create({
    data: {
      referrerDriverId: parentDriver.id,
      referredDriverId: childDriver.id,
      level: 1,
      isDirect: true,
    },
  });
  await recordRelationship({
    inviterActorType: ActorType.DRIVER,
    inviterId: parentDriver.id,
    invitedActorType: ActorType.DRIVER,
    invitedId: childDriver.id,
  });
}

/** Wire driver → passenger (D2P referral + ReferralRelationship). */
async function wireD2P(
  driver: { id: string },
  passenger: { id: string },
  rootDriverId: string
) {
  await prisma.passenger.update({
    where: { id: passenger.id },
    data: { referredByDriverId: driver.id, rootDriverId },
  });
  await recordRelationship({
    inviterActorType: ActorType.DRIVER,
    inviterId: driver.id,
    invitedActorType: ActorType.PASSENGER,
    invitedId: passenger.id,
  });
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(cleanTestData);

// ── Tests ──────────────────────────────────────────────────────────────────

describe("GET /network/context — NetworkContext shape alignment", () => {
  const tag = () => Math.random().toString(36).slice(2, 7);

  // 1. Root DRIVER with no referrals
  it("root driver with no referrals → empty descendants, depth=0, no ancestors", async () => {
    const t = tag();
    const root = await makeDriver(`r1${t}`);

    const res = await request(app)
      .get(`/network/context?actorId=${root.id}&actorType=DRIVER`)
      .expect(200);

    expect(res.body.genealogy.descendants).toEqual([]);
    expect(res.body.networkMetrics.depth).toBe(0);
    expect(res.body.genealogy.ancestors).toEqual([]);
    expect(res.body.genealogy.lateral).toEqual([]);
  });

  // 2. Root DRIVER with 1 D2D child → descendants has 1 node, depth=1
  it("driver with 1 D2D child → descendants has 1 node, depth=1, flowType=DRIVER_TO_DRIVER", async () => {
    const t = tag();
    const root = await makeDriver(`r2root${t}`);
    const child = await makeDriver(`r2child${t}`, { referredByDriverId: root.id });
    await wireD2D(root, child);

    const res = await request(app)
      .get(`/network/context?actorId=${root.id}&actorType=DRIVER`)
      .expect(200);

    const { genealogy, networkMetrics, flowType } = res.body;
    expect(flowType).toBe("DRIVER_TO_DRIVER");
    expect(genealogy.descendants).toHaveLength(1);
    expect(genealogy.descendants[0].actor.id).toBe(child.id);
    expect(genealogy.descendants[0].depth).toBe(1);
    expect(networkMetrics.depth).toBe(1);
  });

  // 3. Non-root DRIVER → ancestors populated
  it("non-root driver → ancestors includes the inviter driver", async () => {
    const t = tag();
    const root = await makeDriver(`r3root${t}`);
    const child = await makeDriver(`r3child${t}`, { referredByDriverId: root.id });
    await wireD2D(root, child);

    const res = await request(app)
      .get(`/network/context?actorId=${child.id}&actorType=DRIVER`)
      .expect(200);

    const { genealogy } = res.body;
    expect(genealogy.ancestors).toHaveLength(1);
    expect(genealogy.ancestors[0].id).toBe(root.id);
    expect(genealogy.ancestors[0].actorType).toBe("driver");
  });

  // 4. rootDriver is full object with name and slug
  it("rootDriver is a full NetworkDriverActor object, not just an ID", async () => {
    const t = tag();
    const root = await makeDriver(`r4${t}`);

    const res = await request(app)
      .get(`/network/context?actorId=${root.id}&actorType=DRIVER`)
      .expect(200);

    const { rootDriver } = res.body;
    expect(rootDriver).not.toBeNull();
    expect(rootDriver.id).toBe(root.id);
    expect(typeof rootDriver.name).toBe("string");
    expect(rootDriver.actorType).toBe("driver");
    expect(rootDriver.slug).toBe(`slug-ctx-r4${t}`);
  });

  // 5. inviteUrls present for driver with referralCode
  it("inviteUrls are present for a driver with referralCode", async () => {
    const t = tag();
    const root = await makeDriver(`r5${t}`);

    const res = await request(app)
      .get(`/network/context?actorId=${root.id}&actorType=DRIVER`)
      .expect(200);

    const { inviteUrls } = res.body;
    expect(inviteUrls).not.toBeNull();
    expect(typeof inviteUrls.d2p).toBe("string");
    expect(inviteUrls.d2p).toContain(`/invite/d2p/rc-ctx-r5${t}`);
    expect(typeof inviteUrls.d2d).toBe("string");
    expect(inviteUrls.d2d).toContain(`/invite/d2d/rc-ctx-r5${t}`);
    expect(inviteUrls.p2p).toBeNull();

    // Legacy fields must remain while frontend migration is in progress.
    expect(typeof inviteUrls.driverToPassenger).toBe("string");
    expect(inviteUrls.driverToPassenger).toContain(`/invite/d2p/rc-ctx-r5${t}`);
    expect(typeof inviteUrls.driverToDriver).toBe("string");
    expect(inviteUrls.driverToDriver).toContain(`/invite/d2d/rc-ctx-r5${t}`);

    // Governance: driver context MUST NOT expose a passenger-flow alias.
    expect(inviteUrls.passengerToPassenger).toBeNull();
  });

  // 6. PASSENGER → operationalOwner + targetActorExpected
  it("passenger → operationalOwner is the referring driver, targetActorExpected=passenger", async () => {
    const t = tag();
    const root = await makeDriver(`r6root${t}`);
    const pax = await makePassenger(`r6p${t}`);
    await wireD2P(root, pax, root.id);

    const res = await request(app)
      .get(`/network/context?actorId=${pax.id}&actorType=PASSENGER`)
      .expect(200);

    const { genealogy, targetActorExpected } = res.body;
    expect(targetActorExpected).toBe("passenger");
    expect(genealogy.operationalOwner).not.toBeNull();
    expect(genealogy.operationalOwner.id).toBe(root.id);
    expect(genealogy.operationalOwner.actorType).toBe("driver");
  });

  // 7. PASSENGER → flowType = DRIVER_TO_PASSENGER
  it("passenger invited by driver → flowType=DRIVER_TO_PASSENGER", async () => {
    const t = tag();
    const root = await makeDriver(`r7root${t}`);
    const pax = await makePassenger(`r7p${t}`);
    await wireD2P(root, pax, root.id);

    const res = await request(app)
      .get(`/network/context?actorId=${pax.id}&actorType=PASSENGER`)
      .expect(200);

    expect(res.body.flowType).toBe("DRIVER_TO_PASSENGER");
  });

  // 8. Shape completeness
  it("response contains all required NetworkContext top-level fields", async () => {
    const t = tag();
    const root = await makeDriver(`r8${t}`);

    const res = await request(app)
      .get(`/network/context?actorId=${root.id}&actorType=DRIVER`)
      .expect(200);

    const body = res.body;
    expect(typeof body.flowType).toBe("string");
    expect(typeof body.targetActorExpected).toBe("string");
    expect(body.rootDriver).toBeDefined();
    expect(body.genealogy).toBeDefined();
    expect(body.genealogy.me).toBeDefined();
    expect(body.genealogy.me.id).toBe(root.id);
    expect(body.genealogy.me.actorType).toBe("driver");
    expect(Array.isArray(body.genealogy.ancestors)).toBe(true);
    expect(Array.isArray(body.genealogy.descendants)).toBe(true);
    expect(Array.isArray(body.genealogy.lateral)).toBe(true);
    expect(body.networkMetrics).toBeDefined();
    expect(typeof body.networkMetrics.totalActors).toBe("number");
    expect(typeof body.networkMetrics.activeCount).toBe("number");
    expect(typeof body.networkMetrics.depth).toBe("number");
    expect(body.capabilities).toBeDefined();
  });

  // 9. networkMetrics includes ridesFromNetwork, estimatedRevenue, and growth
  it("networkMetrics contains ridesFromNetwork, estimatedRevenue, and growth fields", async () => {
    const t = tag();
    const root = await makeDriver(`r9${t}`);

    const res = await request(app)
      .get(`/network/context?actorId=${root.id}&actorType=DRIVER`)
      .expect(200);

    const { networkMetrics } = res.body;
    expect(typeof networkMetrics.ridesFromNetwork).toBe("number");
    expect(typeof networkMetrics.estimatedRevenue).toBe("number");
    expect(networkMetrics.growth).toBeDefined();
    expect(typeof networkMetrics.growth.last7Days).toBe("number");
    expect(typeof networkMetrics.growth.last30Days).toBe("number");
  });

  // 10. rootDriver includes regions (array) and networkLevel fields
  it("rootDriver includes regions array and networkLevel", async () => {
    const t = tag();
    const root = await makeDriver(`r10${t}`);

    const res = await request(app)
      .get(`/network/context?actorId=${root.id}&actorType=DRIVER`)
      .expect(200);

    const { rootDriver } = res.body;
    expect(Array.isArray(rootDriver.regions)).toBe(true);
    expect(rootDriver.regions).toContain("ZN");
    // networkLevel may be null for a new driver (not yet computed), but field must exist
    expect("networkLevel" in rootDriver).toBe(true);
  });

  // 11. Driver descendant node includes nodeMetrics
  it("driver descendant node has nodeMetrics populated", async () => {
    const t = tag();
    const root = await makeDriver(`r11root${t}`);
    const child = await makeDriver(`r11child${t}`, { referredByDriverId: root.id });
    await wireD2D(root, child);

    const res = await request(app)
      .get(`/network/context?actorId=${root.id}&actorType=DRIVER`)
      .expect(200);

    const { genealogy } = res.body;
    expect(genealogy.descendants).toHaveLength(1);
    const childNode = genealogy.descendants[0];
    expect(childNode.nodeMetrics).toBeDefined();
    expect(typeof childNode.nodeMetrics.directPassengerCount).toBe("number");
    expect(typeof childNode.nodeMetrics.directDriverCount).toBe("number");
    expect(typeof childNode.nodeMetrics.completedRides).toBe("number");
  });

  // 12. Passenger networkMetrics also contains growth fields
  it("passenger networkMetrics contains ridesFromNetwork, estimatedRevenue, growth", async () => {
    const t = tag();
    const root = await makeDriver(`r12root${t}`);
    const pax = await makePassenger(`r12p${t}`);
    await wireD2P(root, pax, root.id);

    const res = await request(app)
      .get(`/network/context?actorId=${pax.id}&actorType=PASSENGER`)
      .expect(200);

    const { networkMetrics } = res.body;
    expect(typeof networkMetrics.ridesFromNetwork).toBe("number");
    expect(typeof networkMetrics.estimatedRevenue).toBe("number");
    expect(networkMetrics.growth).toBeDefined();
    expect(typeof networkMetrics.growth.last7Days).toBe("number");
    expect(typeof networkMetrics.growth.last30Days).toBe("number");
  });

  // 13. Passenger inviteUrls expose explicit p2p and hide d2d/d2p
  it("passenger inviteUrls expose explicit p2p context", async () => {
    const t = tag();
    const root = await makeDriver(`r13root${t}`);
    const pax = await makePassenger(`r13p${t}`);
    await wireD2P(root, pax, root.id);

    const res = await request(app)
      .get(`/network/context?actorId=${pax.id}&actorType=PASSENGER`)
      .expect(200);

    const { inviteUrls } = res.body;
    expect(inviteUrls).not.toBeNull();
    expect(inviteUrls.d2d).toBeNull();
    expect(inviteUrls.d2p).toBeNull();
    expect(typeof inviteUrls.p2p).toBe("string");
    expect(inviteUrls.p2p).toContain(`/invite/p2p/prc-r13p${t}`);

    // Governance: passenger context MUST NOT leak P2P link via driver aliases.
    // Reusing the p2p URL as driverToPassenger would allow the frontend to
    // share a passenger invite as if it were a driver invite (cross-flow bug).
    expect(inviteUrls.driverToPassenger).toBeNull();
    expect(inviteUrls.driverToDriver).toBeNull();
    // Legacy alias for P2P must mirror the canonical p2p URL.
    expect(typeof inviteUrls.passengerToPassenger).toBe("string");
    expect(inviteUrls.passengerToPassenger).toBe(inviteUrls.p2p);
  });
});
