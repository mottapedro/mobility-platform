import { prisma } from "../src/infra/prisma/client";
import { MatchingPriorityEngine } from "../src/domain/services/MatchingPriorityEngine";

jest.mock("../src/infra/prisma/client", () => ({
  prisma: {
    driver: {
      findMany: jest.fn(),
    },
  },
}));

describe("MatchingPriorityEngine", () => {
  const driverFindManyMock = jest.mocked(prisma.driver.findMany);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("builds referral-network, region, then global candidates without duplicates", async () => {
    driverFindManyMock.mockResolvedValue([
      { id: "driver-global" },
      { id: "driver-dup" },
      { id: "driver-global-excluded" },
    ] as never);

    const engine = new MatchingPriorityEngine(
      { resolve: jest.fn().mockReturnValue("Zona Sul") } as never,
      { execute: jest.fn().mockResolvedValue([{ driverId: "driver-region", matchedRegion: "ZS" }]) } as never,
      { getNetwork: jest.fn().mockResolvedValue({ level1: ["driver-l1", "driver-dup"], level2: ["driver-l2"], level3: ["driver-dup", "driver-l3"] }) } as never
    );

    const queue = await engine.buildQueue({
      rideId: "ride-1",
      origin: "Copacabana",
      referredDriverId: "driver-direct",
      startLevel: "NETWORK_L1",
      alreadyOfferedIds: new Set(["driver-direct"]),
      excludedDriverIds: ["driver-global-excluded"],
      rideContext: null,
    });

    expect(queue.map((candidate) => [candidate.driverId, candidate.stage])).toEqual([
      ["driver-l1", "REFERRAL_NETWORK"],
      ["driver-dup", "REFERRAL_NETWORK"],
      ["driver-l2", "REFERRAL_NETWORK"],
      ["driver-l3", "REFERRAL_NETWORK"],
      ["driver-region", "REGION"],
      ["driver-global", "GLOBAL"],
    ]);
  });
});