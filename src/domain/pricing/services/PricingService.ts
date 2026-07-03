/**
 * PricingService — Facade de conexão entre RideRequest e PricingEngine
 *
 * Orquestra:
 *   1. Resolução de região (origin/destination → nome da zona operacional)
 *   2. Contagem de motoristas aptos na zona de origem (para margem de liquidez dinâmica)
 *   3. Cálculo do preço via PricingEngine
 *   4. Persistência do resultado no RideRequest (priceEstimated)
 */

import { prisma } from "../../../infra/prisma/client";
import { RegionResolver } from "../../services/RegionResolver";
import { PricingEngine } from "../PricingEngine";
import type { PriceOutput } from "../PricingEngine";

export interface PricingServiceInput {
  /** Distância calculada em km (via haversine ou OSRM) */
  distanceKm: number;
  /** Endereço textual de origem (ex: "Rua Tal, Bairro, Cidade") */
  originAddress: string;
  /** Endereço textual de destino */
  destinationAddress: string;
}

export interface PricingServiceResult {
  /** Preço total estimado em reais */
  priceEstimated: number;
  /** Breakdown detalhado dos componentes do preço */
  breakdown: PriceOutput["breakdown"];
  /** Região de origem resolvida */
  originRegion: string;
  /** Região de destino resolvida */
  destinationRegion: string;
  /** Número de motoristas aptos na zona de origem */
  availableDriversInZone: number;
}

export class PricingService {
  private readonly engine: PricingEngine;
  private readonly regionResolver: RegionResolver;

  constructor(
    engine?: PricingEngine,
    regionResolver?: RegionResolver,
  ) {
    this.engine = engine ?? new PricingEngine();
    this.regionResolver = regionResolver ?? new RegionResolver();
  }

  /**
   * Conta motoristas ativos na zona operacional que cobre a região de origem.
   * Se não houver zonas configuradas, retorna undefined (fallback para margem normal).
   */
  private async countAvailableDriversInZone(originRegion: string): Promise<number | undefined> {
    const zone = await prisma.operationalZone.findFirst({
      where: { name: originRegion, isActive: true },
      select: { id: true },
    });

    if (!zone) return undefined;

    const count = await prisma.driverOperationalZone.count({
      where: { zoneId: zone.id },
    });

    return count;
  }

  /**
   * Calcula o preço estimado para uma corrida, integrando todas as fontes de dados.
   */
  async estimate(input: PricingServiceInput): Promise<PricingServiceResult> {
    const { distanceKm, originAddress, destinationAddress } = input;

    console.log("🧮 PricingService.estimate() iniciado", { distanceKm, originAddress, destinationAddress });

    // 1. Resolver regiões
    const originRegion = this.regionResolver.resolve(originAddress);
    const destinationRegion = this.regionResolver.resolve(destinationAddress);

    // 2. Contar motoristas aptos na zona de origem
    const availableDriversInZone = await this.countAvailableDriversInZone(originRegion);

    console.log("📍 Regioes resolvidas", { originRegion, destinationRegion, availableDriversInZone });

    // 3. Calcular preço via PricingEngine
    const result: PriceOutput = await this.engine.calculate({
      distanceKm,
      originRegion,
      destinationRegion,
      availableDriversInZone,
    });

    console.log("📊 PricingEngine breakdown", { totalPrice: result.totalPrice, breakdown: result.breakdown });

    return {
      priceEstimated: result.totalPrice,
      breakdown: result.breakdown,
      originRegion,
      destinationRegion,
      availableDriversInZone: availableDriversInZone ?? 0,
    };
  }
}
