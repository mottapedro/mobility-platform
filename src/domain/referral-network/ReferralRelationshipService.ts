import type { ReferralRelationship } from "@prisma/client";
import { ActorType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { resolveReferralFlowType } from "./ReferralFlowResolverService";
import { resolveDriverRoot } from "./DriverRootResolverService";
import { ReferralRelationshipError } from "./errors";
import { RootOwnershipProjectionService } from "../ownership/RootOwnershipProjectionService";

type Db = typeof prisma;

export interface RecordRelationshipInput {
  inviterActorType: ActorType;
  inviterId: string;
  invitedActorType: ActorType;
  invitedId: string;
}

/**
 * Idempotently records a referral relationship in the V2 graph.
 *
 *  - Resolves the canonical ReferralFlowType.
 *  - Resolves the operational rootDriverId via DriverRootResolverService.
 *  - Sets `inviterDriverId` when the inviter is a DRIVER (for query convenience).
 *  - Idempotent: if a relationship for (invitedActorType, invitedId) already
 *    exists, returns it without writing.
 */
export async function recordRelationship(
  input: RecordRelationshipInput,
  db: Db = prisma
): Promise<ReferralRelationship> {
  if (
    input.inviterActorType === input.invitedActorType &&
    input.inviterId === input.invitedId
  ) {
    throw new ReferralRelationshipError("Self-referral is not allowed");
  }

  const existing = await db.referralRelationship.findUnique({
    where: {
      invitedActorType_invitedId: {
        invitedActorType: input.invitedActorType,
        invitedId: input.invitedId,
      },
    },
  });
  if (existing) return existing;

  const flowType = resolveReferralFlowType(
    input.inviterActorType,
    input.invitedActorType
  );

  const rootDriverId = await resolveDriverRoot(
    input.inviterActorType,
    input.inviterId,
    db
  );
  if (!rootDriverId) {
    throw new ReferralRelationshipError(
      `Could not resolve operational root driver for inviter ${input.inviterActorType}:${input.inviterId}`
    );
  }

  const relationship = await db.referralRelationship.create({
    data: {
      flowType,
      inviterActorType: input.inviterActorType,
      inviterId: input.inviterId,
      invitedActorType: input.invitedActorType,
      invitedId: input.invitedId,
      rootDriverId,
      inviterDriverId:
        input.inviterActorType === ActorType.DRIVER ? input.inviterId : null,
    },
  });

  // Synchronous ownership projection: passenger must have rootDriverId immediately.
  if (input.invitedActorType === ActorType.PASSENGER) {
    await RootOwnershipProjectionService.projectPassengerOwnership(
      input.invitedId,
      db
    ).catch((err) => {
      console.warn("[ReferralRelationship] passenger ownership projection failed", err);
    });
  }

  return relationship;
}

/**
 * Lists relationships rooted at a driver, with optional flow filter.
 */
export async function listRelationshipsForRoot(
  rootDriverId: string,
  options: { flowType?: import("@prisma/client").ReferralFlowType } = {},
  db: Db = prisma
): Promise<ReferralRelationship[]> {
  return db.referralRelationship.findMany({
    where: {
      rootDriverId,
      ...(options.flowType ? { flowType: options.flowType } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
}
