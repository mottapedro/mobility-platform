/**
 * Spec: graph-cycle-guard
 *
 * Verifies that buildGenealogyProjection() never emits duplicate nodes
 * or duplicate edges when the relationship data contains cycles or
 * multiple paths to the same actor.
 *
 * Coverage:
 *  - Direct back-edge cycle (A → B → A)
 *  - Self-referencing edge (A → A)
 *  - Diamond / re-convergence (root → A → C, root → B → C)
 *  - Ensures visited set is actor-type-scoped (same id, different types, kept separate)
 *  - Duplicate relationship rows for same pair — only one edge emitted
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
  drivers: { id: string; user: { name: string } }[] = [],
  passengers: { id: string; user: { name: string } }[] = []
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

const T0 = new Date("2024-01-01T00:00:00Z");

describe("graph-cycle-guard", () => {
  it("back-edge cycle (A→B→A): each actor appears exactly once", async () => {
    // root → A, A → B, B → A  (cycle back to A)
    const rels: RelRow[] = [
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "A", invitedActorType: ActorType.DRIVER, invitedId: "B", createdAt: T0 },
      // cycle: B → A
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "B", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
    ];
    const drivers = [
      { id: "root", user: { name: "Root" } },
      { id: "A", user: { name: "Alpha" } },
      { id: "B", user: { name: "Beta" } },
    ];
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", {}, db);

    const actorIds = result.nodes.map((n) => n.actorId);
    // No duplicates
    expect(new Set(actorIds).size).toBe(actorIds.length);
    // All three actors present
    expect(actorIds).toContain("root");
    expect(actorIds).toContain("A");
    expect(actorIds).toContain("B");
  });

  it("self-edge (A→A): self-reference is skipped entirely", async () => {
    const rels: RelRow[] = [
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
      // self-edge
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "A", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
    ];
    const drivers = [
      { id: "root", user: { name: "Root" } },
      { id: "A", user: { name: "Alpha" } },
    ];
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", {}, db);

    // A appears once
    const aNodes = result.nodes.filter((n) => n.actorId === "A");
    expect(aNodes).toHaveLength(1);

    // No self-loop edge
    const selfEdges = result.edges.filter(
      (e) => e.sourceActorId === e.targetActorId
    );
    expect(selfEdges).toHaveLength(0);
  });

  it("diamond graph (root→A→C, root→B→C): C appears once", async () => {
    const rels: RelRow[] = [
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "B", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "A", invitedActorType: ActorType.DRIVER, invitedId: "C", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "B", invitedActorType: ActorType.DRIVER, invitedId: "C", createdAt: T0 },
    ];
    const drivers = [
      { id: "root", user: { name: "Root" } },
      { id: "A", user: { name: "Alpha" } },
      { id: "B", user: { name: "Beta" } },
      { id: "C", user: { name: "Gamma" } },
    ];
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", {}, db);

    const cNodes = result.nodes.filter((n) => n.actorId === "C");
    expect(cNodes).toHaveLength(1);

    const allIds = result.nodes.map((n) => n.actorId);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("duplicate relationship rows for same pair → only one edge emitted", async () => {
    const rels: RelRow[] = [
      // Same pair listed twice (data integrity issue — should not crash or duplicate)
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: "A", createdAt: T0 },
    ];
    const drivers = [
      { id: "root", user: { name: "Root" } },
      { id: "A", user: { name: "Alpha" } },
    ];
    const db = makeDb(rels, drivers);
    const result = await buildGenealogyProjection("root", {}, db);

    // A appears once
    expect(result.nodes.filter((n) => n.actorId === "A")).toHaveLength(1);
    // Exactly one edge root→A
    const edgesToA = result.edges.filter((e) => e.targetActorId === "A");
    expect(edgesToA).toHaveLength(1);
  });

  it("actor-type scoping: same id as DRIVER and PASSENGER are treated as distinct nodes", async () => {
    // Unusual but defensive: same UUID used as both driver and passenger
    const sharedId = "actor-xyz";
    const rels: RelRow[] = [
      { flowType: ReferralFlowType.DRIVER_TO_DRIVER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.DRIVER, invitedId: sharedId, createdAt: T0 },
      { flowType: ReferralFlowType.DRIVER_TO_PASSENGER, inviterActorType: ActorType.DRIVER, inviterId: "root", invitedActorType: ActorType.PASSENGER, invitedId: sharedId, createdAt: T0 },
    ];
    const drivers = [
      { id: "root", user: { name: "Root" } },
      { id: sharedId, user: { name: "Driver version" } },
    ];
    const passengers = [{ id: sharedId, user: { name: "Passenger version" } }];
    const db = makeDb(rels, drivers, passengers);
    const result = await buildGenealogyProjection("root", {}, db);

    // One DRIVER node + one PASSENGER node with same actorId
    const driverNode = result.nodes.find(
      (n) => n.actorId === sharedId && n.actorType === ActorType.DRIVER
    );
    const passengerNode = result.nodes.find(
      (n) => n.actorId === sharedId && n.actorType === ActorType.PASSENGER
    );
    expect(driverNode).toBeDefined();
    expect(passengerNode).toBeDefined();
  });
});
