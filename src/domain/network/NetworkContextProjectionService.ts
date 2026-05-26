/**
 * NetworkContextProjectionService
 *
 * Builds the full NetworkContext aggregate consumed by
 * GET /network/context.
 *
 * Responsibilities:
 *  - Resolve genealogy (me, ancestors, descendants, lateral, operationalOwner)
 *  - Derive flowType from the actor's own ReferralRelationship record
 *  - Compute networkMetrics (totalActors, activeCount, depth)
 *  - Construct backend-governed inviteUrls
 *  - Delegate sub-queries to existing domain services
 *
 * NOT in scope: ridesFromNetwork, estimatedRevenue, growth (complex economic
 * aggregates — optional frontend fields deferred to a later iteration).
 */

import { ActorType, ExperienceLevel, ReferralFlowType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { resolveDriverRoot } from "../referral-network/DriverRootResolverService";
import { getOwnershipMetrics } from "../referral-network/NetworkOwnershipService";
import { listDriverSkills } from "../skills/DriverSkillService";
import { buildGenealogyProjection } from "../genealogy/BuildGenealogyProjectionService";
import { buildDescendantsTree } from "../genealogy/treeBuilder";
import {
  FlowType,
  Genealogy,
  NetworkActor,
  NetworkCapabilityContext,
  NetworkContext,
  NetworkDriverActor,
} from "./NetworkContextTypes";

const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL ??
  "https://mobility-platform-frontend.vercel.app";

// ── Enum bridge ───────────────────────────────────────────────────────────────

function prismaFlowToFrontend(ft: ReferralFlowType): FlowType {
  if (ft === ReferralFlowType.DRIVER_TO_DRIVER) return "DRIVER_TO_DRIVER";
  if (ft === ReferralFlowType.DRIVER_TO_PASSENGER) return "DRIVER_TO_PASSENGER";
  return "PASSENGER_TO_PASSENGER";
}

// ── Actor resolution helpers ──────────────────────────────────────────────────

async function resolveActorToNetworkActor(
  actorType: ActorType,
  actorId: string,
  db: typeof prisma
): Promise<NetworkActor | null> {
  if (actorType === ActorType.DRIVER) {
    const d = await db.driver.findUnique({
      where: { id: actorId },
      select: {
        id: true,
        publicSlug: true,
        createdAt: true,
        user: { select: { name: true } },
      },
    });
    if (!d) return null;
    return {
      id: d.id,
      actorType: "driver",
      name: d.user.name,
      slug: d.publicSlug,
      joinedAt: d.createdAt.toISOString(),
    };
  }

  const p = await db.passenger.findUnique({
    where: { id: actorId },
    select: {
      id: true,
      publicSlug: true,
      createdAt: true,
      user: { select: { name: true } },
    },
  });
  if (!p) return null;
  return {
    id: p.id,
    actorType: "passenger",
    name: p.user.name,
    slug: p.publicSlug,
    joinedAt: p.createdAt.toISOString(),
  };
}

// ── Ancestor chain walk ───────────────────────────────────────────────────────

/** Walk ReferralRelationship upward until no parent is found. Max 15 hops. */
async function walkAncestors(
  actorType: ActorType,
  actorId: string,
  db: typeof prisma
): Promise<NetworkActor[]> {
  const result: NetworkActor[] = [];
  let currentType = actorType;
  let currentId = actorId;
  const MAX_HOPS = 15;

  for (let step = 0; step < MAX_HOPS; step++) {
    const rel = await db.referralRelationship.findUnique({
      where: {
        invitedActorType_invitedId: {
          invitedActorType: currentType,
          invitedId: currentId,
        },
      },
      select: { inviterActorType: true, inviterId: true },
    });
    if (!rel) break;

    const ancestor = await resolveActorToNetworkActor(
      rel.inviterActorType,
      rel.inviterId,
      db
    );
    if (!ancestor) break;

    result.push(ancestor);
    currentType = rel.inviterActorType;
    currentId = rel.inviterId;
  }

  return result;
}

// ── Lateral siblings ──────────────────────────────────────────────────────────

/** Find actors that share the same parent inviter (excluding the actor itself). */
async function buildLateral(
  actorType: ActorType,
  actorId: string,
  db: typeof prisma
): Promise<NetworkActor[]> {
  const parentRel = await db.referralRelationship.findUnique({
    where: {
      invitedActorType_invitedId: { invitedActorType: actorType, invitedId: actorId },
    },
    select: { inviterActorType: true, inviterId: true },
  });
  if (!parentRel) return [];

  const siblings = await db.referralRelationship.findMany({
    where: {
      inviterActorType: parentRel.inviterActorType,
      inviterId: parentRel.inviterId,
      NOT: { invitedId: actorId },
    },
    select: { invitedActorType: true, invitedId: true },
    take: 20,
  });

  const actors = await Promise.all(
    siblings.map((s) => resolveActorToNetworkActor(s.invitedActorType, s.invitedId, db))
  );
  return actors.filter((a): a is NetworkActor => a !== null);
}

// ── Invite URL builder ────────────────────────────────────────────────────────

function buildDriverInviteUrls(
  publicSlug: string | null,
  referralCode: string | null
): { driverToPassenger: string; driverToDriver: string } | null {
  const ref = publicSlug ?? referralCode;
  if (!ref) return null;
  return {
    driverToPassenger: `${FRONTEND_BASE_URL}/onboarding/join?ref=${encodeURIComponent(ref)}`,
    driverToDriver: `${FRONTEND_BASE_URL}/onboarding/join?ref=${encodeURIComponent(ref)}&type=driver`,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build NetworkContext for a DRIVER actor.
 *
 * @param actorId      The driver's ID.
 * @param rootDriverId Pre-validated root driver ID (from resolveDriverRoot).
 * @param db           Prisma client (injectable for testing).
 */
export async function buildNetworkContextForDriver(
  actorId: string,
  rootDriverId: string,
  db: typeof prisma = prisma
): Promise<NetworkContext> {
  // Load actor record
  const driver = await db.driver.findUnique({
    where: { id: actorId },
    select: {
      id: true,
      experienceLevel: true,
      isActive: true,
      networkLevel: true,
      publicSlug: true,
      referralCode: true,
      createdAt: true,
      user: { select: { name: true } },
    },
  });
  if (!driver) throw new Error(`Driver ${actorId} not found`);

  // Load root driver details (may be self)
  const rootDriverRecord = await db.driver.findUnique({
    where: { id: rootDriverId },
    select: {
      id: true,
      publicSlug: true,
      createdAt: true,
      user: { select: { name: true } },
    },
  });
  const rootDriverActor: NetworkDriverActor | null = rootDriverRecord
    ? {
        id: rootDriverRecord.id,
        actorType: "driver",
        name: rootDriverRecord.user.name,
        slug: rootDriverRecord.publicSlug,
        joinedAt: rootDriverRecord.createdAt.toISOString(),
      }
    : null;

  // flowType: how was this actor invited? (absent for root drivers → default D2D)
  const invitationRel = await db.referralRelationship.findUnique({
    where: {
      invitedActorType_invitedId: {
        invitedActorType: ActorType.DRIVER,
        invitedId: actorId,
      },
    },
    select: { flowType: true },
  });
  const flowType: FlowType = invitationRel
    ? prismaFlowToFrontend(invitationRel.flowType)
    : "DRIVER_TO_DRIVER";

  // me node
  const me: NetworkActor = {
    id: driver.id,
    actorType: "driver",
    name: driver.user.name,
    slug: driver.publicSlug,
    joinedAt: driver.createdAt.toISOString(),
  };

  // Parallel: ancestors, lateral, full tree projection, ownership, skills
  const [ancestors, lateral, projection, ownership, skills] = await Promise.all([
    walkAncestors(ActorType.DRIVER, actorId, db),
    buildLateral(ActorType.DRIVER, actorId, db),
    buildGenealogyProjection(rootDriverId, { maxDepth: 5 }, db),
    getOwnershipMetrics(rootDriverId, {}, db),
    listDriverSkills(actorId, db).catch(() => [] as { code: string }[]),
  ]);

  // Convert flat tree projection to recursive descendants of actorId
  const descendants = buildDescendantsTree(
    projection.nodes,
    projection.edges,
    actorId,
    ActorType.DRIVER
  );

  const genealogy: Genealogy = {
    me,
    ancestors,
    descendants,
    lateral,
    operationalOwner: null,
  };

  const networkMetrics = {
    totalActors: ownership.totalDriversInTree + ownership.totalPassengersInTree,
    activeCount: ownership.totalDriversInTree,
    depth: projection.stats.maxDepth,
  };

  const level = driver.experienceLevel ?? "";
  const capabilities: NetworkCapabilityContext = {
    canInvitePassengers: driver.isActive,
    canInviteDrivers:
      driver.isActive &&
      (level === ExperienceLevel.PROFISSIONAL || level === ExperienceLevel.ELITE),
    canReceiveRewards: driver.isActive,
    canExpandNetwork: driver.isActive,
    skillCodes: skills.map((s) => s.code),
  };

  return {
    flowType,
    targetActorExpected: "driver",
    rootDriver: rootDriverActor,
    genealogy,
    networkMetrics,
    inviteUrls: buildDriverInviteUrls(driver.publicSlug, driver.referralCode),
    capabilities,
  };
}

/**
 * Build NetworkContext for a PASSENGER actor.
 *
 * @param actorId      The passenger's ID.
 * @param rootDriverId Pre-validated root driver ID (from resolveDriverRoot).
 * @param db           Prisma client (injectable for testing).
 */
export async function buildNetworkContextForPassenger(
  actorId: string,
  rootDriverId: string,
  db: typeof prisma = prisma
): Promise<NetworkContext> {
  const passenger = await db.passenger.findUnique({
    where: { id: actorId },
    select: {
      id: true,
      publicSlug: true,
      referralCode: true,
      networkLevel: true,
      referredByDriverId: true,
      createdAt: true,
      user: { select: { name: true } },
    },
  });
  if (!passenger) throw new Error(`Passenger ${actorId} not found`);

  // Load root driver details
  const rootDriverRecord = await db.driver.findUnique({
    where: { id: rootDriverId },
    select: {
      id: true,
      publicSlug: true,
      createdAt: true,
      user: { select: { name: true } },
    },
  });
  const rootDriverActor: NetworkDriverActor | null = rootDriverRecord
    ? {
        id: rootDriverRecord.id,
        actorType: "driver",
        name: rootDriverRecord.user.name,
        slug: rootDriverRecord.publicSlug,
        joinedAt: rootDriverRecord.createdAt.toISOString(),
      }
    : null;

  // flowType from passenger's invitation record
  const invitationRel = await db.referralRelationship.findUnique({
    where: {
      invitedActorType_invitedId: {
        invitedActorType: ActorType.PASSENGER,
        invitedId: actorId,
      },
    },
    select: { flowType: true },
  });
  const flowType: FlowType = invitationRel
    ? prismaFlowToFrontend(invitationRel.flowType)
    : "DRIVER_TO_PASSENGER";

  // me node
  const me: NetworkActor = {
    id: passenger.id,
    actorType: "passenger",
    name: passenger.user.name,
    slug: passenger.publicSlug,
    joinedAt: passenger.createdAt.toISOString(),
  };

  // operationalOwner: driver who directly referred this passenger
  let operationalOwner: NetworkDriverActor | null = null;
  if (passenger.referredByDriverId) {
    const refDriver = await db.driver.findUnique({
      where: { id: passenger.referredByDriverId },
      select: {
        id: true,
        publicSlug: true,
        createdAt: true,
        user: { select: { name: true } },
      },
    });
    if (refDriver) {
      operationalOwner = {
        id: refDriver.id,
        actorType: "driver",
        name: refDriver.user.name,
        slug: refDriver.publicSlug,
        joinedAt: refDriver.createdAt.toISOString(),
      };
    }
  }

  // Parallel: ancestors, lateral, ownership
  const [ancestors, lateral, ownership] = await Promise.all([
    walkAncestors(ActorType.PASSENGER, actorId, db),
    buildLateral(ActorType.PASSENGER, actorId, db),
    getOwnershipMetrics(rootDriverId, {}, db),
  ]);

  const genealogy: Genealogy = {
    me,
    ancestors,
    descendants: [], // Passengers are leaf nodes in this model
    lateral,
    operationalOwner,
  };

  const networkMetrics = {
    totalActors: ownership.totalDriversInTree + ownership.totalPassengersInTree,
    activeCount: ownership.totalDriversInTree,
    depth: ancestors.length,
  };

  const ref = passenger.publicSlug ?? passenger.referralCode;
  const inviteUrls = ref
    ? {
        driverToPassenger: `${FRONTEND_BASE_URL}/onboarding/join?ref=${encodeURIComponent(ref)}`,
      }
    : null;

  const capabilities: NetworkCapabilityContext = {
    canInvitePassengers: !!ref,
    canInviteDrivers: false,
    canReceiveRewards: true,
    canExpandNetwork: !!ref,
    skillCodes: [],
  };

  return {
    flowType,
    targetActorExpected: "passenger",
    rootDriver: rootDriverActor,
    genealogy,
    networkMetrics,
    inviteUrls,
    capabilities,
  };
}
