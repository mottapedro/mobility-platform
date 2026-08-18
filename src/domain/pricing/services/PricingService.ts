import { prisma } from "../../../infra/prisma/client";
import { RegionResolver } from "../../services/RegionResolver";
import { PricingEngine } from "../PricingEngine";
import type { RidePricing } from "../RidePricing";

export interface PricingServiceInput {
  distanceKm: number;
  estimatedDurationMin: number;
  originAddress: string;
  destinationAddress: string;
}

export interface PricingServiceResult extends RidePricing {
  originRegion: string;
  destinationRegion: string;
  availableDriversInZone: number;
}

export class PricingService {
  private readonly engine: PricingEngine;
  private readonly regionResolver: RegionResolver;

  constructor(engine?: PricingEngine, regionResolver?: RegionResolver) {
    this.engine = engine ?? new PricingEngine();
    this.regionResolver = regionResolver ?? new RegionResolver();
  }

  private async countAvailableDriversInZone(originRegion: string): Promise<number | undefined> {
    const zone = await prisma.operationalZone.findFirst({
      where: { name: originRegion, isActive: true },
      select: { id: true },
    });
    if (!zone) return undefined;
    return prisma.driverOperationalZone.count({ where: { zoneId: zone.id } });
  }

  async estimate(input: PricingServiceInput): Promise<PricingServiceResult> {
    const { distanceKm, estimatedDurationMin, originAddress, destinationAddress } = input;

    console.log("🧮 PricingService.estimate()", { distanceKm, estimatedDurationMin, originAddress, destinationAddress });

    const originRegion = this.regionResolver.resolve(originAddress);
    const destinationRegion = this.regionResolver.resolve(destinationAddress);
    const availableDriversInZone = await this.countAvailableDriversInZone(originRegion);

    console.log("📍 Regiões resolvidas", { originRegion, destinationRegion, availableDriversInZone });

    const ridePricing = await this.engine.calculate({
      distanceKm,
      estimatedDurationMin,
      originRegion,
      destinationRegion,
      availableDriversInZone,
    });

    return {
      ...ridePricing,
      originRegion,
      destinationRegion,
      availableDriversInZone: availableDriversInZone ?? 0,
    };
  }
}
