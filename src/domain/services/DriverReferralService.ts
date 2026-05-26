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
  /** Flat convenience field = summary.referredPassengers.total */
  totalPassengers: number;
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

  // Ciclo REAL: newDriver já tem referrerDriver na sua sub-rede (closure table completa é a source of truth).
  // Se existe edge (newDriverId → referrerDriverId) em qualquer nível, adicionar o inverso cria ciclo.
  const cycleEdge = await db.driverReferral.findFirst({
    where: {
      referrerDriverId: newDriverId,
      referredDriverId: referrerDriverId,
    },
    select: { id: true },
  });

  if (cycleEdge) {
    console.warn("[Referral] CYCLE_BLOCKED", { newDriverId, referrerDriverId });
    throw new ReferralChainError("Ciclo de referral detectado");
  }

  const edgesToCreate: {
    referrerDriverId: string;
    referredDriverId: string;
    level: number;
    isDirect: boolean;
  }[] = [];

  // Level 1: edge direta — isDirect=true
  edgesToCreate.push({
    referrerDriverId: referrerDriverId,
    referredDriverId: newDriverId,
    level: 1,
    isDirect: true,
  });

  // Inherited levels: find all referrals where the referrer is the referred party
  const parentReferrals = await db.driverReferral.findMany({
    where: {
      referredDriverId: referrerDriverId,
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

    // Regra de materialização correta:
    // se o upstream (pai) indicou `parent.referredDriverId` no `parent.level`,
    // então para o novo nó devemos criar a aresta `parent.referredDriverId -> newDriver`.
    // Isso preserva a cadeia real parent -> child e permite que o snapshot por referrerDriverId
    // encontre level2/level3 corretamente.

    // Evita edge auto-referencial nos herdados
    if (parent.referrerDriverId === newDriverId) continue;

    // BUG FIX: usa parent.referrerDriverId (o ancestral real), não parent.referredDriverId.
    // Exemplo: para edge {referrerDriverId=Pedro, referredDriverId=João, level=1},
    // cria {referrerDriverId=Pedro, referredDriverId=Carlinhos, level=2, isDirect=false}
    // e NÃO {referrerDriverId=João, referredDriverId=Carlinhos, level=2} (duplicata silenciosa).
    edgesToCreate.push({
      referrerDriverId: parent.referrerDriverId,
      referredDriverId: newDriverId,
      level: inheritedLevel,
      isDirect: false,
    });
  }

  const directEdge = edgesToCreate.find((e) => e.isDirect);
  const inheritedEdges = edgesToCreate.filter((e) => !e.isDirect);

  if (directEdge) {
    console.info("[Referral] DIRECT_EDGE_CREATED", {
      referrerDriverId: directEdge.referrerDriverId,
      referredDriverId: directEdge.referredDriverId,
      level: directEdge.level,
    });
  }

  for (const edge of inheritedEdges) {
    console.info("[Referral] INHERITED_EDGE_CREATED", {
      referrerDriverId: edge.referrerDriverId,
      referredDriverId: edge.referredDriverId,
      level: edge.level,
    });
    console.info("[Referral] LEVEL_PROPAGATED", {
      ancestorDriverId: edge.referrerDriverId,
      newDriverId: edge.referredDriverId,
      level: edge.level,
    });
  }

  if (inheritedEdges.length > 0) {
    console.info("[Referral] ANCESTRY_EXPANDED", {
      newDriverId,
      referrerDriverId,
      ancestorsFound: inheritedEdges.length,
      levels: inheritedEdges.map((e) => e.level),
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

  const totalPassengers = directPassengers + networkPassengers;

  return {
    driverId,
    levels,
    totalPassengers,
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
        total: totalPassengers,
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

