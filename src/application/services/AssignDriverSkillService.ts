/**
 * Application Service: AssignDriverSkillService
 *
 * Stage 2.B leaf service. Promotes the idempotent `assignSkill` domain
 * function into the application layer and adds optional `SKILL_ASSIGNED`
 * event emission for the new DomainEventType taxonomy.
 *
 * Behavior of the underlying domain layer is preserved unchanged.
 *  - First call creates the DriverSkill row and emits SKILL_ASSIGNED
 *    (when a bus is provided).
 *  - Subsequent calls for the same (driverId, code) return the existing
 *    row and DO NOT emit a duplicate event.
 */

import type { DriverSkill } from "@prisma/client";
import { DomainEventType, DriverSkillCode } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { assignSkill } from "../../domain/skills/DriverSkillService";
import { EventBus, recordAndPublish } from "../../domain/shared/events/EventBus";

type Db = Pick<typeof prisma, "skill" | "driverSkill" | "driver" | "domainEvent">;

export interface AssignDriverSkillInput {
  driverId: string;
  code: DriverSkillCode;
  level?: number;
  metadata?: Record<string, unknown>;
}

export interface AssignDriverSkillResult {
  driverSkill: DriverSkill;
  created: boolean;
}

export interface AssignDriverSkillDeps {
  db?: Db;
  bus?: EventBus;
}

export async function execute(
  input: AssignDriverSkillInput,
  deps: AssignDriverSkillDeps = {}
): Promise<AssignDriverSkillResult> {
  const db = deps.db ?? prisma;

  // Detect "created" by comparing pre/post timestamps: if assignSkill returned
  // a row whose unlockedAt matches the post-call now-ish window, it's new.
  // Cheaper + race-safer: just check existence before calling.
  const before = await db.driverSkill
    .findFirst({
      where: { driverId: input.driverId, skill: { code: input.code } },
      select: { id: true },
    });

  const driverSkill = await assignSkill(input, db);
  const created = before === null;

  if (created && deps.bus) {
    await recordAndPublish(
      deps.bus,
      {
        type: DomainEventType.SKILL_ASSIGNED,
        aggregateType: "Driver",
        aggregateId: input.driverId,
        payload: {
          driverId: input.driverId,
          skillCode: input.code,
          level: driverSkill.level,
        },
      },
      db
    );
  }

  return { driverSkill, created };
}

export const AssignDriverSkillService = { execute };
