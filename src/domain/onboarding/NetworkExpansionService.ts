import type { ReferralRelationship } from "@prisma/client";
import { ActorType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { recordRelationship } from "../referral-network/ReferralRelationshipService";

type Db = Pick<
  typeof prisma,
  "$transaction" | "invite" | "passenger" | "driver" | "referralRelationship" | "driverReferral"
>;

export class NetworkExpansionError extends Error {}

export interface ExpandNetworkInput {
  slug: string;
  invitedActorType: ActorType;
  invitedId: string;
}

export interface ExpandNetworkResult {
  inviteId: string;
  relationship: ReferralRelationship;
}

/**
 * Consumes an invite slug and records the corresponding ReferralRelationship,
 * propagating rootDriverId to a Passenger when applicable.
 */
export async function expandNetworkFromInvite(
  input: ExpandNetworkInput,
  db: Db = prisma
): Promise<ExpandNetworkResult> {
  const invite = await db.invite.findUnique({ where: { slug: input.slug } });
  if (!invite) {
    throw new NetworkExpansionError(`Invite slug not found: ${input.slug}`);
  }
  if (invite.consumedAt) {
    throw new NetworkExpansionError(`Invite ${invite.slug} already consumed`);
  }
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
    throw new NetworkExpansionError(`Invite ${invite.slug} expired`);
  }
  if (invite.expectedActorType !== input.invitedActorType) {
    throw new NetworkExpansionError(
      `Invite ${invite.slug} expects ${invite.expectedActorType} but received ${input.invitedActorType}`
    );
  }

  const relationship = await recordRelationship(
    {
      inviterActorType: invite.ownerActorType,
      inviterId: invite.ownerId,
      invitedActorType: input.invitedActorType,
      invitedId: input.invitedId,
    },
    db
  );

  if (input.invitedActorType === ActorType.PASSENGER) {
    await db.passenger.update({
      where: { id: input.invitedId },
      data: { rootDriverId: relationship.rootDriverId },
    });
  }

  const invitedUserId = await resolveInvitedUserId(input, db);
  await db.invite.update({
    where: { id: invite.id },
    data: {
      consumedAt: new Date(),
      consumedByUserId: invitedUserId,
    },
  });

  return { inviteId: invite.id, relationship };
}

async function resolveInvitedUserId(
  input: ExpandNetworkInput,
  db: Db
): Promise<string | null> {
  if (input.invitedActorType === ActorType.DRIVER) {
    const d = await db.driver.findUnique({
      where: { id: input.invitedId },
      select: { userId: true },
    });
    return d?.userId ?? null;
  }
  const p = await db.passenger.findUnique({
    where: { id: input.invitedId },
    select: { userId: true },
  });
  return p?.userId ?? null;
}
