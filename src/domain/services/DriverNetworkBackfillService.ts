import { PrismaClient } from "@prisma/client";
import { buildDriverPublicSlug, buildDriverReferralCode } from "./DriverIdentityService";

export async function backfillDriverNetworkFields(
  prisma: PrismaClient,
  options: { dryRun: boolean }
) {
  const drivers = await prisma.driver.findMany({
    include: {
      user: { select: { name: true } },
      regions: { select: { region: true }, orderBy: { region: "asc" } },
      referralsReceived: { where: { level: 1 }, select: { driverId: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const parentByDriverId = new Map<string, string | null>();
  for (const driver of drivers) {
    const directParents = driver.referralsReceived.map((edge) => edge.driverId);
    if (directParents.length > 1) {
      throw new Error(`Driver ${driver.id} has multiple direct referrers`);
    }
    parentByDriverId.set(driver.id, driver.referredByDriverId ?? directParents[0] ?? null);
  }

  const depthMemo = new Map<string, number>();
  const getNetworkLevel = (driverId: string): number => {
    if (depthMemo.has(driverId)) {
      return depthMemo.get(driverId)!;
    }

    const parentId = parentByDriverId.get(driverId) ?? null;
    if (!parentId) {
      depthMemo.set(driverId, 0);
      return 0;
    }

    const level = getNetworkLevel(parentId) + 1;
    depthMemo.set(driverId, level);
    return level;
  };

  let updatedDrivers = 0;

  for (const driver of drivers) {
    const publicSlug = driver.publicSlug ?? buildDriverPublicSlug(driver.user.name);
    const referralCode = driver.referralCode ?? buildDriverReferralCode(publicSlug, driver.regions.map((entry) => entry.region));
    const referredByDriverId = parentByDriverId.get(driver.id) ?? null;
    const networkLevel = getNetworkLevel(driver.id);

    const updateData = {
      ...(driver.publicSlug == null ? { publicSlug } : {}),
      ...(driver.referralCode == null ? { referralCode } : {}),
      ...(driver.referredByDriverId == null && referredByDriverId ? { referredByDriverId } : {}),
      ...(driver.networkLevel === 0 && networkLevel > 0 ? { networkLevel } : {}),
    };

    if (Object.keys(updateData).length === 0) {
      continue;
    }

    updatedDrivers += 1;

    if (!options.dryRun) {
      await prisma.driver.update({
        where: { id: driver.id },
        data: updateData,
      });
    }
  }

  return { updatedDrivers };
}
