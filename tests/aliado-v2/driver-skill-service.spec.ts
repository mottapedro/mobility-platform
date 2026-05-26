import bcrypt from "bcrypt";
import { DriverSkillCode } from "../../src/shared/enums";
import { prisma } from "../setup";
import {
  assignSkill,
  findDriversBySkill,
  listDriverSkills,
} from "../../src/domain/skills/DriverSkillService";

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

describe("DriverSkillService", () => {
  it("assignSkill is idempotent on (driverId, skillId)", async () => {
    const d = await makeDriver("skill.idem@test.com");
    const a = await assignSkill({ driverId: d.id, code: DriverSkillCode.COLECIONADOR });
    const b = await assignSkill({ driverId: d.id, code: DriverSkillCode.COLECIONADOR });
    expect(a.id).toBe(b.id);
  });

  it("listDriverSkills returns DTO with code and unlockedAt", async () => {
    const d = await makeDriver("skill.list@test.com");
    await assignSkill({ driverId: d.id, code: DriverSkillCode.EXECUTIVO });
    const rows = await listDriverSkills(d.id);
    expect(rows.length).toBe(1);
    expect(rows[0].code).toBe(DriverSkillCode.EXECUTIVO);
    expect(rows[0].unlockedAt).toBeInstanceOf(Date);
  });

  it("findDriversBySkill returns assigned driver ids", async () => {
    const d1 = await makeDriver("skill.find1@test.com");
    const d2 = await makeDriver("skill.find2@test.com");
    await assignSkill({ driverId: d1.id, code: DriverSkillCode.VIP });
    await assignSkill({ driverId: d2.id, code: DriverSkillCode.VIP });
    const ids = await findDriversBySkill(DriverSkillCode.VIP);
    expect(ids).toEqual(expect.arrayContaining([d1.id, d2.id]));
  });
});
