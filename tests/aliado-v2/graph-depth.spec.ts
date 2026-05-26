/**
 * Spec: graph-depth
 *
 * Verifies depth-limiting behaviour of buildGenealogyProjection().
 *
 * Coverage:
 *  - maxDepth=1 cuts tree at level 1 (does not include level 2 nodes)
 *  - maxDepth=0 yields only the root node
 *  - Default maxDepth (10) is enforced as absolute cap
 *  - maxDepth > ABSOLUTE_MAX_DEPTH (10) is silently capped to 10
 *  - maxDepth=3 on a 5-level chain → levels 0..3 present, level 4 absent
 *  - Edges only reference nodes that are within depth limit
 */

import { buildGenealogyProjection } from "../../src/domain/genealogy/BuildGenealogyProjectionService";
import { ActorType, ReferralFlowType } from "../../src/shared/enums";

type RelRow = {
  flowType: ReferralFlowType;
  inviterActorType: ActorType;
  inviterId: string;
  invitedActorType: ActorType;
  invitedId: string;
  createdAt: Date;
};

function makeDb(
  relationships: RelRow[],
  drivers: { id: string; user: { name: string } }[] = []
) {
  return {
    referralRelationship: {
      findMany: jest.fn().mockResolvedValue(relationships),
    },
    driver: {
      findMany: jest.fn().mockResolvedValue(drivers),
    },
    passenger: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as any;
}

const T0 = new Date("2024-01-01T00:00:00Z");

/** Builds a linear chain: root → n1 → n2 → … → nN */
function buildChain(depth: number): { rels: RelRow[]; drivers: { id: string; user: { name: string } }[] } {
  const ids = ["root", ...Array.from({ length: depth }, (_, i) => `n${i + 1}`)];
  const rels: RelRow[] = [];
  for (let i = 0; i < ids.length - 1; i++) {
    rels.push({
      flowType: ReferralFlowType.DRIVER_TO_DRIVER,
      inviterActorType: ActorType.DRIVER,
      inviterId: ids[i],
      invitedActorType: ActorType.DRIVER,
      invitedId: ids[i + 1],
      createdAt: T0,
    });
  }
  const drivers = ids.map((id) => ({ id, user: { name: id } }));
  return { rels, drivers };
}

describe("graph-depth", () => {
  it("maxDepth=1 yields only root (level 0) and direct children (level 1)", async () => {
    const { rels, drivers } = buildChain(5); // root → n1 → n2 → n3 → n4 → n5
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", { maxDepth: 1 }, db);

    const levels = result.nodes.map((n) => n.level);
    expect(Math.max(...levels)).toBe(1);
    expect(result.nodes.find((n) => n.actorId === "n2")).toBeUndefined();
  });

  it("maxDepth=0 yields only the root node", async () => {
    const { rels, drivers } = buildChain(3);
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", { maxDepth: 0 }, db);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].actorId).toBe("root");
    expect(result.edges).toHaveLength(0);
    expect(result.metrics.maxDepth).toBe(0);
  });

  it("maxDepth=3 on a 5-level chain: levels 0–3 present, level 4 absent", async () => {
    const { rels, drivers } = buildChain(5); // root → n1 → n2 → n3 → n4 → n5
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", { maxDepth: 3 }, db);

    const presentLevels = result.levels.map((l) => l.depth);
    expect(presentLevels).toContain(0);
    expect(presentLevels).toContain(1);
    expect(presentLevels).toContain(2);
    expect(presentLevels).toContain(3);

    // n4 is at level 4 — must be absent
    expect(result.nodes.find((n) => n.actorId === "n4")).toBeUndefined();
    expect(result.nodes.find((n) => n.actorId === "n5")).toBeUndefined();

    // metrics.maxDepth reflects actual maximum, not the requested cap
    expect(result.metrics.maxDepth).toBe(3);
  });

  it("maxDepth above absolute cap (10) is silently capped — does not crash", async () => {
    const { rels, drivers } = buildChain(12); // 12 levels deep
    const db = makeDb(rels, drivers);
    // Request 999 — absolute cap is 10
    const result = await buildGenealogyProjection("root", { maxDepth: 999 }, db);

    // Must not include nodes beyond level 10
    const deepNodes = result.nodes.filter((n) => n.level > 10);
    expect(deepNodes).toHaveLength(0);
    expect(result.metrics.maxDepth).toBeLessThanOrEqual(10);
  });

  it("edges only connect nodes within the depth limit", async () => {
    const { rels, drivers } = buildChain(5);
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", { maxDepth: 2 }, db);

    const nodeIds = new Set(result.nodes.map((n) => n.actorId));
    for (const edge of result.edges) {
      expect(nodeIds.has(edge.sourceActorId)).toBe(true);
      expect(nodeIds.has(edge.targetActorId)).toBe(true);
    }
  });

  it("chain of exactly maxDepth levels: all levels included", async () => {
    const { rels, drivers } = buildChain(4); // root → n1 → n2 → n3 → n4
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", { maxDepth: 4 }, db);

    expect(result.nodes).toHaveLength(5); // root + n1..n4
    expect(result.metrics.maxDepth).toBe(4);
  });
});
