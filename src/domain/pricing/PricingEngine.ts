import { prisma } from "../../infra/prisma/client";
import { PRICING_CONFIG } from "./PricingConfiguration";
import type { RidePricing, PriceBreakdownItem } from "./RidePricing";

export type { PriceBreakdownItem } from "./RidePricing";

export interface PricingInput {
  distanceKm: number;
  estimatedDurationMin: number;
  originRegion: string;
  destinationRegion: string;
  availableDriversInZone?: number;
}

export class PricingEngine {
  private isCrossZone(originRegion: string, destinationRegion: string): boolean {
    if (originRegion !== destinationRegion) return true;
    const intercityKeywords = ["intermunicipal", "serra", "petrópolis", "teresópolis", "nova friburgo"];
    const norm = (s: string) => s.toLowerCase();
    return intercityKeywords.some(kw => norm(originRegion).includes(kw) || norm(destinationRegion).includes(kw));
  }

  private async resolveZoneCoefficient(
    originRegion: string,
    destinationRegion: string,
  ): Promise<{ coefficient: number; reason: string }> {
    if (this.isCrossZone(originRegion, destinationRegion)) {
      const zones = await prisma.operationalZone.findMany({
        where: { name: { in: [originRegion, destinationRegion].filter(Boolean) }, isActive: true },
        select: { peso_esforco: true },
      });
      const maxPeso = zones.reduce(
        (max, z) => Math.max(max, z.peso_esforco ?? PRICING_CONFIG.zoneCoefficients.intercity),
        0,
      );
      const coefficient = maxPeso > 0 ? maxPeso : PRICING_CONFIG.zoneCoefficients.intercity;
      return {
        coefficient,
        reason: coefficient >= 2.0
          ? "Viagem intermunicipal — coeficiente de esforço aplicado para cobrir retorno vazio"
          : "Viagem intermunicipal — coeficiente padrão",
      };
    }
    return { coefficient: PRICING_CONFIG.zoneCoefficients.local, reason: "Viagem local — sem ajuste de zona" };
  }

  private resolveLiquidityMargin(availableDriversInZone?: number): { margin: number; label: string } {
    if (availableDriversInZone == null || availableDriversInZone > PRICING_CONFIG.highScarcityThreshold) {
      return { margin: PRICING_CONFIG.liquidityMarginNormal, label: "Margem de Liquidez (20%)" };
    }
    return { margin: PRICING_CONFIG.liquidityMarginHigh, label: "Margem de Liquidez Premium (55%)" };
  }

  private resolvePlatformFee(): number {
    const parsed = parseFloat(process.env.PLATFORM_FEE ?? "");
    return !isNaN(parsed) && parsed >= 0 ? parsed : PRICING_CONFIG.platformFeeDefault;
  }

  private round(n: number): number {
    return Math.round(n * 100) / 100;
  }

  async calculate(input: PricingInput): Promise<RidePricing> {
    const { distanceKm, estimatedDurationMin, originRegion, destinationRegion, availableDriversInZone } = input;

    const baseCOE = distanceKm * PRICING_CONFIG.baseCostPerKm;

    const { coefficient: zoneCoeff, reason: zoneReason } = await this.resolveZoneCoefficient(
      originRegion,
      destinationRegion,
    );
    const baseFare = this.round(baseCOE * zoneCoeff);
    const zoneAdjustmentValue = this.round(baseFare - baseCOE);

    const { margin: liquidityMargin, label: liquidityLabel } = this.resolveLiquidityMargin(availableDriversInZone);
    const liquidityAmount = this.round(baseFare * liquidityMargin);

    const driverNetAmount = this.round(baseFare + liquidityAmount);
    const platformFee = this.round(this.resolvePlatformFee());
    const rawTotal = this.round(driverNetAmount + platformFee);
    const totalPassengerPrice = Math.max(rawTotal, PRICING_CONFIG.minimumFare);

    const breakdown: PriceBreakdownItem[] = [];
    breakdown.push({ label: "Custo de Deslocamento", value: this.round(baseCOE) });
    if (zoneAdjustmentValue > 0) {
      breakdown.push({
        label: zoneCoeff >= 2.0 ? "Ajuste de Zona (intermunicipal ×2.0)" : `Ajuste de Zona (×${zoneCoeff})`,
        value: zoneAdjustmentValue,
      });
    }
    breakdown.push({ label: liquidityLabel, value: liquidityAmount });
    breakdown.push({ label: "Taxa da Plataforma", value: platformFee });

    console.log("🔢 PricingEngine.calculate()", {
      distanceKm, originRegion, destinationRegion, zoneCoeff, zoneReason,
      baseCOE: this.round(baseCOE), baseFare, liquidityAmount, driverNetAmount, platformFee, totalPassengerPrice,
    });

    return {
      distanceKm,
      estimatedDurationMin,
      baseCOE: this.round(baseCOE),
      zoneMultiplier: zoneCoeff,
      liquidityMargin,
      liquidityAmount,
      baseFare,
      driverNetAmount,
      platformFee,
      totalPassengerPrice,
      pricingVersion: PRICING_CONFIG.pricingVersion,
      breakdown,
    };
  }
}
