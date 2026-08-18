/**
 * Spec: network-context
 *
 * Tests for GET /network/context?actorId=&actorType=
 * Replaces the unconditional 410 Gone with real domain context resolution.
 */

import request from "supertest";
import bcrypt from "bcrypt";
import { ExperienceLevel } from "../../src/shared/enums";
import { prisma } from "../setup";
import { app } from "../../src/app";

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

async function makePassenger(email: string, referredByDriverId: string | null, rootDriverId: string | null) {
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
      referralCode: `rc-${u.id.slice(0, 8)}`,
      publicSlug: `ps-${u.id.slice(0, 8)}`,
      referredByDriverId: referredByDriverId ?? undefined,
      rootDriverId: rootDriverId ?? undefined,
    },
  });
}

describe("GET /network/context", () => {
  it("returns 400 when actorId is missing", async () => {
    const res = await request(app).get("/network/context?actorType=DRIVER");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actorId/i);
  });

  it("returns 400 when actorType is invalid", async () => {
    const res = await request(app).get("/network/context?actorId=some-id&actorType=ROBOT");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actorType/i);
  });

  it("returns 404 when driver does not exist", async () => {
    const res = await request(app).get("/network/context?actorId=00000000-0000-0000-0000-000000000000&actorType=DRIVER");
    expect(res.status).toBe(404);
  });

  it("returns 200 ACTIVE context for a root driver (no referredByDriverId)", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const driver = await makeDriver(`nc.root.${tag}@test.com`, ExperienceLevel.ELITE);

    const res = await request(app).get(`/network/context?actorId=${driver.id}&actorType=DRIVER`);
    expect(res.status).toBe(200);
    expect(res.body.flowType).toBe("DRIVER_TO_DRIVER");
    expect(res.body.genealogy.me.id).toBe(driver.id);
    expect(res.body.genealogy.me.actorType).toBe("driver");
    expect(res.body.rootDriver.id).toBe(driver.id);
    expect(res.body.capabilities).toBeDefined();
    expect(res.body.capabilities.canInviteDrivers).toBe(true); // ELITE
    expect(res.body.networkMetrics).toBeDefined();
  });

  it("accepts lowercase actorType (case-insensitive)", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const driver = await makeDriver(`nc.lower.${tag}@test.com`, ExperienceLevel.PROFISSIONAL);

    const res = await request(app).get(`/network/context?actorId=${driver.id}&actorType=driver`);
    expect(res.status).toBe(200);
    expect(res.body.flowType).toBe("DRIVER_TO_DRIVER");
  });

  it("returns 200 ACTIVE context for a passenger with rootDriverId", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const driver = await makeDriver(`nc.d.${tag}@test.com`, ExperienceLevel.ELITE);
    const passenger = await makePassenger(`nc.p.${tag}@test.com`, driver.id, driver.id);

    const res = await request(app).get(`/network/context?actorId=${passenger.id}&actorType=PASSENGER`);
    expect(res.status).toBe(200);
    expect(res.body.flowType).toBe("DRIVER_TO_PASSENGER");
    expect(res.body.rootDriver.id).toBe(driver.id);
    expect(res.body.genealogy.me.actorType).toBe("passenger");
  });

  it("returns 410 UNINITIALIZED when passenger has no root", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    // No referredByDriverId, no rootDriverId
    const passenger = await makePassenger(`nc.orphan.${tag}@test.com`, null, null);

    const res = await request(app).get(`/network/context?actorId=${passenger.id}&actorType=PASSENGER`);
    expect(res.status).toBe(410);
    expect(res.body.state).toBe("UNINITIALIZED");
    expect(res.body.reason).toBe("ROOT_DRIVER_NOT_PROPAGATED");
  });

  it("INICIANTE driver cannot invite other drivers", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const driver = await makeDriver(`nc.init.${tag}@test.com`, ExperienceLevel.INICIANTE);

    const res = await request(app).get(`/network/context?actorId=${driver.id}&actorType=DRIVER`);
    expect(res.status).toBe(200);
    expect(res.body.capabilities.canInviteDrivers).toBe(false);
  });
});
