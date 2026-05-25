import { DriverSkill, DriverSkillCode } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import { requireSkillByCode } from "./SkillCatalogService";

type Db = Pick<typeof prisma, "skill" | "driverSkill" | "driver">;

export interface AssignSkillInput {
  driverId: string;
  code: DriverSkillCode;
  level?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Idempotently assigns a skill to a driver.
 * Returns the existing row if (driverId, skillId) already exists.
 */
export async function assignSkill(
  input: AssignSkillInput,
  db: Db = prisma
): Promise<DriverSkill> {
  const skill = await requireSkillByCode(input.code, db);
  const existing = await db.driverSkill.findUnique({
    where: { driverId_skillId: { driverId: input.driverId, skillId: skill.id } },
  });
  if (existing) return existing;

  return db.driverSkill.create({
    data: {
      driverId: input.driverId,
      skillId: skill.id,
      level: input.level ?? 1,
      metadata: input.metadata ? (input.metadata as any) : null,
    },
  });
}

export interface DriverSkillDTO {
  code: DriverSkillCode;
  displayName: string;
  level: number;
  unlockedAt: Date;
}

export async function listDriverSkills(
  driverId: string,
  db: Db = prisma
): Promise<DriverSkillDTO[]> {
  const rows = await db.driverSkill.findMany({
    where: { driverId },
    include: { skill: true },
    orderBy: { unlockedAt: "asc" },
  });
  return rows.map((r) => ({
    code: r.skill.code,
    displayName: r.skill.displayName,
    level: r.level,
    unlockedAt: r.unlockedAt,
  }));
}

export async function findDriversBySkill(
  code: DriverSkillCode,
  db: Db = prisma
): Promise<string[]> {
  const skill = await requireSkillByCode(code, db);
  const rows = await db.driverSkill.findMany({
    where: { skillId: skill.id },
    select: { driverId: true },
  });
  return rows.map((r) => r.driverId);
}
