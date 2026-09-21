// E6.2K.2A — MatchRide OWNER_RECOVERY authority separation.
// Proves candidate-empty paths perform NO OWNER_RECOVERY lifecycle write.
import { MatchRideUseCase } from "../../src/application/use-cases/MatchRideUseCase";
import { prisma } from "../../src/infra/prisma/client";

const getDriverNetworkMock = jest.fn();

jest.mock("../../src/domain/services/DriverReferralService", () => ({
  getDriverNetwork: (...args: unknown[]) => getDriverNetworkMock(...args),
}));

jest.mock("../../src/infra/prisma/client", () => ({
  prisma: {
    rideRequest: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    rideOffer: {
      findMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    driver: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    driverOperationalZone: {
      findMany: jest.fn(),
    },
    passenger: {
      findUnique: jest.fn(),
    },
  },
}));

describe("E6.2K.2A owner-recovery authority separation", () => {
  const rideRequestFindUniqueMock = jest.mocked(prisma.rideRequest.findUnique);
  const rideRequestUpdateManyMock = jest.mocked(prisma.rideRequest.updateMany);
  const rideOfferFindManyMock = jest.mocked(prisma.rideOffer.findMany);
  const driverFindManyMock = jest.mocked(prisma.driver.findMany);
  const passengerFindUniqueMock = jest.mocked(prisma.passenger.findUnique);

  const baseRide = {
    id: "ride-1",
    passengerId: "passenger-1",
    origin: "Copacabana",
    destination: "Barra",
    status: "PENDING",
    context: null,
    currentDispatchStage: null,
    currentCandidateDriverId: null,
    rootDriverId: null,
  };

  const ownerRecoveryWrites = () =>
    rideRequestUpdateManyMock.mock.calls.filter(
      (call) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "data" in (call[0] as object) &&
        (call[0] as { data: { currentDispatchStage?: string } }).data
          .currentDispatchStage === "OWNER_RECOVERY"
    );

  beforeEach(() => {
    jest.clearAllMocks();
    getDriverNetworkMock.mockReset();
    getDriverNetworkMock.mockResolvedValue({ level1: [], level2: [], level3: [] });
    rideRequestFindUniqueMock.mockResolvedValue({ ...baseRide } as never);
    passengerFindUniqueMock.mockResolvedValue({ referredByDriverId: null } as never);
    rideOfferFindManyMock.mockResolvedValue([] as never);
    driverFindManyMock.mockResolvedValue([] as never);
  });

  it("T1: NETWORK candidate-empty does NOT write OWNER_RECOVERY", async () => {
    const useCase = new MatchRideUseCase(
      { resolve: () => null } as never,
      { execute: jest.fn().mockResolvedValue([]) } as never
    );
    const result = await useCase.execute({ rideId: "ride-1", level: "NETWORK_L1" });
    expect(result.matched).toBe(false);
    expect(result.outcome).toBe("NO_MATCH_AVAILABLE");
    expect(ownerRecoveryWrites()).toHaveLength(0);
  });

  it("T2: GENERAL candidate-empty does NOT write OWNER_RECOVERY", async () => {
    const useCase = new MatchRideUseCase(
      { resolve: () => null } as never,
      { execute: jest.fn().mockResolvedValue([]) } as never
    );
    const result = await useCase.execute({ rideId: "ride-1", level: "GENERAL" });
    expect(result).toEqual(
      expect.objectContaining({
        outcome: "NO_MATCH_AVAILABLE",
        matched: false,
        level: "GENERAL",
        reason: "no_candidates_in_general_pool",
      })
    );
    expect(ownerRecoveryWrites()).toHaveLength(0);
  });

  it("T3: candidate-empty writes no other lifecycle consequence", async () => {
    const useCase = new MatchRideUseCase(
      { resolve: () => null } as never,
      { execute: jest.fn().mockResolvedValue([]) } as never
    );
    await useCase.execute({ rideId: "ride-1", level: "GENERAL" });
    const dataArgs = rideRequestUpdateManyMock.mock.calls.map(
      (call) => (call[0] as { data: Record<string, unknown> }).data
    );
    for (const data of dataArgs) {
      expect(data.status ?? null).not.toBe("CANCELLED");
      expect(data.status ?? null).not.toBe("EXPIRED");
      expect(data).not.toHaveProperty("selectedDriverId");
      expect(data).not.toHaveProperty("rootDriverId");
      expect(data).not.toHaveProperty("operationalOwnerId");
    }
  });

  it("T4: result compatibility preserved (matched=false + level)", async () => {
    const useCase = new MatchRideUseCase(
      { resolve: () => null } as never,
      { execute: jest.fn().mockResolvedValue([]) } as never
    );
    const network = await useCase.execute({ rideId: "ride-1", level: "NETWORK_L1" });
    expect(network.matched).toBe(false);
    expect(network.outcome).toBe("NO_MATCH_AVAILABLE");
    expect(typeof network.level).toBe("string");
    const general = await useCase.execute({ rideId: "ride-1", level: "GENERAL" });
    expect(general).toEqual(
      expect.objectContaining({
        outcome: "NO_MATCH_AVAILABLE",
        matched: false,
        level: "GENERAL",
        reason: "no_candidates_in_general_pool",
      })
    );
  });

  it("T5: caller-side writes untouched (RespondToRideOfferUseCase still owns its transition)", async () => {
    const fs = await import("fs");
    const path =
      "c:\\Users\\ATI\\OneDrive - Step Computer Academy Brasil\\mobility-platform\\src\\application\\use-cases\\RespondToRideOfferUseCase.ts";
    const src = fs.readFileSync(path, "utf8");
    expect(src).toContain("OWNER_RECOVERY");
  });
});
