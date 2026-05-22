import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";
import { createDriverReferralChain } from "../src/domain/services/DriverReferralService";

// Clean up database before each test to ensure isolation
beforeEach(async () => {
  // Delete passengers first due to FK constraints
  await prisma.passenger.deleteMany({});

  // Delete referral graph first
  await prisma.driverReferral.deleteMany({});

  // Delete ride offers / vehicles if necessary
  await prisma.rideOffer.deleteMany({});
  await prisma.vehicle.deleteMany({});

  // Delete drivers and users
  await prisma.driver.deleteMany({});
  await prisma.user.deleteMany({});
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createDriver(email: string) {
  const user = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: "21999990000",
      role: "DRIVER",
      driver: {
        create: {
          experienceLevel: "PROFISSIONAL",
          isActive: true,
          referralCode: `ref-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
          regions: ["ZN"],
        },
      },
    },
    include: {
      driver: true,
    },
  });

  return user.driver!;
}

async function createPassenger(
  email: string,
  referredByDriverId?: string,
) {
  return prisma.passenger.create({
    data: {
      user: {
        create: {
          name: email,
          email,
          phone: "21999991111",
          role: "PASSENGER",
        },
      },
      ...(referredByDriverId
        ? {
            referredByDriver: {
              connect: {
                id: referredByDriverId,
              },
            },
          }
        : {}),
    },
    include: {
      user: true,
    },
  });
}

describe("GET /drivers/:id/network", () => {
  it("requires an authenticated driver header", async () => {
    const driver = await createDriver("driver-auth@test.com");

    const response = await request(app)
      .get(`/drivers/${driver.id}/network`)
      .unset("x-driver-id");

    expect([401, 403]).toContain(response.status);

    expect(response.body).toHaveProperty("error");

    expect(response.body.error.toLowerCase()).toMatch(
      /auth|driver authentication required|forbidden/,
    );
  });

  it("forbids a driver from reading another driver network", async () => {
    const driver = await createDriver("driver-owner@test.com");

    const otherDriver = await createDriver("driver-other@test.com");

    expect(driver.id).not.toBe(otherDriver.id);

    const response = await request(app)
      .get(`/drivers/${driver.id}/network`)
      .set("x-driver-id", String(otherDriver.id));

    expect(response.status).toBe(403);

    expect(response.body).toEqual({
      error: "Driver cannot access another network",
    });
  });

  it("returns paginated linked passengers for the authenticated driver", async () => {
    const driver = await createDriver("driver-network@test.com");

    await createPassenger("network-1@test.com", driver.id);
    await createPassenger("network-2@test.com", driver.id);
    await createPassenger("network-3@test.com", driver.id);

    await createPassenger("outside-network@test.com");

    const response = await request(app)
      .get(`/drivers/${driver.id}/network?page=1&pageSize=2`)
      .set("x-driver-id", driver.id);

    expect(response.status).toBe(200);

    expect(response.body.totalPassengers).toBe(3);

    expect(response.body.page).toBe(1);

    expect(response.body.pageSize).toBe(2);

    expect(response.body.passengers).toHaveLength(2);

    expect(response.body.passengers[0]).toEqual(
      expect.objectContaining({
        referredByDriverId: driver.id,
        name: expect.any(String),
        email: expect.stringContaining("@test.com"),
        joinedAt: expect.any(String),
      }),
    );

    expect(
      response.body.passengers.every(
        (passenger: { referredByDriverId: string }) =>
          passenger.referredByDriverId === driver.id,
      ),
    ).toBe(true);
  });

  it("returns stats with totalPassengers and dynamic driver level counts", async () => {
    const driver = await createDriver("stats-owner@test.com");

    const level1a = await createDriver("stats-l1a@test.com");

    const level1b = await createDriver("stats-l1b@test.com");

    const level2 = await createDriver("stats-l2@test.com");

    await createDriverReferralChain(level1a.id, driver.id);

    await createDriverReferralChain(level1b.id, driver.id);

    await createDriverReferralChain(level2.id, level1a.id);

    await createPassenger("stats-p1@test.com", driver.id);

    await createPassenger("stats-p2@test.com", driver.id);

    const response = await request(app)
      .get(`/drivers/${driver.id}/network`)
      .set("x-driver-id", driver.id);

    expect(response.status).toBe(200);

    expect(response.body.stats.totalPassengers).toBe(2);

    // Estrutura dinâmica da rede
    expect(response.body.stats.levels.level1).toBe(2);

    expect(response.body.stats.levels.level2).toBe(1);
  });

  it("returns relations grouped dynamically by referral level", async () => {
    const driver = await createDriver("rel-owner@test.com");

    const level1 = await createDriver("rel-l1@test.com");

    const level2 = await createDriver("rel-l2@test.com");

    await createDriverReferralChain(level1.id, driver.id);

    await createDriverReferralChain(level2.id, level1.id);

    const response = await request(app)
      .get(`/drivers/${driver.id}/network`)
      .set("x-driver-id", driver.id);

    expect(response.status).toBe(200);

    const relations =
      response.body.relations ??
      response.body.network ??
      response.body.levels;

    expect(relations).toBeDefined();

    // Defensive: handle both object and array structures
    const level1Group =
      (relations.level1 ?? relations["1"] ?? []);
    const level2Group =
      (relations.level2 ?? relations["2"] ?? []);

    // If group is an object, get values
    const level1Ids = Array.isArray(level1Group)
      ? level1Group
      : Object.values(level1Group ?? {});
    const level2Ids = Array.isArray(level2Group)
      ? level2Group
      : Object.values(level2Group ?? {});

    // Debug output for troubleshooting
    if (!level1Ids.includes(level1.id)) {
      // eslint-disable-next-line no-console
      console.error('level1Ids:', JSON.stringify(level1Ids), 'expected:', level1.id);
    }
    if (!level2Ids.includes(level2.id)) {
      // eslint-disable-next-line no-console
      console.error('level2Ids:', JSON.stringify(level2Ids), 'expected:', level2.id);
      // Fail with a clear message
      throw new Error(`level2.id (${level2.id}) not found in level2Ids: ${JSON.stringify(level2Ids)}. Raw relations: ${JSON.stringify(relations)}`);
    }

    // Check that the correct driver IDs are present
    expect(level1Ids).toContain(level1.id);
    expect(level2Ids).toContain(level2.id);

    // Also check the raw response if possible
    if (response.body.relations && response.body.relations.level2) {
      const rel2 = Array.isArray(response.body.relations.level2) ? response.body.relations.level2 : Object.values(response.body.relations.level2);
      if (!rel2.includes(level2.id)) {
        // eslint-disable-next-line no-console
        console.error('Raw response.body.relations.level2:', JSON.stringify(rel2), 'expected:', level2.id);
      }
      expect(rel2).toContain(level2.id);
    }
  });
});