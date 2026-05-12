import { MatchRideUseCase } from "../src/application/use-cases/MatchRideUseCase";
import { prisma } from "../src/infra/prisma/client";

jest.mock("../src/infra/prisma/client", () => ({
  prisma: {
    rideRequest: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    rideOffer: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    driver: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

describe("MatchRideUseCase regional matching", () => {
  const rideRequestFindUniqueMock = jest.mocked(prisma.rideRequest.findUnique);
  const rideRequestUpdateMock = jest.mocked(prisma.rideRequest.update);
  const rideOfferFindManyMock = jest.mocked(prisma.rideOffer.findMany);
  const rideOfferCreateMock = jest.mocked(prisma.rideOffer.create);
  const driverFindManyMock = jest.mocked(prisma.driver.findMany);

  beforeEach(() => {
    jest.clearAllMocks();
    rideRequestFindUniqueMock.mockResolvedValue({
      id: "ride-1",
      origin: "Copacabana",
      destination: "Barra da Tijuca",
      status: "PENDING",
      context: null,
      passenger: {
        referredByDriverId: null,
      },
    } as never);
    rideOfferFindManyMock.mockResolvedValue([] as never);
    rideRequestUpdateMock.mockResolvedValue({} as never);
    rideOfferCreateMock.mockResolvedValue({} as never);
  });

  it("creates offers only for regional matches in matcher order", async () => {
    const regionResolver = { resolve: jest.fn().mockReturnValue("Zona Sul") };
    const driverRegionMatcher = {
      execute: jest.fn().mockResolvedValue([
        { driverId: "driver-2", matchedRegion: "ZS" },
        { driverId: "driver-1", matchedRegion: "ZS" },
      ]),
    };

    driverFindManyMock.mockResolvedValueOnce([
      { id: "driver-1", experienceLevel: "INICIANTE", vehicles: [] },
      { id: "driver-2", experienceLevel: "ELITE", vehicles: [] },
    ] as never);

    const useCase = new MatchRideUseCase(regionResolver as never, driverRegionMatcher as never);
    const result = await useCase.execute({ rideId: "ride-1", level: "GENERAL" });

    expect(regionResolver.resolve).toHaveBeenCalledWith("Copacabana");
    expect(driverRegionMatcher.execute).toHaveBeenCalledWith({ region: "Zona Sul" });
    expect(driverFindManyMock).toHaveBeenCalledWith({
      where: {
        id: { in: ["driver-2", "driver-1"] },
        isActive: true,
      },
      select: { id: true, experienceLevel: true, vehicles: { select: { category: true } } },
    });
    expect(rideOfferCreateMock.mock.calls.map((call) => call[0].data.driverId)).toEqual(["driver-2", "driver-1"]);
    expect(result).toEqual({ matched: true, level: "GENERAL" });
  });

  it("falls back to the general pool when the regional matcher returns no candidates", async () => {
    const regionResolver = { resolve: jest.fn().mockReturnValue("Centro") };
    const driverRegionMatcher = {
      execute: jest.fn().mockResolvedValue([]),
    };

    driverFindManyMock.mockResolvedValueOnce([
      { id: "driver-general", experienceLevel: "INTERMEDIARIO", vehicles: [] },
    ] as never);

    const useCase = new MatchRideUseCase(regionResolver as never, driverRegionMatcher as never);
    const result = await useCase.execute({ rideId: "ride-1", level: "GENERAL", excludedDriverIds: ["driver-excluded"] });

    expect(driverFindManyMock).toHaveBeenCalledWith({
      where: {
        isActive: true,
        id: { notIn: ["driver-excluded"] },
      },
      select: { id: true, experienceLevel: true, vehicles: { select: { category: true } } },
    });
    expect(rideOfferCreateMock.mock.calls.map((call) => call[0].data.driverId)).toEqual(["driver-general"]);
    expect(result).toEqual({ matched: true, level: "GENERAL" });
  });
});