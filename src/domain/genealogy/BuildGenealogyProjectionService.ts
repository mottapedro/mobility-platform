import { ActorType, ExperienceLevel, ReferralFlowType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import {
  GenealogyEdge,
  GenealogyLevel,
  GenealogyMetrics,
  GenealogyNode,
  GenealogyProjection,
  GenealogyRootDriver,
} from "./GenealogyTypes";

/** Absolute hard cap — prevents runaway projections in production. */
const ABSOLUTE_MAX_DEPTH = 10;
export const DEFAULT_DEPTH = 5;

type DbClient = Pick<typeof prisma, "referralRelationship" | "driver" | "passenger">;

interface AdjEdge {
  targetId: string;
  targetActorType: ActorType;
  flowType: ReferralFlowType;
  createdAt: Date;
}

interface BFSEntry {
  actorId: string;
  actorType: ActorType;
  parentId: string | null;
  flowType: ReferralFlowType | null;
  level: number;
  createdAt: Date | null;
}

/**
 * BuildGenealogyProjectionService
 *
 * Projects the referral graph for a root driver into a flat, cycle-safe,
 * depth-limited read model. No business rules are enforced here; this is
 * a pure read-side projection for tree visualisations.
 *
 * Invariants:
 *   - BFS (no recursion → no stack overflow for large trees)
 *   - Visited-set cycle guard (actor-type-scoped key)
 *   - Self-edge guard
 *   - Duplicate edge guard
 *   - Depth limited to min(requested, ABSOLUTE_MAX_DEPTH)
 *   - 3–4 bulk DB queries — no N+1
 */
export async function buildGenealogyProjection(
  rootDriverId: string,
  options: { maxDepth?: number } = {},
  db: DbClient = prisma
): Promise<GenealogyProjection> {
  const appliedDepthLimit = Math.min(
    options.maxDepth !== undefined ? options.maxDepth : DEFAULT_DEPTH,
    ABSOLUTE_MAX_DEPTH
  );

  // ── 1. Load all relationships for this root driver ───────────────────────
  const relationships = await db.referralRelationship.findMany({
    where: { rootDriverId },
    select: {
      flowType: true,
      inviterActorType: true,
      inviterId: true,
      invitedActorType: true,
      invitedId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // ── 2. Build adjacency: inviterId → children ──────────────────────────────
  const adjacency = new Map<string, AdjEdge[]>();
  for (const rel of relationships) {
    const children = adjacency.get(rel.inviterId) ?? [];
    children.push({
      targetId: rel.invitedId,
      targetActorType: rel.invitedActorType as ActorType,
      flowType: rel.flowType as ReferralFlowType,
      createdAt: rel.createdAt,
    });
    adjacency.set(rel.inviterId, children);
  }

  // ── 3. BFS from root ──────────────────────────────────────────────────────
  const visited = new Set<string>(); // "ACTOR_TYPE:actorId"
  const seenEdges = new Set<string>(); // "sourceId->targetId"
  const queue: BFSEntry[] = [
    {
      actorId: rootDriverId,
      actorType: ActorType.DRIVER,
      parentId: null,
      flowType: null,
      level: 0,
      createdAt: null,
    },
  ];
  const bfsResult: BFSEntry[] = [];
  const edges: GenealogyEdge[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const visitKey = `${current.actorType}:${current.actorId}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    bfsResult.push(current);

    if (current.level >= appliedDepthLimit) continue;

    for (const child of adjacency.get(current.actorId) ?? []) {
      if (child.targetId === current.actorId) continue; // self-edge guard
      const edgeKey = `${current.actorType}:${current.actorId}->${child.targetActorType}:${child.targetId}`;
      if (seenEdges.has(edgeKey)) continue; // duplicate edge guard
      seenEdges.add(edgeKey);
      const childVisitKey = `${child.targetActorType}:${child.targetId}`;
      if (visited.has(childVisitKey)) continue; // cycle guard

      edges.push({
        sourceActorId: current.actorId,
        targetActorId: child.targetId,
        flowType: child.flowType,
      });
      queue.push({
        actorId: child.targetId,
        actorType: child.targetActorType,
        parentId: current.actorId,
        flowType: child.flowType,
        level: current.level + 1,
        createdAt: child.createdAt,
      });
    }
  }

  // ── 4. Collect actor IDs for bulk fetches ─────────────────────────────────
  const driverIds = bfsResult
    .filter((n) => n.actorType === ActorType.DRIVER)
    .map((n) => n.actorId);
  const passengerIds = bfsResult
    .filter((n) => n.actorType === ActorType.PASSENGER)
    .map((n) => n.actorId);

  // ── 5. Bulk fetch actor enrichment (2 queries, never N+1) ─────────────────
  type DriverRow = {
    id: string;
    experienceLevel: string;
    isActive: boolean;
    networkLevel: number;
    publicSlug: string | null;
    referralCode: string | null;
    createdAt: Date;
    user: { name: string };
  };
  type PassengerRow = {
    id: string;
    networkLevel: number;
    publicSlug: string | null;
    referralCode: string | null;
    createdAt: Date;
    user: { name: string };
  };

  const [driverRows, passengerRows] = await Promise.all([
    driverIds.length > 0
      ? (db.driver.findMany({
          where: { id: { in: driverIds } },
          select: {
            id: true,
            experienceLevel: true,
            isActive: true,
            networkLevel: true,
            publicSlug: true,
            referralCode: true,
            createdAt: true,
            user: { select: { name: true } },
          },
        }) as Promise<DriverRow[]>)
      : Promise.resolve([] as DriverRow[]),
    passengerIds.length > 0
      ? (db.passenger.findMany({
          where: { id: { in: passengerIds } },
          select: {
            id: true,
            networkLevel: true,
            publicSlug: true,
            referralCode: true,
            createdAt: true,
            user: { select: { name: true } },
          },
        }) as Promise<PassengerRow[]>)
      : Promise.resolve([] as PassengerRow[]),
  ]);

  type ActorInfo = {
    name: string;
    publicSlug: string | null;
    referralCode: string | null;
    networkLevel: number;
    experienceLevel?: ExperienceLevel;
    isActive?: boolean;
    createdAt: Date;
  };
  const actorMap = new Map<string, ActorInfo>();
  for (const d of driverRows) {
    actorMap.set(d.id, {
      name: d.user.name,
      publicSlug: d.publicSlug,
      referralCode: d.referralCode,
      networkLevel: d.networkLevel,
      experienceLevel: d.experienceLevel as ExperienceLevel,
      isActive: d.isActive,
      createdAt: d.createdAt,
    });
  }
  for (const p of passengerRows) {
    actorMap.set(p.id, {
      name: p.user.name,
      publicSlug: p.publicSlug ?? null,
      referralCode: p.referralCode ?? null,
      networkLevel: p.networkLevel ?? 0,
      createdAt: p.createdAt,
    });
  }

  // ── 6. Build enriched nodes ───────────────────────────────────────────────
  const nodes: GenealogyNode[] = bfsResult.map((entry) => {
    const info = actorMap.get(entry.actorId);
    return {
      actorId: entry.actorId,
      actorType: entry.actorType,
      name: info?.name ?? "",
      flowType: entry.flowType ?? ReferralFlowType.DRIVER_TO_DRIVER,
      level: entry.level,
      rootDriverId,
      parentId: entry.parentId,
      publicSlug: info?.publicSlug ?? null,
      referralCode: info?.referralCode ?? null,
      experienceLevel: info?.experienceLevel,
      isActive: info?.isActive,
      networkLevel: info?.networkLevel ?? 0,
      createdAt: info?.createdAt ?? entry.createdAt ?? new Date(0),
    };
  });

  // ── 7. Build levels (group by BFS depth) ─────────────────────────────────
  const levelMap = new Map<number, string[]>();
  for (const node of nodes) {
    const bucket = levelMap.get(node.level) ?? [];
    bucket.push(node.actorId);
    levelMap.set(node.level, bucket);
  }
  const levels: GenealogyLevel[] = [...levelMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([depth, nodeIds]) => ({ depth, nodeIds }));

  // ── 8. Metrics ────────────────────────────────────────────────────────────
  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.level), 0);
  const metrics: GenealogyMetrics = {
    totalDrivers: nodes.filter((n) => n.actorType === ActorType.DRIVER).length,
    totalPassengers: nodes.filter((n) => n.actorType === ActorType.PASSENGER).length,
    totalRelationships: relationships.length,
    totalD2D: relationships.filter((r) => r.flowType === ReferralFlowType.DRIVER_TO_DRIVER).length,
    totalD2P: relationships.filter((r) => r.flowType === ReferralFlowType.DRIVER_TO_PASSENGER).length,
    totalP2P: relationships.filter((r) => r.flowType === ReferralFlowType.PASSENGER_TO_PASSENGER).length,
    maxDepth,
  };

  const rootInfo = actorMap.get(rootDriverId);
  const rootDriver: GenealogyRootDriver = {
    id: rootDriverId,
    name: rootInfo?.name ?? "",
    experienceLevel: (rootInfo?.experienceLevel ?? null) as ExperienceLevel | null,
    networkLevel: rootInfo?.networkLevel ?? 0,
    publicSlug: rootInfo?.publicSlug ?? null,
    referralCode: rootInfo?.referralCode ?? null,
  };

  return {
    rootDriver,
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      maxDepth,
      appliedDepthLimit,
    },
    nodes,
    edges,
    levels,
    metrics,
  };
}

/**
 * Rebase a global projection to the selected actor without changing the
 * persisted/global ownership root stamped on each node.
 *
 * The returned DTO keeps the public genealogy shape, but treats
 * `selectedActorId` as the visual root: ancestors are removed, descendants
 * are retained only when reachable through projection edges, and levels are
 * rebased to zero.
 */
export function sliceGenealogyProjectionForActor(
  projection: GenealogyProjection,
  selectedActorId: string,
  options: { maxDepth?: number } = {},
): GenealogyProjection | null {
  const selected = projection.nodes.find((node) => node.actorId === selectedActorId);
  if (!selected) return null;
  const nodeById = new Map(projection.nodes.map((node) => [node.actorId, node]));

  const childrenBySource = new Map<string, GenealogyEdge[]>();
  for (const edge of projection.edges) {
    const children = childrenBySource.get(edge.sourceActorId) ?? [];
    children.push(edge);
    childrenBySource.set(edge.sourceActorId, children);
  }

  const includedIds = new Set<string>([selectedActorId]);
  const queue = [selectedActorId];
  while (queue.length > 0) {
    const sourceId = queue.shift()!;
    for (const edge of childrenBySource.get(sourceId) ?? []) {
      if (includedIds.has(edge.targetActorId)) continue;
      const target = nodeById.get(edge.targetActorId);
      if (!target) continue;
      if (
        options.maxDepth !== undefined &&
        target.level - selected.level > options.maxDepth
      ) {
        continue;
      }
      includedIds.add(edge.targetActorId);
      queue.push(edge.targetActorId);
    }
  }

  const relativeNodes = projection.nodes
    .filter((node) => includedIds.has(node.actorId))
    .map((node) => ({
      ...node,
      level: node.level - selected.level,
      parentId: node.actorId === selectedActorId ? null : node.parentId,
    }));
  const relativeEdges = projection.edges.filter(
    (edge) => includedIds.has(edge.sourceActorId) && includedIds.has(edge.targetActorId),
  );
  const levels = new Map<number, string[]>();
  for (const node of relativeNodes) {
    const nodeIds = levels.get(node.level) ?? [];
    nodeIds.push(node.actorId);
    levels.set(node.level, nodeIds);
  }

  const metrics = {
    totalDrivers: relativeNodes.filter((node) => node.actorType === ActorType.DRIVER).length,
    totalPassengers: relativeNodes.filter((node) => node.actorType === ActorType.PASSENGER).length,
    totalRelationships: relativeEdges.length,
    totalD2D: relativeEdges.filter((edge) => edge.flowType === ReferralFlowType.DRIVER_TO_DRIVER).length,
    totalD2P: relativeEdges.filter((edge) => edge.flowType === ReferralFlowType.DRIVER_TO_PASSENGER).length,
    totalP2P: relativeEdges.filter((edge) => edge.flowType === ReferralFlowType.PASSENGER_TO_PASSENGER).length,
    maxDepth: relativeNodes.reduce((max, node) => Math.max(max, node.level), 0),
  };

  return {
    rootDriver: {
      id: selected.actorId,
      name: selected.name,
      experienceLevel: (selected.experienceLevel ?? null) as ExperienceLevel | null,
      networkLevel: selected.networkLevel,
      publicSlug: selected.publicSlug,
      referralCode: selected.referralCode,
    },
    stats: {
      totalNodes: relativeNodes.length,
      totalEdges: relativeEdges.length,
      maxDepth: metrics.maxDepth,
      appliedDepthLimit: options.maxDepth ?? projection.stats.appliedDepthLimit,
    },
    nodes: relativeNodes,
    edges: relativeEdges,
    levels: [...levels.entries()]
      .sort(([a], [b]) => a - b)
      .map(([depth, nodeIds]) => ({ depth, nodeIds })),
    metrics,
  };
}
