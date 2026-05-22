import { prisma } from "../../infra/prisma/client";

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
  levels: Record<string, DriverNetworkNode[]>;
  summary: {
    referredDrivers: {
      level1: number;
      level2: number;
      level3: number;
      level4: number;
      level5: number;
      byLevel: Record<string, number>;
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

export interface DriverNetworkLevels {
  level1: string[];
  level2: string[];
  level3: string[];
}

export class ReferralChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferralChainError";
  }
}

// regra de negócio atual; pode evoluir conforme ativação e performance da rede
const REFERRAL_TREE_MAX_DEPTH = 5;

type ReferralDbClient = Pick<typeof prisma, "driver" | "driverReferral" | "passenger">;

/**
 * Creates the full referral chain when a new driver registers with a referrer.
 * - Creates level-1 edge: referrer → newDriver
 * - Inherits edges from referrer's own referrers (level+1), capped at business depth
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
      referredDriverId: newDriverId,
      referrerDriverId: referrerDriverId,
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
    referrerDriverId: referrerDriverId,
    referredDriverId: newDriverId,
    level: 1,
  });

  // Inherited levels: find all referrals where the referrer is the referred party
  const parentReferrals = await db.driverReferral.findMany({
    where: {
      referrerDriverId: referrerDriverId,
      level: { lt: REFERRAL_TREE_MAX_DEPTH },
    },
    select: {
      level: true,
      referrerDriverId: true,
      referredDriverId: true,
    },
  });

  for (const parent of parentReferrals) {
    const inheritedLevel = parent.level + 1;
    if (inheritedLevel > REFERRAL_TREE_MAX_DEPTH) continue;

    // prevent cycles: parent.referrerDriverId (um possível upstream) não pode virar newDriver
    if (parent.referrerDriverId === newDriverId) continue;

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

export async function getDriverNetworkSnapshot(driverId: string): Promise<DriverNetworkSnapshot> {
  const referrals = await prisma.driverReferral.findMany({
    where: { referrerDriverId: driverId },
    select: {
      level: true,
      referredDriverId: true,
      // não usamos include de relações aqui porque o schema do merge atual está inconsistente
    },
    orderBy: [{ level: "asc" }, { createdAt: "desc" }],
  });

  const referredDrivers = await prisma.driver.findMany({
    where: { id: { in: referrals.map((r) => r.referredDriverId) } },
    select: {
      id: true,
      isActive: true,
      createdAt: true,
      referralCode: true,
      user: { select: { name: true } },
    },
  });

  const referredDriverMap = new Map(referredDrivers.map((d) => [d.id, d]));

  const referredDriverIds = referrals.map((item) => item.referredDriverId);
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
      .filter(
        (item): item is { referredByDriverId: string; _count: { _all: number } } =>
          Boolean(item.referredByDriverId)
      )
      .map((item) => [item.referredByDriverId, item._count._all])
  );

  const levels: DriverNetworkSnapshot["levels"] = Object.fromEntries(
    Array.from({ length: REFERRAL_TREE_MAX_DEPTH }, (_, index) => [
      `level${index + 1}`,
      [] as DriverNetworkNode[],
    ])
  );

  for (const item of referrals) {
    const referred = referredDriverMap.get(item.referredDriverId);
    if (!referred) continue;

    const node: DriverNetworkNode = {
      driverId: referred.id,
      name: referred.user.name,
      referralCode: referred.referralCode,
      isActive: referred.isActive,
      createdAt: referred.createdAt,
      referredPassengersCount: passengerCountMap.get(referred.id) ?? 0,
    };

    const levelKey = `level${item.level}`;
    if (levelKey in levels) {
      levels[levelKey].push(node);
    }
  }

  const directPassengers = passengerCountMap.get(driverId) ?? 0;
  const networkPassengers = referredDriverIds.reduce(
    (total, referredId) => total + (passengerCountMap.get(referredId) ?? 0),
    0
  );

  const referredDriversByLevel = Object.fromEntries(
    Array.from({ length: REFERRAL_TREE_MAX_DEPTH }, (_, index) => {
      const levelKey = `level${index + 1}`;
      return [levelKey, levels[levelKey].length];
    })
  );
  const totalReferredDrivers = Object.values(referredDriversByLevel).reduce((total, count) => total + count, 0);

  return {
    driverId,
    levels,
    summary: {
      referredDrivers: {
        level1: referredDriversByLevel.level1 ?? 0,
        level2: referredDriversByLevel.level2 ?? 0,
        level3: referredDriversByLevel.level3 ?? 0,
        level4: referredDriversByLevel.level4 ?? 0,
        level5: referredDriversByLevel.level5 ?? 0,
        byLevel: referredDriversByLevel,
        total: totalReferredDrivers,
        maxDepth: REFERRAL_TREE_MAX_DEPTH,
      },
      referredPassengers: {
        direct: directPassengers,
        fromNetwork: networkPassengers,
        total: directPassengers + networkPassengers,
      },
    },
  };
}

// Compat layer para código legado que ainda espera level1/level2/level3 como arrays de IDs.
// Mantém o domínio novo (snapshot 5 níveis) como fonte de verdade.
export async function getDriverNetwork(driverId: string): Promise<DriverNetworkLevels> {
  const snapshot = await getDriverNetworkSnapshot(driverId);

  return {
    level1: (snapshot.levels.level1 ?? []).map((n) => n.driverId),
    level2: (snapshot.levels.level2 ?? []).map((n) => n.driverId),
    level3: (snapshot.levels.level3 ?? []).map((n) => n.driverId),
  };
}

