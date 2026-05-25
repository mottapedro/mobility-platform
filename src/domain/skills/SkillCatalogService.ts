import { DriverSkillCode, Skill } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import { SkillCatalogError } from "./errors";

type Db = Pick<typeof prisma, "skill">;

export async function findSkillByCode(
  code: DriverSkillCode,
  db: Db = prisma
): Promise<Skill | null> {
  return db.skill.findUnique({ where: { code } });
}

export async function requireSkillByCode(
  code: DriverSkillCode,
  db: Db = prisma
): Promise<Skill> {
  const skill = await findSkillByCode(code, db);
  if (!skill) {
    throw new SkillCatalogError(`Skill ${code} not found in catalogue`);
  }
  return skill;
}

export async function listActiveSkills(db: Db = prisma): Promise<Skill[]> {
  return db.skill.findMany({
    where: { isActive: true },
    orderBy: { code: "asc" },
  });
}
