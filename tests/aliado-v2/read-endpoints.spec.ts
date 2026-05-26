import bcrypt from "bcrypt";
import request from "supertest";
import { ActorType, DriverSkillCode } from "../../src/shared/enums";
import { app } from "../../src/app";
import { prisma } from "../setup";
import { recordRelationship } from "../../src/domain/referral-network/ReferralRelationshipService";
import { assignSkill } from "../../src/domain/skills/DriverSkillService";

async function makeDriver(email: string) {
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
    data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

describe("Read endpoints", () => {
  it("GET /drivers/:driverId/network/relationships returns expected shape", async () => {
    const root = await makeDriver("read.root@test.com");
    const c1 = await makeDriver("read.c1@test.com");
    await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedActorType: ActorType.DRIVER,
      invitedId: c1.id,
    });

    const res = await request(app).get(`/drivers/${root.id}/network/relationships`);
    expect(res.status).toBe(200);
    expect(res.body.driverId).toBe(root.id);
    expect(res.body.totals).toEqual(
      expect.objectContaining({
        total: 1,
        driverToDriver: 1,
        driverToPassenger: 0,
        passengerToPassenger: 0,
      })
    );
    expect(Array.isArray(res.body.relationships)).toBe(true);
    expect(res.body.relationships[0].invited.id).toBe(c1.id);
  });

  it("GET /drivers/:driverId/skills returns assigned skill DTOs", async () => {
    const d = await makeDriver("read.skills@test.com");
    await assignSkill({ driverId: d.id, code: DriverSkillCode.VIP });

    const res = await request(app).get(`/drivers/${d.id}/skills`);
    expect(res.status).toBe(200);
    expect(res.body.driverId).toBe(d.id);
    expect(res.body.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: DriverSkillCode.VIP }),
      ])
    );
  });

  it("GET /godnetwork/status returns a conformance shape", async () => {
    const res = await request(app).get("/godnetwork/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        rootDriverId: expect.anything(),
        structure: expect.objectContaining({
          expectedLevel1Count: 4,
          expectedLevel2UnderJoaoCount: 6,
          expectedTotalClosureEdgesFromRoot: 10,
        }),
        deviations: expect.any(Array),
        officialStructure: expect.any(Object),
      })
    );
  });
});
