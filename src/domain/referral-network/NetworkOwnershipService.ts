import { ActorType, RideStatus, SplitBeneficiaryType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";

type Db = Pick<
  typeof prisma,
  "referralRelationship" | "passenger" | "rideRequest" | "revenueSplit"
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

const COMPLETED_LIKE: RideStatus[] = [RideStatus.COMPLETED, RideStatus.PAID];

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
    splitAgg,
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
    db.rideRequest.count({
      where: {
        rootDriverId: driverId,
        status: { in: COMPLETED_LIKE },
        scheduledAt: { gte: since },
      },
    }),
    db.revenueSplit.aggregate({
      _sum: { amountCents: true },
      where: {
        beneficiaryDriverId: driverId,
        beneficiaryType: { in: [SplitBeneficiaryType.ROOT_DRIVER, SplitBeneficiaryType.DRIVER] },
        settlement: { settledAt: { gte: since } },
      },
    }),
    computeRetention(driverId, since, db),
    db.referralRelationship.count({
      where: { rootDriverId: driverId, createdAt: { gte: since7d } },
    }),
    db.referralRelationship.count({
      where: { rootDriverId: driverId, createdAt: { gte: since30d } },
    }),
  ]);

  return {
    driverId,
    windowDays,
    directDrivers,
    totalDriversInTree,
    directPassengers,
    totalPassengersInTree,
    completedRidesAttributedToTree,
    settledRevenueShareCents: splitAgg._sum.amountCents ?? 0,
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
  const rides = await db.rideRequest.findMany({
    where: {
      rootDriverId: driverId,
      status: { in: COMPLETED_LIKE },
      scheduledAt: { gte: since },
    },
    select: { passengerId: true },
  });
  if (rides.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const r of rides) {
    counts.set(r.passengerId, (counts.get(r.passengerId) ?? 0) + 1);
  }
  const withOne = counts.size;
  let withTwoPlus = 0;
  for (const n of counts.values()) if (n >= 2) withTwoPlus += 1;
  return withOne === 0 ? 0 : withTwoPlus / withOne;
}
