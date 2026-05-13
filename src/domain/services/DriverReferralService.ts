import { prisma } from "../../infra/prisma/client";

export interface DriverNetwork {
  level1: string[];
  level2: string[];
  level3: string[];
}

/**
 * Creates the full referral chain when a new driver registers with a referrer.
 * - Creates level-1 edge: referrer → newDriver
 * - Inherits edges from referrer's own referrers (level+1), capped at level 3
 * - Skips self-referrals and duplicate edges (@@unique in DB)
 */
export async function createDriverReferralChain(
  newDriverId: string,
  referrerDriverId: string,
  client: typeof prisma = prisma
): Promise<void> {
  if (newDriverId === referrerDriverId) return;

  const edgesToCreate: {
    driverId: string;
    referredDriverId: string;
    level: number;
  }[] = [];

  // Level 1: direct referrer → newDriver
  edgesToCreate.push({
    driverId: referrerDriverId,
    referredDriverId: newDriverId,
    level: 1,
  });

  // Inherited levels: find all referrals where the referrer is the referred party
  const parentReferrals = await client.driverReferral.findMany({
    where: { referredDriverId: referrerDriverId },
  });

  for (const parent of parentReferrals) {
    const inheritedLevel = parent.level + 1;
    if (inheritedLevel > 3) continue;
    if (parent.driverId === newDriverId) continue; // prevent cycles

    edgesToCreate.push({
      driverId: parent.driverId,
      referredDriverId: newDriverId,
      level: inheritedLevel,
    });
  }

  for (const edge of edgesToCreate) {
    await client.driverReferral.upsert({
      where: {
        driverId_referredDriverId: {
          driverId: edge.driverId,
          referredDriverId: edge.referredDriverId,
        },
      },
      update: { level: edge.level },
      create: edge,
    });
  }
}

/**
 * Returns the IDs of all drivers in the network of a given driver, grouped by level.
 */
export async function getDriverNetwork(driverId: string): Promise<DriverNetwork> {
  const referrals = await prisma.driverReferral.findMany({
    where: { driverId },
    select: { referredDriverId: true, level: true },
  });

  const network: DriverNetwork = { level1: [], level2: [], level3: [] };

  for (const r of referrals) {
    if (r.level === 1) network.level1.push(r.referredDriverId);
    else if (r.level === 2) network.level2.push(r.referredDriverId);
    else if (r.level === 3) network.level3.push(r.referredDriverId);
  }

  console.log(`[Referral] Level 1 drivers: ${network.level1.length}`);
  console.log(`[Referral] Level 2 drivers: ${network.level2.length}`);
  console.log(`[Referral] Level 3 drivers: ${network.level3.length}`);

  return network;
}
