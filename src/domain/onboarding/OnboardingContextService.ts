import type { Driver, Invite, Passenger } from "@prisma/client";
import { ActorType, ReferralFlowType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { resolveReferralFlowType } from "../referral-network/ReferralFlowResolverService";
import { resolveDriverRoot } from "../referral-network/DriverRootResolverService";
import {
  getPassengerLineage,
  PassengerLineage,
} from "../referral-network/PassengerLineageService";
import {
  getOwnershipMetrics,
  OwnershipMetrics,
} from "../referral-network/NetworkOwnershipService";

type Db = Pick<
  typeof prisma,
  "invite" | "driver" | "driverReferral" | "passenger" | "referralRelationship" | "rideRequest" | "revenueSplit"
>;

export type OnboardingSource =
  | "invite"
  | "driver_referral_code"
  | "driver_public_slug"
  | "passenger_referral_code"
  | "passenger_public_slug";

export interface OnboardingInviterSnapshot {
  actorType: ActorType;
  id: string;
}

export interface OnboardingRootDriverSnapshot {
  id: string;
  name: string;
}

/**
 * Portable invite summary returned to the frontend for every 200 response.
 * Built synthetically for referral-code / public-slug paths (no Invite row
 * needed) and from the Invite record when one exists.
 */
export interface OnboardingContextInvite {
  /** Referral code or invite slug the backend accepts on POST /auth/register. */
  code: string;
  /** Display label fully formatted by the backend — no client-side formatting. */
  displayLabel: string;
  inviter: {
    actorType: ActorType;
    id: string;
    name: string;
  };
}

export interface OnboardingContext {
  source: OnboardingSource;
  slug: string;
  flowType: ReferralFlowType;
  expectedActor: ActorType;
  inviter: OnboardingInviterSnapshot;
  rootDriver: OnboardingRootDriverSnapshot | null;
  invite: OnboardingContextInvite | null;
  lineage: PassengerLineage | null;
  ownership: OwnershipMetrics | null;
}

export class OnboardingContextError extends Error {}

/**
 * Resolves the public-facing onboarding context for a given slug or referral
 * code. Lookup order:
 *  1. Invite.slug
 *  2. Invite.token
 *  3. Driver.referralCode
 *  4. Driver.publicSlug
 *  5. Passenger.referralCode
 *  6. Passenger.publicSlug
 */
export async function resolveOnboardingContext(
  slugOrCode: string,
  db: Db = prisma
): Promise<OnboardingContext> {
  const invite =
    (await db.invite.findUnique({ where: { slug: slugOrCode } })) ??
    (await db.invite.findUnique({ where: { token: slugOrCode } }));

  if (invite) {
    if (invite.consumedAt) {
      throw new OnboardingContextError(
        `Invite ${invite.slug} already consumed at ${invite.consumedAt.toISOString()}`
      );
    }
    if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
      throw new OnboardingContextError(`Invite ${invite.slug} expired`);
    }
    // TODO(Sprint 2): fetch owner name and build OnboardingContextInvite
    // for Invite-record path. Currently unused in production — synthetic
    // invite is built for driver/passenger referral-code paths instead.
    return buildContext(
      "invite",
      invite.slug,
      invite.expectedFlowType,
      invite.expectedActorType,
      invite.ownerActorType,
      invite.ownerId,
      null,
      db
    );
  }

  const driverByCode = await db.driver.findUnique({
    where: { referralCode: slugOrCode },
    include: { user: { select: { name: true } } },
  });
  if (driverByCode) {
    return contextFromDriver("driver_referral_code", slugOrCode, driverByCode, db);
  }

  const driverBySlug = await db.driver.findUnique({
    where: { publicSlug: slugOrCode },
    include: { user: { select: { name: true } } },
  });
  if (driverBySlug) {
    return contextFromDriver("driver_public_slug", slugOrCode, driverBySlug, db);
  }

  const passengerByCode = await db.passenger.findUnique({
    where: { referralCode: slugOrCode },
    include: { user: { select: { name: true } } },
  });
  if (passengerByCode) {
    return contextFromPassenger("passenger_referral_code", slugOrCode, passengerByCode, db);
  }

  const passengerBySlug = await db.passenger.findUnique({
    where: { publicSlug: slugOrCode },
    include: { user: { select: { name: true } } },
  });
  if (passengerBySlug) {
    return contextFromPassenger("passenger_public_slug", slugOrCode, passengerBySlug, db);
  }

  throw new OnboardingContextError(`Onboarding slug not found: ${slugOrCode}`);
}

async function contextFromDriver(
  source: OnboardingSource,
  slug: string,
  driver: Driver & { user: { name: string } },
  db: Db
): Promise<OnboardingContext> {
  const expectedActor = ActorType.PASSENGER;
  const flowType = resolveReferralFlowType(ActorType.DRIVER, expectedActor);
  const syntheticInvite: OnboardingContextInvite = {
    code: driver.referralCode,
    displayLabel: `Convite de ${driver.user.name}`,
    inviter: { actorType: ActorType.DRIVER, id: driver.id, name: driver.user.name },
  };
  return buildContext(
    source,
    slug,
    flowType,
    expectedActor,
    ActorType.DRIVER,
    driver.id,
    syntheticInvite,
    db
  );
}

async function contextFromPassenger(
  source: OnboardingSource,
  slug: string,
  passenger: Passenger & { user: { name: string } },
  db: Db
): Promise<OnboardingContext> {
  const expectedActor = ActorType.PASSENGER;
  const flowType = resolveReferralFlowType(ActorType.PASSENGER, expectedActor);
  const code = passenger.referralCode ?? passenger.publicSlug ?? slug;
  const syntheticInvite: OnboardingContextInvite = {
    code,
    displayLabel: `Convite de ${passenger.user.name}`,
    inviter: { actorType: ActorType.PASSENGER, id: passenger.id, name: passenger.user.name },
  };
  return buildContext(
    source,
    slug,
    flowType,
    expectedActor,
    ActorType.PASSENGER,
    passenger.id,
    syntheticInvite,
    db
  );
}

async function buildContext(
  source: OnboardingSource,
  slug: string,
  flowType: ReferralFlowType,
  expectedActor: ActorType,
  inviterActorType: ActorType,
  inviterId: string,
  invite: OnboardingContextInvite | null,
  db: Db
): Promise<OnboardingContext> {
  const rootDriverId = await resolveDriverRoot(inviterActorType, inviterId, db);

  let lineage: PassengerLineage | null = null;
  if (inviterActorType === ActorType.PASSENGER) {
    try {
      lineage = await getPassengerLineage(inviterId, db);
    } catch {
      lineage = null;
    }
  }

  let ownership: OwnershipMetrics | null = null;
  if (rootDriverId) {
    ownership = await getOwnershipMetrics(rootDriverId, {}, db);
  }

  let rootDriver: OnboardingRootDriverSnapshot | null = null;
  if (rootDriverId) {
    const rootDriverRow = await db.driver.findUnique({
      where: { id: rootDriverId },
      include: { user: true },
    });
    rootDriver = rootDriverRow ? { id: rootDriverId, name: rootDriverRow.user.name } : null;
  }

  return {
    source,
    slug,
    flowType,
    expectedActor,
    inviter: { actorType: inviterActorType, id: inviterId },
    rootDriver,
    invite,
    lineage,
    ownership,
  };
}
