import { prisma } from "../../infra/prisma/client";

/**
 * Creates a multi-level referral chain when a new driver is registered with a referrer.
 * - Level 1: referrer → new driver (direct)
 * - Level 2: grandparent → new driver (propagated from referrer's parents)
 * - Level 3: great-grandparent → new driver (up to 3 levels only)
 */
export async function createDriverReferralChain(
  driverId: string,
  referrerId: string
): Promise<void> {
  // Level 1: direct referral
  await prisma.driverReferral.create({
    data: {
      referrerDriverId: referrerId,
      referredDriverId: driverId,
      level: 1,
    },
  });

  console.log(`🔗 Nível 1: ${referrerId} → ${driverId}`);

  // Levels 2 and 3: propagate up the chain from the referrer's ancestors
  const ancestorReferrals = await prisma.driverReferral.findMany({
    where: { referredDriverId: referrerId },
  });

  for (const ancestor of ancestorReferrals) {
    const newLevel = ancestor.level + 1;
    if (newLevel <= 3) {
      try {
        await prisma.driverReferral.create({
          data: {
            referrerDriverId: ancestor.referrerDriverId,
            referredDriverId: driverId,
            level: newLevel,
          },
        });
        console.log(`🔗 Nível ${newLevel}: ${ancestor.referrerDriverId} → ${driverId}`);
      } catch {
        // Ignore unique constraint violations (duplicate referral paths)
      }
    }
  }
}

/**
 * Retrieves the full referral network for a given driver (drivers they referred, at all levels).
 */
export async function getDriverNetwork(driverId: string) {
  return prisma.driverReferral.findMany({
    where: { referrerDriverId: driverId },
    include: {
      referred: {
        include: { user: true },
      },
    },
    orderBy: { level: "asc" },
  });
}
