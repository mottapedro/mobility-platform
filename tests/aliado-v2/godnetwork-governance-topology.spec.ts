jest.mock("../../src/infra/prisma/client", () => ({ prisma: {} }));

import {
  evaluateDirectD2DDriverChildren,
} from "../../scripts/network/audit-godnetwork-governance";
import { ActorType, ReferralFlowType } from "../../src/shared/enums";

type TopologyNode = Parameters<typeof evaluateDirectD2DDriverChildren>[0][number];

const JOAO_ID = "joao";
const EXPECTED_DRIVER_IDS = [
  "carlinhos",
  "jenner",
  "bira",
  "gisele",
  "fabio",
  "andre",
] as const;

function node(
  actorId: string,
  actorType: ActorType,
  flowType: ReferralFlowType,
  parentId: string | null = JOAO_ID
): TopologyNode {
  return { actorId, actorType, flowType, parentId };
}

const expectedDrivers = EXPECTED_DRIVER_IDS.map((id) =>
  node(id, ActorType.DRIVER, ReferralFlowType.DRIVER_TO_DRIVER)
);

describe("GodNetwork governance — joao-l2-children-exact", () => {
  it("passes with 6 D2D drivers and 1 D2P passenger under João", () => {
    const nodes = [
      ...expectedDrivers,
      node("official-passenger-2", ActorType.PASSENGER, ReferralFlowType.DRIVER_TO_PASSENGER),
    ];

    expect(
      evaluateDirectD2DDriverChildren(nodes, JOAO_ID, EXPECTED_DRIVER_IDS)
    ).toEqual({ actualDriverIds: [...EXPECTED_DRIVER_IDS], pass: true });
  });

  it("passes with 6 D2D drivers and multiple D2P passengers under João", () => {
    const nodes = [
      ...expectedDrivers,
      node("passenger-1", ActorType.PASSENGER, ReferralFlowType.DRIVER_TO_PASSENGER),
      node("passenger-2", ActorType.PASSENGER, ReferralFlowType.DRIVER_TO_PASSENGER),
      node("passenger-3", ActorType.PASSENGER, ReferralFlowType.DRIVER_TO_PASSENGER),
    ];

    expect(evaluateDirectD2DDriverChildren(nodes, JOAO_ID, EXPECTED_DRIVER_IDS).pass).toBe(true);
  });

  it("fails with a seventh D2D driver under João", () => {
    const nodes = [
      ...expectedDrivers,
      node("unexpected-driver", ActorType.DRIVER, ReferralFlowType.DRIVER_TO_DRIVER),
    ];

    expect(evaluateDirectD2DDriverChildren(nodes, JOAO_ID, EXPECTED_DRIVER_IDS).pass).toBe(false);
  });

  it("fails when an expected driver is replaced by another D2D driver", () => {
    const nodes = [
      ...expectedDrivers.slice(0, -1),
      node("replacement-driver", ActorType.DRIVER, ReferralFlowType.DRIVER_TO_DRIVER),
      node("passenger-1", ActorType.PASSENGER, ReferralFlowType.DRIVER_TO_PASSENGER),
    ];

    expect(evaluateDirectD2DDriverChildren(nodes, JOAO_ID, EXPECTED_DRIVER_IDS).pass).toBe(false);
  });
});
