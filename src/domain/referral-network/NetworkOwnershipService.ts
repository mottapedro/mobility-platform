import { ActorType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";

type Db = Pick<
  typeof prisma,
  "referralRelationship" | "passenger" | "settlement"
>;

export interface OwnershipMetrics {
  driverId: string;
  windowDays: number;
  directDrivers: number;
  totalDriversInTree: number;
  directPassengers: number;
  totalPassengersInTree: number;
  completedRidesAttributedToTree: number;
  settledRevenueShareCents: number;
  retentionRate: number;
  growthLast7Days: number;
  growthLast30Days: number;
}


export async function getOwnershipMetrics(
  driverId: string,
  options: { windowDays?: number; now?: Date } = {},
  db: Db = prisma
): Promise<OwnershipMetrics> {
  const windowDays = options.windowDays ?? 30;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    directDrivers,
    totalDriversInTree,
    directPassengers,
    totalPassengersInTree,
    completedRidesAttributedToTree,
    driverCentsAgg,
    rootDriverCentsAgg,
    retentionRate,
    growthLast7Days,
    growthLast30Days,
  ] = await Promise.all([
    db.referralRelationship.count({
      where: {
        inviterActorType: ActorType.DRIVER,
        inviterId: driverId,
        invitedActorType: ActorType.DRIVER,
      },
    }),
    db.referralRelationship.count({
      where: { rootDriverId: driverId, invitedActorType: ActorType.DRIVER },
    }),
    db.referralRelationship.count({
      where: {
        inviterActorType: ActorType.DRIVER,
        inviterId: driverId,
        invitedActorType: ActorType.PASSENGER,
      },
    }),
    db.passenger.count({ where: { rootDriverId: driverId } }),
    // Count via Settlement: rootDriverId is always populated here (required invariant in
    // both settlement paths). RideRequest.rootDriverId is only set by SyncProjectionJob
    // (every 5 min) so it lags and produces stale-zero counts.
    db.settlement.count({
      where: { rootDriverId: driverId, settledAt: { gte: since } },
    }),
    // Driver's share for rides they personally drove
    db.settlement.aggregate({
      _sum: { driverCents: true },
      where: {
        rideRequest: { selectedDriverId: driverId },
        settledAt: { gte: since },
      },
    }),
    // Root-driver's share from the full network (rides driven by referred drivers/passengers)
    db.settlement.aggregate({
      _sum: { rootDriverCents: true },
      where: { rootDriverId: driverId, settledAt: { gte: since } },
    }),
    computeRetention(driverId, since, db),
    db.referralRelationship.count({
      where: { rootDriverId: driverId, createdAt: { gte: since7d } },
    }),
    db.referralRelationship.count({
      where: { rootDriverId: driverId, createdAt: { gte: since30d } },
    }),
  ]);

  const settledRevenueShareCents =
    (driverCentsAgg._sum.driverCents ?? 0) +
    (rootDriverCentsAgg._sum.rootDriverCents ?? 0);

  return {
    driverId,
    windowDays,
    directDrivers,
    totalDriversInTree,
    directPassengers,
    totalPassengersInTree,
    completedRidesAttributedToTree,
    settledRevenueShareCents,
    retentionRate,
    growthLast7Days,
    growthLast30Days,
  };
}

async function computeRetention(
  driverId: string,
  since: Date,
  db: Db
): Promise<number> {
  const settlements = await db.settlement.findMany({
    where: { rootDriverId: driverId, settledAt: { gte: since } },
    select: { rideRequest: { select: { passengerId: true } } },
  });
  if (settlements.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const s of settlements) {
    const pid = s.rideRequest.passengerId;
    counts.set(pid, (counts.get(pid) ?? 0) + 1);
  }
  const withOne = counts.size;
  let withTwoPlus = 0;
  for (const n of counts.values()) if (n >= 2) withTwoPlus += 1;
  return withOne === 0 ? 0 : withTwoPlus / withOne;
}
