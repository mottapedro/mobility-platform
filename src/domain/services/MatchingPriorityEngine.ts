import { prisma } from "../../infra/prisma/client";
import { DriverRegionMatcher } from "./DriverRegionMatcher";
import { getDriverNetwork } from "./DriverReferralService";
import { RegionResolver } from "./RegionResolver";

export type PriorityStartLevel = "NETWORK_L1" | "NETWORK_L2" | "NETWORK_L3" | "GENERAL";
export type MatchingCandidateStage = "REFERRAL_NETWORK" | "REGION" | "GLOBAL";

export type MatchingCandidate = {
  driverId: string;
  stage: MatchingCandidateStage;
  networkLevel?: 1 | 2 | 3;
  matchedRegion?: string;
};

type NetworkService = {
  getNetwork(driverId: string): Promise<{ level1: string[]; level2: string[]; level3: string[] }>;
};

export class MatchingPriorityEngine {
  constructor(
    private readonly regionResolver = new RegionResolver(),
    private readonly driverRegionMatcher = new DriverRegionMatcher(),
    private readonly networkService: NetworkService = { getNetwork: getDriverNetwork }
  ) {}

  async buildQueue(input: {
    rideId: string;
    origin: string;
    referredDriverId: string | null;
    startLevel: PriorityStartLevel;
    alreadyOfferedIds: Set<string>;
    excludedDriverIds: string[];
    rideContext: unknown;
    candidateDriverIds?: string[];
  }): Promise<MatchingCandidate[]> {
    const seen = new Set<string>([
      ...input.alreadyOfferedIds,
      ...input.excludedDriverIds,
    ]);
    const queue: MatchingCandidate[] = [];

    const network = input.referredDriverId
      ? await this.networkService.getNetwork(input.referredDriverId)
      : { level1: [], level2: [], level3: [] };

    const networkSlices: Record<PriorityStartLevel, Array<[1 | 2 | 3, string[]]>> = {
      NETWORK_L1: [[1, network.level1], [2, network.level2], [3, network.level3]],
      NETWORK_L2: [[2, network.level2], [3, network.level3]],
      NETWORK_L3: [[3, network.level3]],
      GENERAL: [],
    };

    for (const [level, driverIds] of networkSlices[input.startLevel]) {
      for (const driverId of driverIds) {
        if (seen.has(driverId)) {
          continue;
        }
        seen.add(driverId);
        queue.push({
          driverId,
          stage: "REFERRAL_NETWORK",
          networkLevel: level,
        });
      }
    }

    const resolvedRegion = this.regionResolver.resolve(input.origin);
    const regionalMatches = await this.driverRegionMatcher.execute({ region: resolvedRegion });

    for (const match of regionalMatches) {
      if (seen.has(match.driverId)) {
        continue;
      }
      if (input.candidateDriverIds?.length && !input.candidateDriverIds.includes(match.driverId)) {
        continue;
      }
      seen.add(match.driverId);
      queue.push({
        driverId: match.driverId,
        stage: "REGION",
        matchedRegion: match.matchedRegion,
      });
    }

    const globalDrivers = await prisma.driver.findMany({
      where: {
        isActive: true,
        ...(input.candidateDriverIds?.length
          ? { id: { in: input.candidateDriverIds.filter((id) => !seen.has(id)) } }
          : { id: { notIn: [...seen] } }),
      },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    for (const driver of globalDrivers) {
      if (seen.has(driver.id)) {
        continue;
      }
      seen.add(driver.id);
      queue.push({ driverId: driver.id, stage: "GLOBAL" });
    }

    return queue;
  }
}
