import { prisma } from "../../infra/prisma/client";

/**
 * Builds the multi-level referral chain in DriverReferral when a new driver
 * joins via a referral link.
 *
 * - Level 1 entry: referrer → newDriver
 * - Level 2 entry: referrer's referrer → newDriver  (if exists)
 * - Level 3 entry: referrer's referrer's referrer → newDriver (if exists)
 */
export async function createDriverReferralChain(
  driverId: string,
  referrerId: string
): Promise<void> {
  // Level 1: direct referral
  await prisma.driverReferral.upsert({
    where: {
      referrerDriverId_referredDriverId: {
        referrerDriverId: referrerId,
        referredDriverId: driverId,
      },
    },
    create: { referrerDriverId: referrerId, referredDriverId: driverId, level: 1 },
    update: {},
  });

  console.log(`🔗 Referral chain: nível 1 criado (${referrerId} → ${driverId})`);

  // Walk up the referrer's own ancestry (levels 2 and 3)
  const ancestorEntries = await prisma.driverReferral.findMany({
    where: { referredDriverId: referrerId },
    select: { referrerDriverId: true, level: true },
  });

  const ancestorsByLevel = new Map<string, number>();

  for (const ancestor of ancestorEntries) {
    const newLevel = ancestor.level + 1;
    if (newLevel > 3) continue;
    const existingLevel = ancestorsByLevel.get(ancestor.referrerDriverId);
    if (!existingLevel || newLevel < existingLevel) {
      ancestorsByLevel.set(ancestor.referrerDriverId, newLevel);
    }
  }

  // Fallback para legado: walk via Driver.referredByDriverId quando a rede
  // ainda não foi totalmente preenchida em DriverReferral.
  const visited = new Set<string>([referrerId]);
  let currentId: string | null = referrerId;
  let distanceFromReferrer = 0;
  while (currentId && distanceFromReferrer < 2) {
    const currentDriver: { referredByDriverId: string | null } | null =
      await prisma.driver.findUnique({
      where: { id: currentId },
      select: { referredByDriverId: true },
    });
    const parentId: string | null = currentDriver?.referredByDriverId ?? null;
    if (!parentId || visited.has(parentId)) break;

    visited.add(parentId);
    distanceFromReferrer += 1;
    const newLevel = distanceFromReferrer + 1; // parent of referrer => nível 2
    const existingLevel = ancestorsByLevel.get(parentId);
    if (!existingLevel || newLevel < existingLevel) {
      ancestorsByLevel.set(parentId, newLevel);
    }
    currentId = parentId;
  }

  for (const [ancestorId, newLevel] of ancestorsByLevel) {
    await prisma.driverReferral.upsert({
      where: {
        referrerDriverId_referredDriverId: {
          referrerDriverId: ancestorId,
          referredDriverId: driverId,
        },
      },
      create: {
        referrerDriverId: ancestorId,
        referredDriverId: driverId,
        level: newLevel,
      },
      update: {},
    });

    console.log(
      `🔗 Referral chain: nível ${newLevel} criado (${ancestorId} → ${driverId})`
    );
  }
}

/**
 * Represents the referral network of a driver grouped by level.
 * Each array contains the IDs of drivers at that distance from the referrer:
 * - level1: drivers directly referred by the referrer
 * - level2: drivers referred by the referrer's direct referrals
 * - level3: drivers referred by the referrer's level-2 referrals
 */
export interface DriverNetwork {
  level1: string[];
  level2: string[];
  level3: string[];
}

/**
 * Returns the referral network for a given driver (the referrer).
 * Each level contains the IDs of drivers that the referrer can "claim"
 * at that distance.
 *
 * - level1: drivers directly referred by the referrer
 * - level2: drivers referred by the referrer's direct referrals
 * - level3: drivers referred by the referrer's level-2 referrals
 */
export async function getDriverNetwork(
  referrerDriverId: string
): Promise<DriverNetwork> {
  const entries = await prisma.driverReferral.findMany({
    where: { referrerDriverId },
    select: { referredDriverId: true, level: true },
  });

  return {
    level1: entries.filter((e) => e.level === 1).map((e) => e.referredDriverId),
    level2: entries.filter((e) => e.level === 2).map((e) => e.referredDriverId),
    level3: entries.filter((e) => e.level === 3).map((e) => e.referredDriverId),
  };
}
