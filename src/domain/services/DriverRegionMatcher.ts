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

// Build reverse map: Region enum → all alias strings that map to it
const REGION_TO_ALIASES: Record<Region, string[]> = {} as Record<Region, string[]>;
for (const [alias, region] of Object.entries(REGION_ALIASES)) {
  if (!REGION_TO_ALIASES[region]) REGION_TO_ALIASES[region] = [];
  REGION_TO_ALIASES[region].push(alias.toLowerCase());
}

function normalizeRegion(region: string): Region | null {
  const normalizedKey = region.trim().toUpperCase();
  return REGION_ALIASES[normalizedKey] ?? null;
}

function regionStringMatchesEnum(regionStr: string, target: Region): boolean {
  const normalized = regionStr.trim().toUpperCase();
  return REGION_ALIASES[normalized] === target;
}

export class DriverRegionMatcher {
  async execute(input: DriverRegionMatchInput): Promise<MatchedDriver[]> {
    const normalizedRegion = normalizeRegion(input.region);

    if (!normalizedRegion) {
      return [];
    }

    const drivers = await prisma.driver.findMany({
      where: { isActive: true },
      select: {
        id: true,
        createdAt: true,
        regions: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    const seenDriverIds = new Set<string>();
    const result: MatchedDriver[] = [];

    for (const driver of drivers) {
      if (seenDriverIds.has(driver.id)) continue;

      const hasRegion = driver.regions.some((r) => regionStringMatchesEnum(r, normalizedRegion));
      if (!hasRegion) continue;

      seenDriverIds.add(driver.id);
      result.push({ driverId: driver.id, matchedRegion: normalizedRegion });
    }

    return result;
  }
}
