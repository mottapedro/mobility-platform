import { Region } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";

export interface DriverRegionMatchInput {
  region: string;
}

export interface MatchedDriver {
  driverId: string;
  matchedRegion: Region;
}

const REGION_ALIASES: Record<string, Region> = {
  ZN: "ZN",
  "ZONA NORTE": "ZN",
  MEIER: "ZN",
  "MÉIER": "ZN",
  ZS: "ZS",
  "ZONA SUL": "ZS",
  COPACABANA: "ZS",
  ZO: "ZO",
  "ZONA OESTE": "ZO",
  "BARRA DA TIJUCA": "ZO",
  RECREIO: "ZO",
  BAIXADA: "BAIXADA",
  NITEROI: "INTER",
  "NITERÓI": "INTER",
  "SAO GONCALO": "INTER",
  "SÃO GONÇALO": "INTER",
  "REGIAO DOS LAGOS": "INTER",
  "REGIÃO DOS LAGOS": "INTER",
  CENTRO: "INTER",
  INTER: "INTER",
  INTERMUNICIPAL: "INTER",
};

function normalizeRegion(region: string): Region | null {
  const normalizedKey = region.trim().toUpperCase();
  return REGION_ALIASES[normalizedKey] ?? null;
}

export class DriverRegionMatcher {
  async execute(input: DriverRegionMatchInput): Promise<MatchedDriver[]> {
    const normalizedRegion = normalizeRegion(input.region);

    if (!normalizedRegion) {
      return [];
    }

    const drivers = await prisma.driver.findMany({
      where: {
        isActive: true,
        regions: {
          some: {
            region: normalizedRegion,
          },
        },
      },
      select: {
        id: true,
        createdAt: true,
        regions: {
          where: {
            region: normalizedRegion,
          },
          select: {
            region: true,
          },
          take: 1,
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    const seenDriverIds = new Set<string>();

    return drivers.flatMap((driver) => {
      if (seenDriverIds.has(driver.id)) {
        return [];
      }

      const matchedRegion = driver.regions[0]?.region;
      if (!matchedRegion) {
        return [];
      }

      seenDriverIds.add(driver.id);

      return [{
        driverId: driver.id,
        matchedRegion,
      }];
    });
  }
}
