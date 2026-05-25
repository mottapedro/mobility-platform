import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";
import { createDriverReferralChain } from "../src/domain/services/DriverReferralService";



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
  const slug = email.replace(/[@.]/g, "-") + "-" + Date.now();
  return prisma.passenger.create({
    data: {
      referralCode: slug,
      publicSlug: slug,
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
  it("is publicly accessible without an auth header", async () => {
    const driver = await createDriver("driver-auth@test.com");

    const response = await request(app)
      .get(`/drivers/${driver.id}/network`)
      .unset("x-driver-id");

    // The network endpoint is a public read endpoint — no auth required
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("levels");
    expect(response.body).toHaveProperty("summary");
  });

  it("allows any caller to read a driver's public network", async () => {
    const driver = await createDriver("driver-owner@test.com");
    const otherDriver = await createDriver("driver-other@test.com");
    expect(driver.id).not.toBe(otherDriver.id);
    const response = await request(app)
      .get(`/drivers/${driver.id}/network`)
      .set("x-driver-id", String(otherDriver.id));
    // The network endpoint is public — all callers receive the snapshot
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("driverId", driver.id);
  });

  it("returns passenger count in summary for the driver's network", async () => {
    const driver = await createDriver("driver-network@test.com");

    await createPassenger("network-1@test.com", driver.id);
    await createPassenger("network-2@test.com", driver.id);
    await createPassenger("network-3@test.com", driver.id);

    await createPassenger("outside-network@test.com");

    const response = await request(app)
      .get(`/drivers/${driver.id}/network`)
      .set("x-driver-id", driver.id);

    expect(response.status).toBe(200);

    // The network snapshot returns passenger counts inside summary.referredPassengers
    expect(response.body.summary.referredPassengers.direct).toBe(3);
    expect(response.body.summary.referredPassengers.total).toBeGreaterThanOrEqual(3);

    // Levels structure is always present
    expect(response.body.levels).toBeDefined();
    expect(Array.isArray(response.body.levels.level1)).toBe(true);
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
    // The snapshot returns stats inside summary.referredDrivers and summary.referredPassengers
    const driverStats = response.body.summary.referredDrivers;
    expect(driverStats.level1).toBe(2); // level1a + level1b
    expect(driverStats.level2).toBe(1); // level2 (through level1a)
    const passengerStats = response.body.summary.referredPassengers;
    expect(passengerStats.direct).toBe(2); // stats-p1 + stats-p2
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
    const level1Group = relations.level1 ?? relations["1"] ?? [];
    const level2Group = relations.level2 ?? relations["2"] ?? [];
    // If group is an array of objects, extract driverId
    const level1Ids = Array.isArray(level1Group)
      ? level1Group.map((d: any) => d.driverId || d.id || d)
      : Object.values(level1Group ?? {}).map((d: any) => d.driverId || d.id || d);
    const level2Ids = Array.isArray(level2Group)
      ? level2Group.map((d: any) => d.driverId || d.id || d)
      : Object.values(level2Group ?? {}).map((d: any) => d.driverId || d.id || d);
    expect(level1Ids).toContain(level1.id);
    expect(level2Ids).toContain(level2.id);
    // Also check the raw response if possible
    if (response.body.relations && response.body.relations.level2) {
      const rel2 = Array.isArray(response.body.relations.level2)
        ? response.body.relations.level2.map((d: any) => d.driverId || d.id || d)
        : Object.values(response.body.relations.level2).map((d: any) => d.driverId || d.id || d);
      expect(rel2).toContain(level2.id);
    }
  });
});