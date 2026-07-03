/**
 * PricingEngine — Motor de Preços com Fatura Transparente
 *
 * Regra de Cálculo:
 *   COE (Custo Operacional Efetivo) = distância × R$ 1,20/km
 *   Coeficiente de Zona = 2.0 para viagens intermunicipais/serra; 1.0 caso contrário
 *   Margem de Liquidez = 20% (escassez normal) | 50%-60% (alta escassez, ≤2 motoristas na zona)
 *   Taxa da Plataforma = PLATFORM_FEE do .env, fallback R$ 2,50
 *
 * Saída: { totalPrice, breakdown: [{ label, value }] }
 */

import { prisma } from "../../infra/prisma/client";

// ─── Constantes de precificação ──────────────────────────────────────────────
const COE_PER_KM = 1.2;                  // R$ 1,20/km — custo operacional efetivo
const ZONE_COEFFICIENT_INTERCITY = 2.0;  // Multiplicador para viagens intermunicipais
const ZONE_COEFFICIENT_LOCAL = 1.0;      // Sem ajuste para viagens locais
const LIQUIDITY_MARGIN_NORMAL = 0.20;    // 20% — escassez normal
const LIQUIDITY_MARGIN_HIGH = 0.55;      // 55% — alta escassez (ponto médio 50%-60%)
const HIGH_SCARCITY_THRESHOLD = 2;        // ≤2 motoristas = alta escassez
const DEFAULT_PLATFORM_FEE = 2.50;       // Fallback se PLATFORM_FEE não definido

// ─── Tipos públicos ──────────────────────────────────────────────────────────

export interface PriceBreakdownItem {
  label: string;
  value: number;
}

export interface PriceOutput {
  totalPrice: number;
  breakdown: PriceBreakdownItem[];
}

export interface PricingInput {
  distanceKm: number;
  originRegion: string;
  destinationRegion: string;
  /** Número de motoristas aptos na zona filtrada (para margem de liquidez dinâmica) */
  availableDriversInZone?: number;
}

// ─── Motor de Preços ─────────────────────────────────────────────────────────

export class PricingEngine {
  /**
   * Verifica se a viagem cruza zonas intermunicipais, aplicando o coeficiente de esforço.
   */
  private isCrossZone(originRegion: string, destinationRegion: string): boolean {
    // Se origem e destino são regiões diferentes, é cross-zone
    if (originRegion !== destinationRegion) return true;

    // Se qualquer uma das regiões é classificada como intermunicipal, aplica coeficiente
    const intercityKeywords = ["intermunicipal", "serra", "petrópolis", "teresópolis", "nova friburgo"];
    const normalizedOrigin = originRegion.toLowerCase();
    const normalizedDest = destinationRegion.toLowerCase();

    return intercityKeywords.some(
      (kw) => normalizedOrigin.includes(kw) || normalizedDest.includes(kw)
    );
  }

  /**
   * Calcula o coeficiente de zona baseado nas regiões de origem e destino.
   * Em uma implementação futura, pode consultar o campo peso_esforco do
   * OperationalZone no banco de dados.
   */
  private async resolveZoneCoefficient(
    originRegion: string,
    destinationRegion: string
  ): Promise<{ coefficient: number; reason: string }> {
    if (this.isCrossZone(originRegion, destinationRegion)) {
      // Tenta buscar o peso_esforco configurado no banco para as zonas envolvidas
      const zoneNames = [originRegion, destinationRegion].filter(Boolean);
      const zones = await prisma.operationalZone.findMany({
        where: { name: { in: zoneNames }, isActive: true },
        select: { name: true, peso_esforco: true },
      });

      // Usa o maior peso_esforco encontrado entre as zonas
      const maxPeso = zones.reduce(
        (max, z) => Math.max(max, z.peso_esforco ?? ZONE_COEFFICIENT_INTERCITY),
        0
      );

      const coefficient = maxPeso > 0 ? maxPeso : ZONE_COEFFICIENT_INTERCITY;
      return {
        coefficient,
        reason: coefficient >= 2.0
          ? "Viagem intermunicipal — coeficiente de esforço aplicado para cobrir retorno vazio"
          : "Viagem intermunicipal — coeficiente padrão",
      };
    }

    return {
      coefficient: ZONE_COEFFICIENT_LOCAL,
      reason: "Viagem local — sem ajuste de zona",
    };
  }

  /**
   * Define a margem de liquidez com base na escassez de motoristas na zona.
   */
  private resolveLiquidityMargin(availableDriversInZone?: number): {
    margin: number;
    label: string;
  } {
    if (availableDriversInZone === undefined || availableDriversInZone === null) {
      return { margin: LIQUIDITY_MARGIN_NORMAL, label: "Margem de Liquidez (20%)" };
    }

    if (availableDriversInZone <= HIGH_SCARCITY_THRESHOLD) {
      return { margin: LIQUIDITY_MARGIN_HIGH, label: "Margem de Liquidez Premium (55%)" };
    }

    return { margin: LIQUIDITY_MARGIN_NORMAL, label: "Margem de Liquidez (20%)" };
  }

  /**
   * Lê a taxa da plataforma da variável de ambiente.
   */
  private resolvePlatformFee(): number {
    const envFee = process.env.PLATFORM_FEE;
    if (envFee) {
      const parsed = parseFloat(envFee);
      if (!isNaN(parsed) && parsed >= 0) return parsed;
    }
    return DEFAULT_PLATFORM_FEE;
  }

  /**
   * Calcula o preço final com breakdown detalhado.
   */
  async calculate(input: PricingInput): Promise<PriceOutput> {
    const { distanceKm, originRegion, destinationRegion, availableDriversInZone } = input;

    // 1. COE — Custo Operacional Efetivo base
    const baseCOE = distanceKm * COE_PER_KM;

    // 2. Coeficiente de Zona
    const { coefficient: zoneCoeff, reason: zoneReason } = await this.resolveZoneCoefficient(originRegion, destinationRegion);
    const adjustedCOE = baseCOE * zoneCoeff;
    const zoneAdjustmentValue = adjustedCOE - baseCOE;

    // 3. Margem de Liquidez
    const { margin: liquidityMargin, label: liquidityLabel } =
      this.resolveLiquidityMargin(availableDriversInZone);
    const liquidityValue = adjustedCOE * liquidityMargin;

    // 4. Taxa da Plataforma
    const platformFee = this.resolvePlatformFee();

    // 5. Total
    const totalPrice = Math.round((adjustedCOE + liquidityValue + platformFee) * 100) / 100;

    // 6. Montar breakdown
    const breakdown: PriceBreakdownItem[] = [];

    breakdown.push({
      label: "Custo de Deslocamento",
      value: Math.round(baseCOE * 100) / 100,
    });

    if (zoneAdjustmentValue > 0) {
      breakdown.push({
        label: zoneCoeff >= 2.0
          ? "Ajuste de Zona (intermunicipal ×2.0)"
          : `Ajuste de Zona (×${zoneCoeff})`,
        value: Math.round(zoneAdjustmentValue * 100) / 100,
      });
    }

    breakdown.push({
      label: liquidityLabel,
      value: Math.round(liquidityValue * 100) / 100,
    });

    breakdown.push({
      label: "Taxa da Plataforma",
      value: Math.round(platformFee * 100) / 100,
    });

    console.log("🔢 PricingEngine.calculate()", {
      distanceKm,
      originRegion,
      destinationRegion,
      zoneCoeff,
      zoneReason,
      baseCOE: Math.round(baseCOE * 100) / 100,
      adjustedCOE: Math.round(adjustedCOE * 100) / 100,
      liquidityMargin,
      platformFee: Math.round(platformFee * 100) / 100,
      totalPrice,
      breakdown,
    });

    return { totalPrice, breakdown };
  }
}
