import {
  isMatchableRideStatus,
  MatchRideUseCase,
} from "../src/application/use-cases/MatchRideUseCase";
import { prisma } from "../src/infra/prisma/client";

const getDriverNetworkMock = jest.fn();

jest.mock("../src/domain/services/DriverReferralService", () => ({
  getDriverNetwork: (...args: unknown[]) => getDriverNetworkMock(...args),
}));

jest.mock("../src/infra/prisma/client", () => ({
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

describe("MatchRideUseCase regional matching", () => {
  type RideState = {
    id: string;
    passengerId: string;
    origin: string;
    destination: string;
    status: string;
    context: null;
    currentDispatchStage: string | null;
    currentCandidateDriverId: string | null;
    rootDriverId: string | null;
  };
  type RideStateUpdate = {
    data: {
      currentDispatchStage?: string | null;
      currentCandidateDriverId?: string | null;
      status?: string;
    };
  };

  const rideRequestFindUniqueMock = jest.mocked(prisma.rideRequest.findUnique);
  const rideRequestUpdateMock = jest.mocked(prisma.rideRequest.update);
  const rideRequestUpdateManyMock = jest.mocked(prisma.rideRequest.updateMany);
  const rideOfferFindManyMock = jest.mocked(prisma.rideOffer.findMany);
  const rideOfferCreateMock = jest.mocked(prisma.rideOffer.create);
  const rideOfferCountMock = jest.mocked(prisma.rideOffer.count);
  const rideOfferUpdateManyMock = jest.mocked(prisma.rideOffer.updateMany);
  const driverFindManyMock = jest.mocked(prisma.driver.findMany);
  const driverOperationalZoneFindManyMock = jest.mocked(prisma.driverOperationalZone.findMany);
  const passengerFindUniqueMock = jest.mocked(prisma.passenger.findUnique);
  let rideState: RideState;

  beforeEach(() => {
    jest.clearAllMocks();
    getDriverNetworkMock.mockReset();
    rideState = {
      id: "ride-1",
      passengerId: "passenger-1",
      origin: "Copacabana",
      destination: "Barra da Tijuca",
      status: "PENDING",
      context: null,
      currentDispatchStage: null,
      currentCandidateDriverId: null,
      rootDriverId: null,
    };
    rideRequestFindUniqueMock.mockImplementation(
      (async () => ({ ...rideState })) as never
    );
    passengerFindUniqueMock.mockResolvedValue({ referredByDriverId: null } as never);
    rideOfferFindManyMock.mockResolvedValue([] as never);
    rideRequestUpdateMock.mockImplementation(
      (async ({ data }: RideStateUpdate) => {
        if (typeof data.currentDispatchStage === "string" || data.currentDispatchStage === null) {
          rideState.currentDispatchStage = data.currentDispatchStage;
        }
        if (typeof data.status === "string") {
          rideState.status = data.status;
        }
        if (
          typeof data.currentCandidateDriverId === "string" ||
          data.currentCandidateDriverId === null
        ) {
          rideState.currentCandidateDriverId = data.currentCandidateDriverId;
        }
        return { ...rideState };
      }) as never
    );
    rideRequestUpdateManyMock.mockImplementation(
      (async ({ data }: RideStateUpdate) => {
        if (typeof data.currentDispatchStage === "string" || data.currentDispatchStage === null) {
          rideState.currentDispatchStage = data.currentDispatchStage;
        }
        if (typeof data.status === "string") {
          rideState.status = data.status;
        }
        if (
          typeof data.currentCandidateDriverId === "string" ||
          data.currentCandidateDriverId === null
        ) {
          rideState.currentCandidateDriverId = data.currentCandidateDriverId;
        }
        return { count: 1 };
      }) as never
    );
    rideOfferCreateMock.mockResolvedValue({ id: "offer-1" } as never);
    rideOfferCountMock.mockResolvedValue(0 as never);
    rideOfferUpdateManyMock.mockResolvedValue({ count: 0 } as never);
    driverFindManyMock.mockResolvedValue([] as never);
    driverOperationalZoneFindManyMock.mockResolvedValue([] as never);
  });

  it("creates offers only for regional matches in matcher order", async () => {
    const regionResolver = { resolve: jest.fn().mockReturnValue("Zona Sul") };
    const driverRegionMatcher = {
      execute: jest.fn().mockResolvedValue([
        { driverId: "driver-2", matchedRegion: "ZS" },
        { driverId: "driver-1", matchedRegion: "ZS" },
      ]),
    };

    driverFindManyMock
      .mockResolvedValueOnce([{ id: "driver-global" }] as never)
      .mockResolvedValueOnce([
        { id: "driver-1", experienceLevel: "INICIANTE", vehicles: [] },
        { id: "driver-2", experienceLevel: "ELITE", vehicles: [] },
      ] as never)
      .mockResolvedValueOnce([
        { id: "driver-global", experienceLevel: "INTERMEDIARIO", vehicles: [] },
      ] as never);

    const useCase = new MatchRideUseCase(regionResolver as never, driverRegionMatcher as never);
    const result = await useCase.execute({ rideId: "ride-1", level: "GENERAL" });

    expect(regionResolver.resolve).toHaveBeenCalledWith("Copacabana");
    expect(driverRegionMatcher.execute).toHaveBeenCalledWith({ region: "Zona Sul" });
    expect(driverFindManyMock).toHaveBeenNthCalledWith(2, {
      where: {
        id: { in: ["driver-2", "driver-1"] },
        isActive: true,
      },
      select: { id: true, experienceLevel: true, vehicles: { select: { category: true } } },
    });
    // Governed sequential dispatch: only the first priority candidate receives an offer.
    expect(rideOfferCreateMock.mock.calls.map((call) => call[0].data.driverId)).toEqual(["driver-2"]);
    expect(rideState.status).toBe("WAITING_GENERAL");
    expect(result).toEqual(
      expect.objectContaining({
        outcome: "MATCHED",
        matched: true,
        level: "GENERAL",
        offerId: expect.any(String),
        driverId: expect.any(String),
      })
    );
  });

  it("falls back to the general pool when the regional matcher returns no candidates", async () => {
    const regionResolver = { resolve: jest.fn().mockReturnValue("Centro") };
    const driverRegionMatcher = {
      execute: jest.fn().mockResolvedValue([]),
    };

    driverFindManyMock
      .mockResolvedValueOnce([{ id: "driver-general" }] as never)
      .mockResolvedValueOnce([
        { id: "driver-general", experienceLevel: "INTERMEDIARIO", vehicles: [] },
      ] as never);

    const useCase = new MatchRideUseCase(regionResolver as never, driverRegionMatcher as never);
    const result = await useCase.execute({ rideId: "ride-1", level: "GENERAL", excludedDriverIds: ["driver-excluded"] });

    expect(driverFindManyMock).toHaveBeenNthCalledWith(1, {
      where: {
        isActive: true,
        id: { notIn: ["driver-excluded"] },
      },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(driverFindManyMock).toHaveBeenNthCalledWith(2, {
      where: {
        isActive: true,
        id: { in: ["driver-general"] },
      },
      select: { id: true, experienceLevel: true, vehicles: { select: { category: true } } },
    });
    expect(rideOfferCreateMock.mock.calls.map((call) => call[0].data.driverId)).toEqual(["driver-general"]);
    expect(rideState.status).toBe("WAITING_GENERAL");
    expect(result).toEqual(
      expect.objectContaining({
        outcome: "MATCHED",
        matched: true,
        level: "GENERAL",
        offerId: expect.any(String),
        driverId: expect.any(String),
      })
    );
  });

  it("falls back to region matches only after all referral-network candidates were already offered", async () => {
    rideState = {
      id: "ride-1",
      passengerId: "passenger-1",
      origin: "Copacabana",
      destination: "Barra da Tijuca",
      status: "MATCHING",
      context: null,
      currentDispatchStage: null,
      currentCandidateDriverId: null,
      rootDriverId: null,
    };
    passengerFindUniqueMock.mockResolvedValue({ referredByDriverId: "driver-direct" } as never);
    rideOfferFindManyMock.mockResolvedValue([
      { driverId: "driver-direct" },
      { driverId: "driver-l1" },
      { driverId: "driver-l2" },
      { driverId: "driver-l3" },
    ] as never);
    getDriverNetworkMock.mockResolvedValue({
      level1: ["driver-l1"],
      level2: ["driver-l2"],
      level3: ["driver-l3"],
    });

    const regionResolver = { resolve: jest.fn().mockReturnValue("Zona Sul") };
    const driverRegionMatcher = {
      execute: jest.fn().mockResolvedValue([{ driverId: "driver-region", matchedRegion: "ZS" }]),
    };

    driverFindManyMock
      .mockResolvedValueOnce([{ id: "driver-global" }] as never)
      .mockResolvedValueOnce([
        { id: "driver-region", experienceLevel: "INTERMEDIARIO", vehicles: [] },
      ] as never)
      .mockResolvedValueOnce([
        { id: "driver-global", experienceLevel: "INICIANTE", vehicles: [] },
      ] as never);

    const useCase = new MatchRideUseCase(regionResolver as never, driverRegionMatcher as never);
    const result = await useCase.execute({ rideId: "ride-1", level: "NETWORK_L1" });

    // Sequential dispatch: only the first region candidate is offered initially.
    expect(rideOfferCreateMock.mock.calls.map((call) => call[0].data.driverId)).toEqual(["driver-region"]);
    expect(rideState.status).toBe("WAITING_GENERAL");
    expect(result).toEqual(
      expect.objectContaining({
        outcome: "MATCHED",
        matched: true,
        level: "GENERAL",
        offerId: expect.any(String),
        driverId: expect.any(String),
      })
    );
  });

  it.each([
    "PENDING",
    "MATCHING",
    "WAITING_REFERRAL",
    "WAITING_PARTNER",
    "WAITING_GENERAL",
  ])("treats %s as matchable", async (status) => {
    expect(isMatchableRideStatus(status as never)).toBe(true);

    rideState.status = status;
    const regionResolver = { resolve: jest.fn().mockReturnValue("Zona Sul") };
    const driverRegionMatcher = { execute: jest.fn().mockResolvedValue([]) };
    await new MatchRideUseCase(regionResolver as never, driverRegionMatcher as never).execute({
      rideId: "ride-1",
      level: "GENERAL",
    });

    expect(driverRegionMatcher.execute).toHaveBeenCalled();
  });

  it.each(["ACCEPTED", "IN_PROGRESS", "COMPLETED", "CANCELLED"])(
    "does not redispatch %s rides",
    async (status) => {
      expect(isMatchableRideStatus(status as never)).toBe(false);

      rideState.status = status;
      const regionResolver = { resolve: jest.fn().mockReturnValue("Zona Sul") };
      const driverRegionMatcher = { execute: jest.fn().mockResolvedValue([]) };
      const result = await new MatchRideUseCase(
        regionResolver as never,
        driverRegionMatcher as never,
      ).execute({ rideId: "ride-1", level: "GENERAL" });

      expect(result).toEqual(
      expect.objectContaining({
        outcome: "STALE_LIFECYCLE",
        matched: false,
        level: "GENERAL",
        reason: expect.stringContaining("ride_status_not_matchable"),
      })
    );
    expect(driverRegionMatcher.execute).not.toHaveBeenCalled();
    expect(rideOfferCreateMock).not.toHaveBeenCalled();
    },
  );
});
