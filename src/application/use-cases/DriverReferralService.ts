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

  for (const ancestor of ancestorEntries) {
    const newLevel = ancestor.level + 1;
    if (newLevel > 3) continue;

    await prisma.driverReferral.upsert({
      where: {
        referrerDriverId_referredDriverId: {
          referrerDriverId: ancestor.referrerDriverId,
          referredDriverId: driverId,
        },
      },
      create: {
        referrerDriverId: ancestor.referrerDriverId,
        referredDriverId: driverId,
        level: newLevel,
      },
      update: {},
    });

    console.log(
      `🔗 Referral chain: nível ${newLevel} criado (${ancestor.referrerDriverId} → ${driverId})`
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
