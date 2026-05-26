import type { ReferralRelationship } from "@prisma/client";
import { ActorType, ReferralFlowType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";

type Db = Pick<typeof prisma, "passenger" | "referralRelationship">;

export interface LineageAncestor {
  actorType: ActorType;
  id: string;
  level: number;
}

export interface PassengerLineage {
  passengerId: string;
  rootDriverId: string;
  flowType: ReferralFlowType | null;
  ancestors: LineageAncestor[];
  /** Top-down path from rootDriver down to the passenger itself. */
  lineagePath: string[];
}

const MAX_DEPTH = 32;

/**
 * Reconstructs the passenger's ancestry by walking the ReferralRelationship
 * graph backwards from (PASSENGER, passengerId) until reaching a DRIVER inviter.
 * Falls back to Passenger.rootDriverId when no relationship row exists.
 */
export async function getPassengerLineage(
  passengerId: string,
  db: Db = prisma
): Promise<PassengerLineage> {
  const passenger = await db.passenger.findUnique({
    where: { id: passengerId },
    select: { id: true, rootDriverId: true },
  });
  if (!passenger) {
    throw new Error(`Passenger ${passengerId} not found`);
  }

  const ancestors: LineageAncestor[] = [];
  const visited = new Set<string>([`${ActorType.PASSENGER}:${passengerId}`]);

  let cursorActorType: ActorType = ActorType.PASSENGER;
  let cursorId: string = passengerId;
  let firstFlowType: ReferralFlowType | null = null;
  let rootDriverId: string | null = passenger.rootDriverId ?? null;
  let level = 1;

  while (level <= MAX_DEPTH) {
    const row: ReferralRelationship | null = await db.referralRelationship.findUnique({
      where: {
        invitedActorType_invitedId: {
          invitedActorType: cursorActorType,
          invitedId: cursorId,
        },
      },
    });
    if (!row) break;

    if (firstFlowType === null) firstFlowType = row.flowType;
    rootDriverId = row.rootDriverId;

    const key = `${row.inviterActorType}:${row.inviterId}`;
    if (visited.has(key)) {
      throw new Error(
        `Cycle detected in passenger lineage at ${key} (depth ${level})`
      );
    }
    visited.add(key);

    ancestors.push({
      actorType: row.inviterActorType,
      id: row.inviterId,
      level,
    });

    if (row.inviterActorType === ActorType.DRIVER) break;

    cursorActorType = row.inviterActorType;
    cursorId = row.inviterId;
    level += 1;
  }

  if (level > MAX_DEPTH) {
    throw new Error(`Lineage walk exceeded MAX_DEPTH=${MAX_DEPTH} (suspected cycle)`);
  }

  if (!rootDriverId) {
    throw new Error(`Passenger ${passengerId} has no rootDriverId`);
  }

  const lineagePath: string[] = [
    `${ActorType.DRIVER}:${rootDriverId}`,
    ...[...ancestors]
      .reverse()
      .filter((a) => !(a.actorType === ActorType.DRIVER && a.id === rootDriverId))
      .map((a) => `${a.actorType}:${a.id}`),
    `${ActorType.PASSENGER}:${passengerId}`,
  ];

  return {
    passengerId,
    rootDriverId,
    flowType: firstFlowType,
    ancestors,
    lineagePath,
  };
}
