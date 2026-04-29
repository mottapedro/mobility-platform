import { prisma } from "../../infra/prisma/client";

/**
 * Creates a referral chain when a new driver joins via referral.
 * - Level 1: direct referral (referrerId → driverId)
 * - Level 2: if referrerId was also referred by someone, that person gets a level-2 link to driverId
 * - Level 3: one more step up the chain
 *
 * @param driverId   ID of the newly created driver
 * @param referrerId ID of the driver who referred the new driver
 */
export async function createDriverReferralChain(
  driverId: string,
  referrerId: string
): Promise<void> {
  // Level 1 — direct referral
  await prisma.driverReferral.upsert({
    where: {
      referrerDriverId_referredDriverId: {
        referrerDriverId: referrerId,
        referredDriverId: driverId,
      },
    },
    create: {
      referrerDriverId: referrerId,
      referredDriverId: driverId,
      level: 1,
    },
    update: {},
  });

  console.log(`🔗 Referral chain: ${referrerId} → ${driverId} (level 1)`);

  // Level 2 and 3 — propagate up the chain
  const ancestorReferrals = await prisma.driverReferral.findMany({
    where: { referredDriverId: referrerId },
    select: { referrerDriverId: true, level: true },
  });

  for (const ancestor of ancestorReferrals) {
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

    console.log(`🔗 Referral chain: ${ancestor.referrerDriverId} → ${driverId} (level ${newLevel})`);
  }
}

/**
 * Returns the referral network for a given driver.
 * Maps each level (1, 2, 3) to the list of driver IDs referred at that level.
 *
 * @param driverId ID of the driver whose network to retrieve
 */
export async function getDriverNetwork(driverId: string): Promise<{
  level1: string[];
  level2: string[];
  level3: string[];
}> {
  const referrals = await prisma.driverReferral.findMany({
    where: { referrerDriverId: driverId },
    select: { referredDriverId: true, level: true },
    orderBy: { level: "asc" },
  });

  const network: { level1: string[]; level2: string[]; level3: string[] } = {
    level1: [],
    level2: [],
    level3: [],
  };

  for (const r of referrals) {
    if (r.level === 1) network.level1.push(r.referredDriverId);
    else if (r.level === 2) network.level2.push(r.referredDriverId);
    else if (r.level === 3) network.level3.push(r.referredDriverId);
  }

  return network;
}
