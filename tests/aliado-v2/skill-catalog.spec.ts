import { DriverSkillCode } from "../../src/shared/enums";
import { prisma } from "../setup";
import {
  findSkillByCode,
  listActiveSkills,
} from "../../src/domain/skills/SkillCatalogService";

describe("SkillCatalogService", () => {
  it("has all 7 catalogue rows seeded by migration", async () => {
    const all = await prisma.skill.findMany();
    expect(all.length).toBeGreaterThanOrEqual(7);
    const codes = all.map((s) => s.code);
    for (const expected of Object.values(DriverSkillCode)) {
      expect(codes).toContain(expected);
    }
  });

  it("findSkillByCode returns COLECIONADOR", async () => {
    const row = await findSkillByCode(DriverSkillCode.COLECIONADOR);
    expect(row).not.toBeNull();
    expect(row!.code).toBe(DriverSkillCode.COLECIONADOR);
  });

  it("listActiveSkills returns only active rows", async () => {
    const rows = await listActiveSkills();
    expect(rows.every((r) => r.isActive)).toBe(true);
  });
});
