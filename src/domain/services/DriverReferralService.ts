import { prisma } from "../../infra/prisma/client";

export interface DriverNetwork {
  level1: string[];
  level2: string[];
  level3: string[];
}

export interface DriverNetworkNode {
  driverId: string;
  name: string;
  referralCode: string;
  isActive: boolean;
  createdAt: Date;
  referredPassengersCount: number;
}

export interface DriverNetworkSnapshot {
  driverId: string;
  levels: {
    level1: DriverNetworkNode[];
    level2: DriverNetworkNode[];
    level3: DriverNetworkNode[];
  };
  summary: {
    referredDrivers: {
      level1: number;
      level2: number;
      level3: number;
      total: number;
      maxDepth: number;
    };
    referredPassengers: {
      direct: number;
      fromNetwork: number;
      total: number;
    };
  };
}

export class ReferralChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferralChainError";
  }
}

const MAX_REFERRAL_DEPTH = 3;

type ReferralDbClient = Pick<typeof prisma, "driver" | "driverReferral" | "passenger">;

/**
 * Creates the full referral chain when a new driver registers with a referrer.
 * - Creates level-1 edge: referrer → newDriver
 * - Inherits edges from referrer's own referrers (level+1), capped at level 3
 * - Skips self-referrals and duplicate edges (@@unique in DB)
 */
export async function createDriverReferralChain(
  newDriverId: string,
  referrerDriverId: string,
  db: ReferralDbClient = prisma
): Promise<void> {
  if (newDriverId === referrerDriverId) {
    throw new ReferralChainError("Ciclo de referral inválido: autoindicação não permitida");
  }

  const [newDriver, referrerDriver] = await Promise.all([
    db.driver.findUnique({ where: { id: newDriverId }, select: { id: true, isActive: true } }),
    db.driver.findUnique({ where: { id: referrerDriverId }, select: { id: true, isActive: true } }),
  ]);

  if (!newDriver || !newDriver.isActive) {
    throw new ReferralChainError("Motorista indicado para vínculo não está ativo");
  }

  if (!referrerDriver || !referrerDriver.isActive) {
    throw new ReferralChainError("Código de referral inválido ou motorista inativo");
  }

  const reverseEdge = await db.driverReferral.findFirst({
    where: {
      referrerDriverId: newDriverId,
      referredDriverId: referrerDriverId,
    },
    select: { id: true },
  });

  if (reverseEdge) {
    console.warn("[Referral] ciclo detectado e bloqueado", { newDriverId, referrerDriverId });
    throw new ReferralChainError("Ciclo de referral detectado");
  }

  const edgesToCreate: {
    referrerDriverId: string;
    referredDriverId: string;
    level: number;
  }[] = [];

  // Level 1: direct referrer → newDriver
  edgesToCreate.push({
    referrerDriverId,
    referredDriverId: newDriverId,
    level: 1,
  });

  // Inherited levels: find all referrals where the referrer is the referred party
  const parentReferrals = await db.driverReferral.findMany({
    where: {
      referredDriverId: referrerDriverId,
      level: { lt: MAX_REFERRAL_DEPTH },
    },
  });

  for (const parent of parentReferrals) {
    const inheritedLevel = parent.level + 1;
    if (inheritedLevel > MAX_REFERRAL_DEPTH) continue;
    if (parent.referrerDriverId === newDriverId) continue; // prevent cycles

    edgesToCreate.push({
      referrerDriverId: parent.referrerDriverId,
      referredDriverId: newDriverId,
      level: inheritedLevel,
    });
  }

  await db.driverReferral.createMany({
    data: edgesToCreate,
    skipDuplicates: true,
  });
}

/**
 * Returns the IDs of all drivers in the network of a given driver, grouped by level.
 */
export async function getDriverNetwork(driverId: string): Promise<DriverNetwork> {
  const referrals = await prisma.driverReferral.findMany({
    where: { referrerDriverId: driverId },
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

export async function getDriverNetworkSnapshot(driverId: string): Promise<DriverNetworkSnapshot> {
  const referrals = await prisma.driverReferral.findMany({
    where: { referrerDriverId: driverId },
    select: {
      level: true,
      referred: {
        select: {
          id: true,
          isActive: true,
          createdAt: true,
          referralCode: true,
          user: {
            select: {
              name: true,
            },
          },
        },
      },
    },
    orderBy: [{ level: "asc" }, { createdAt: "desc" }],
  });

  const referredDriverIds = referrals.map((item) => item.referred.id);
  const idsForPassengerMetrics = [driverId, ...referredDriverIds];

  const passengerCounts = await prisma.passenger.groupBy({
    by: ["referredByDriverId"],
    where: {
      referredByDriverId: {
        in: idsForPassengerMetrics,
      },
    },
    _count: {
      _all: true,
    },
  });

  const passengerCountMap = new Map(
    passengerCounts
      .filter((item): item is { referredByDriverId: string; _count: { _all: number } } => Boolean(item.referredByDriverId))
      .map((item) => [item.referredByDriverId, item._count._all])
  );

  const levels: DriverNetworkSnapshot["levels"] = {
    level1: [],
    level2: [],
    level3: [],
  };

  for (const item of referrals) {
    const node: DriverNetworkNode = {
      driverId: item.referred.id,
      name: item.referred.user.name,
      referralCode: item.referred.referralCode,
      isActive: item.referred.isActive,
      createdAt: item.referred.createdAt,
      referredPassengersCount: passengerCountMap.get(item.referred.id) ?? 0,
    };

    if (item.level === 1) levels.level1.push(node);
    else if (item.level === 2) levels.level2.push(node);
    else if (item.level === 3) levels.level3.push(node);
  }

  const directPassengers = passengerCountMap.get(driverId) ?? 0;
  const networkPassengers = referredDriverIds.reduce(
    (total, referredId) => total + (passengerCountMap.get(referredId) ?? 0),
    0
  );

  return {
    driverId,
    levels,
    summary: {
      referredDrivers: {
        level1: levels.level1.length,
        level2: levels.level2.length,
        level3: levels.level3.length,
        total: levels.level1.length + levels.level2.length + levels.level3.length,
        maxDepth: MAX_REFERRAL_DEPTH,
      },
      referredPassengers: {
        direct: directPassengers,
        fromNetwork: networkPassengers,
        total: directPassengers + networkPassengers,
      },
    },
  };
}
