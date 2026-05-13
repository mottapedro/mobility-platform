import { Region } from "@prisma/client";
import { DriverRegionMatcher } from "../src/domain/services/DriverRegionMatcher";

const findManyMock = jest.fn();

jest.mock("../src/infra/prisma/client", () => ({
  prisma: {
    driver: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

describe("DriverRegionMatcher", () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it("returns only active drivers from the requested region in stable order", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "driver-zs-1",
        createdAt: new Date("2026-05-12T01:00:00.000Z"),
        regions: ["ZS"],
      },
      {
        id: "driver-zs-2",
        createdAt: new Date("2026-05-12T01:01:00.000Z"),
        regions: ["ZS"],
      },
    ]);

    const matcher = new DriverRegionMatcher();
    const matches = await matcher.execute({ region: "ZS" });

    expect(matches).toEqual([
      { driverId: "driver-zs-1", matchedRegion: Region.ZS },
      { driverId: "driver-zs-2", matchedRegion: Region.ZS },
    ]);
    expect(findManyMock).toHaveBeenCalledWith({
      where: { isActive: true },
      select: {
        id: true,
        createdAt: true,
        regions: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(new Set(matches.map((match) => match.driverId)).size).toBe(matches.length);
  });

  it("accepts textual aliases for the region", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "driver-zs-alias",
        createdAt: new Date("2026-05-12T01:02:00.000Z"),
        regions: ["ZS"],
      },
    ]);

    const matcher = new DriverRegionMatcher();
    const matches = await matcher.execute({ region: "Zona Sul" });

    expect(matches).toEqual([{ driverId: "driver-zs-alias", matchedRegion: Region.ZS }]);
  });

  it("collapses richer labels to the current Prisma enum set", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "driver-inter-1",
        createdAt: new Date("2026-05-12T01:03:00.000Z"),
        regions: ["INTER"],
      },
    ]);

    const matcher = new DriverRegionMatcher();
    const matches = await matcher.execute({ region: "Centro" });

    expect(matches).toEqual([{ driverId: "driver-inter-1", matchedRegion: Region.INTER }]);
    expect(findManyMock).toHaveBeenCalledWith({
      where: { isActive: true },
      select: {
        id: true,
        createdAt: true,
        regions: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("returns an empty list for unsupported regions", async () => {
    const matcher = new DriverRegionMatcher();
    const matches = await matcher.execute({ region: "Zona Leste" });

    expect(matches).toEqual([]);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
