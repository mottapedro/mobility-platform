/**
 * Spec: genealogy-projection-service
 *
 * Unit-level tests for buildGenealogyProjection().
 * Uses a mock DB client to avoid real DB calls.
 *
 * Response shape (GenealogyTypes.ts):
 *   { rootDriver, stats, nodes, edges, levels, metrics }
 *   levels: Array<{ depth: number; nodeIds: string[] }>
 *
 * Coverage:
 *  - Empty network (root only)
 *  - Linear chain: root → A → B
 *  - Branching: root → A, root → B
 *  - Mixed actor types (D2D + D2P)
 *  - Node uniqueness: no duplicates
 *  - Edge uniqueness: no duplicate edges
 *  - Level grouping correctness
 *  - Metrics computation
 *  - BFS ordering (levels in order)
 */

import { buildGenealogyProjection } from "../../src/domain/genealogy/BuildGenealogyProjectionService";
import { ActorType, ExperienceLevel, ReferralFlowType } from "../../src/shared/enums";

type RelRow = {
  flowType: ReferralFlowType;
  inviterActorType: ActorType;
  inviterId: string;
  invitedActorType: ActorType;
  invitedId: string;
  createdAt: Date;
};

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

const T0 = new Date("2024-01-01T00:00:00Z");

function makeDriverRow(id: string, name: string): DriverRow {
  return {
    id,
    experienceLevel: ExperienceLevel.PROFISSIONAL,
    isActive: true,
    networkLevel: 0,
    publicSlug: `slug-${id}`,
    referralCode: `rc-${id}`,
    createdAt: T0,
    user: { name },
  };
}

function makePaxRow(id: string, name: string): PassengerRow {
  return { id, networkLevel: 0, publicSlug: null, referralCode: null, createdAt: T0, user: { name } };
}

function makeDb(
  relationships: RelRow[],
  drivers: DriverRow[] = [],
  passengers: PassengerRow[] = []
) {
  return {
    referralRelationship: {
      findMany: jest.fn().mockResolvedValue(relationships),
    },
    driver: {
      findMany: jest.fn().mockResolvedValue(drivers),
    },
    passenger: {
      findMany: jest.fn().mockResolvedValue(passengers),
    },
  } as any;
}

describe("buildGenealogyProjection", () => {
  it("root-only: no relationships → single node, no edges", async () => {
    const db = makeDb([], [makeDriverRow("root", "Root Driver")]);
    const result = await buildGenealogyProjection("root", {}, db);

    expect(result.rootDriver.id).toBe("root");
    expect(result.rootDriver.name).toBe("Root Driver");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      actorId: "root",
      actorType: ActorType.DRIVER,
      level: 0,
      parentId: null,
    });
    expect(result.edges).toHaveLength(0);
    expect(result.levels).toHaveLength(1);
    expect(result.levels[0]).toMatchObject({ depth: 0, nodeIds: expect.arrayContaining(["root"]) });
    expect(result.metrics.totalDrivers).toBe(1);
    expect(result.metrics.totalPassengers).toBe(0);
    expect(result.metrics.totalRelationships).toBe(0);
    expect(result.metrics.maxDepth).toBe(0);
    expect(result.stats.totalNodes).toBe(1);
    expect(result.stats.totalEdges).toBe(0);
  });

  it("linear chain: root → A → B yields 3 nodes at levels 0, 1, 2", async () => {
    const rels: RelRow[] = [
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "A", invitedActorType: ActorType.DRIVER, invitedId: "B", createdAt: T0 },
    ];
    const drivers = [
      makeDriverRow("root", "Root"),
      makeDriverRow("A", "Alpha"),
      makeDriverRow("B", "Beta"),
    ];
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", {}, db);

    expect(result.nodes).toHaveLength(3);
    const nodeA = result.nodes.find((n) => n.actorId === "A")!;
    expect(nodeA.level).toBe(1);
    expect(nodeA.parentId).toBe("root");
    const nodeB = result.nodes.find((n) => n.actorId === "B")!;
    expect(nodeB.level).toBe(2);
    expect(nodeB.parentId).toBe("A");

    expect(result.edges).toHaveLength(2);
    expect(result.metrics.maxDepth).toBe(2);
    expect(result.levels).toHaveLength(3);
  });

  it("branching: root → A and root → B yields correct tree", async () => {
    const rels: RelRow[] = [
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "B", createdAt: T0 },
    ];
    const drivers = [
      makeDriverRow("root", "Root"),
      makeDriverRow("A", "Alpha"),
      makeDriverRow("B", "Beta"),
    ];
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", {}, db);

    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(2);
    const level1 = result.levels.find((l) => l.depth === 1)!;
    expect(level1.nodeIds).toHaveLength(2);
    expect(result.metrics.maxDepth).toBe(1);
  });

  it("mixed D2D and D2P: metrics count flow types correctly", async () => {
    const rels: RelRow[] = [
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "D1", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_PASSENGER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.PASSENGER, invitedId: "P1", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_PASSENGER, inviterActorType: ActorType.DRIVER, inviterId: "D1", invitedActorType: ActorType.PASSENGER, invitedId: "P2", createdAt: T0 },
    ];
    const drivers = [makeDriverRow("root", "Root"), makeDriverRow("D1", "Driver1")];
    const passengers = [makePaxRow("P1", "Pax1"), makePaxRow("P2", "Pax2")];
    const db = makeDb(rels, drivers, passengers);
    const result = await buildGenealogyProjection("root", {}, db);

    expect(result.metrics.totalD2D).toBe(1);
    expect(result.metrics.totalD2P).toBe(2);
    expect(result.metrics.totalP2P).toBe(0);
    expect(result.metrics.totalDrivers).toBe(2);
    expect(result.metrics.totalPassengers).toBe(2);
    expect(result.metrics.totalRelationships).toBe(3);
  });

  it("node names are populated from bulk fetch", async () => {
    const rels: RelRow[] = [
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "D1", createdAt: T0 },
    ];
    const drivers = [makeDriverRow("root", "Pedro Paulo"), makeDriverRow("D1", "João Luiz")];
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", {}, db);

    expect(result.rootDriver.name).toBe("Pedro Paulo");
    const d1 = result.nodes.find((n) => n.actorId === "D1")!;
    expect(d1.name).toBe("João Luiz");
  });

  it("does NOT issue N+1 queries — exactly 2 DB calls (no passengers)", async () => {
    const rels: RelRow[] = [
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "B", createdAt: T0 },
    ];
    const drivers = [makeDriverRow("root", "Root"), makeDriverRow("A", "Alpha"), makeDriverRow("B", "Beta")];
    const db = makeDb(rels, drivers);
    await buildGenealogyProjection("root", {}, db);

    expect(db.referralRelationship.findMany).toHaveBeenCalledTimes(1);
    expect(db.driver.findMany).toHaveBeenCalledTimes(1);
    expect(db.passenger.findMany).toHaveBeenCalledTimes(0);
  });

  it("levels array uses { depth, nodeIds } shape and is sorted ascending", async () => {
    const rels: RelRow[] = [
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "A", invitedActorType: ActorType.DRIVER, invitedId: "B", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "B", invitedActorType: ActorType.DRIVER, invitedId: "C", createdAt: T0 },
    ];
    const drivers = [makeDriverRow("root", "R"), makeDriverRow("A", "A"), makeDriverRow("B", "B"), makeDriverRow("C", "C")];
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", {}, db);

    const depths = result.levels.map((l) => l.depth);
    expect(depths).toEqual([0, 1, 2, 3]);
    // nodeIds are strings (actor IDs)
    for (const lv of result.levels) {
      expect(Array.isArray(lv.nodeIds)).toBe(true);
      for (const id of lv.nodeIds) {
        expect(typeof id).toBe("string");
      }
    }
  });

  it("rootDriverId is stamped on every node", async () => {
    const rels: RelRow[] = [
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
    ];
    const drivers = [makeDriverRow("root", "Root"), makeDriverRow("A", "Alpha")];
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", {}, db);

    for (const node of result.nodes) {
      expect(node.rootDriverId).toBe("root");
    }
  });

  it("edge list matches relationship source→target with correct flowType", async () => {
    const rels: RelRow[] = [
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_PASSENGER, inviterActorType: ActorType.DRIVER, inviterId: "A", invitedActorType: ActorType.PASSENGER, invitedId: "P1", createdAt: T0 },
    ];
    const drivers = [makeDriverRow("root", "Root"), makeDriverRow("A", "Alpha")];
    const passengers = [makePaxRow("P1", "Pax")];
    const db = makeDb(rels, drivers, passengers);
    const result = await buildGenealogyProjection("root", {}, db);

    expect(result.edges).toEqual(
      expect.arrayContaining([
        { sourceActorId: "root", targetActorId: "A", flowType: ReferralFlowType.DRIVER_TO_DRIVER },
        { sourceActorId: "A", targetActorId: "P1", flowType: ReferralFlowType.DRIVER_TO_PASSENGER },
      ])
    );
  });

  it("stats object contains totalNodes, totalEdges, maxDepth, appliedDepthLimit", async () => {
    const db = makeDb([], [makeDriverRow("root", "Root")]);
    const result = await buildGenealogyProjection("root", { maxDepth: 3 }, db);

    expect(result.stats).toMatchObject({
      totalNodes: 1,
      totalEdges: 0,
      maxDepth: 0,
      appliedDepthLimit: 3,
    });
  });
});
