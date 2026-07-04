/**
 * PricingEngine — Motor de Precificação do Financial Domain
 *
 * É o coração do domínio financeiro do ALIADO.
 * Responsabilidade única: orquestrar o pipeline e produzir RidePricing.
 *
 * REGRAS FUNDAMENTAIS:
 *   ✗ Não consulta banco de dados
 *   ✗ Não conhece adaptadores de rota (Haversine, Google Maps)
 *   ✗ Não contém if (airport) nem if (executive)
 *   ✗ Não conhece PricingPolicy — recebe config já resolvida
 *   ✓ Função pura — mesma entrada → mesma saída
 *   ✓ Determinístico — testável sem infraestrutura
 *   ✓ Auditável — todo cálculo exposto no snapshot
 *
 * Pipeline:
 *   1. baseOperationalCost  = distanceKm × coePerKm
 *   2. zoneAdjustment       = baseOperationalCost × zoneMultiplier
 *   3. networkAdjustment    = zoneAdjustment × (1 + networkLiquidityFactor)
 *   4. driverNetAmount      = max(networkAdjustment, minimumFare)
 *   5. totalPassengerPrice  = driverNetAmount + platformFeeFixed
 *
 * Fórmula Canônica V1:
 *   total = ((distanceKm × COE × zoneMultiplier)
 *           × (1 + networkLiquidityFactor))
 *           + platformFee
 *
 * Testabilidade (indicador de desacoplamento):
 *   const result = PricingEngine.calculate(context)
 *   // Sem banco. Sem Prisma. Sem HTTP. Sem Docker. Sem Google Maps.
 */

import { PricingContext } from './PricingContext'
import { RidePricing, assertRidePricingInvariant } from './RidePricing'
import { ZoneType } from './PricingPolicy'
import { ZoneMultipliers } from './RidePricingConfig'

export class PricingEngine {
  /**
   * Calcula o preço de uma corrida a partir do contexto de precificação.
   * Função pura — sem side effects, sem I/O.
   */
  static calculate(ctx: PricingContext): RidePricing {
    const start = Date.now()
    const { route, config, rideContext } = ctx

    // ── Etapa 1: Custo Operacional Base ──────────────────────────────────
    // baseOperationalCost = distanceKm × coePerKm
    const baseOperationalCost = round2(route.distanceKm * config.coePerKm)

    // ── Etapa 2: Ajuste de Zona ───────────────────────────────────────────
    // zoneAdjustment = baseOperationalCost × zoneMultiplier
    const zoneMultiplierApplied = resolveZoneMultiplier(
      rideContext.zoneType,
      config.zoneMultipliers
    )
    const zoneAdjustment = round2(baseOperationalCost * zoneMultiplierApplied)

    // ── Etapa 3: Ajuste de Liquidez da Rede ──────────────────────────────
    // networkAdjustment = zoneAdjustment × (1 + networkLiquidityFactor)
    const networkAdjustment = round2(
      zoneAdjustment * (1 + config.networkLiquidityFactor)
    )

    // ── Etapa 4: Ganho Líquido do Motorista ───────────────────────────────
    // driverNetAmount = max(networkAdjustment, minimumFare)
    const driverNetAmount = round2(
      Math.max(networkAdjustment, config.minimumFare)
    )

    // ── Etapa 5: Total ao Passageiro ─────────────────────────────────────
    // totalPassengerPrice = driverNetAmount + platformFeeFixed
    const platformFeeAmount = round2(config.platformFeeFixed)
    const totalPassengerPrice = round2(driverNetAmount + platformFeeAmount)

    // ── Multiplicadores aplicados (rastreabilidade) ───────────────────────
    const multipliersApplied = resolveMultipliersApplied(
      rideContext,
      zoneMultiplierApplied,
      config.networkLiquidityFactor
    )

    // ── Composição do snapshot ────────────────────────────────────────────
    const pricing: RidePricing = {
      // Rota
      distanceKm: route.distanceKm,
      estimatedDurationMin: route.estimatedDurationMin,

      // COE e custo base
      coeApplied: config.coePerKm,
      baseOperationalCost,

      // Ajustes
      zoneMultiplierApplied,
      zoneAdjustment,
      networkLiquidityFactor: config.networkLiquidityFactor,
      networkAdjustment,

      // Resultado financeiro
      driverNetAmount,
      platformFeeAmount,
      totalPassengerPrice,

      // Rastreabilidade
      multipliersApplied,
      pricingSource: ctx.pricingSource,
      pricingPolicyVersion: ctx.pricingPolicyVersion,

      // PricingTrace — observabilidade
      pricingTrace: {
        policyUsed: ctx.pricingSource,
        policyVersion: ctx.pricingPolicyVersion,
        calculatedBy: route.calculatedBy,
        calculationDurationMs: Date.now() - start,
        requestedAt: ctx.requestedAt,
      },

      calculatedAt: new Date(),
    }

    // Valida invariante antes de retornar — nunca produz snapshot inválido
    assertRidePricingInvariant(pricing)

    return pricing
  }
}

// ── Helpers privados ──────────────────────────────────────────────────────────

/** Arredonda para 2 casas decimais — evita floating point drift */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Resolve o multiplicador de zona a partir do ZoneType */
function resolveZoneMultiplier(
  zoneType: ZoneType,
  multipliers: ZoneMultipliers
): number {
  const map: Record<ZoneType, number> = {
    urban:           multipliers.urban,
    mountain:        multipliers.mountain,
    countryside:     multipliers.countryside,
    intermunicipal:  multipliers.intermunicipal,
    airport:         multipliers.airport,
    emptyReturn:     multipliers.emptyReturn,
  }
  return map[zoneType] ?? multipliers.urban
}

/** Resolve lista de multiplicadores efetivamente aplicados */
function resolveMultipliersApplied(
  ctx: import('./PricingPolicy').RideContext,
  zoneMultiplier: number,
  networkFactor: number
): string[] {
  const applied: string[] = []

  if (ctx.zoneType !== 'urban') applied.push(`zone:${ctx.zoneType}`)
  if (ctx.isNight)              applied.push('night')
  if (ctx.isAirport)            applied.push('airport')
  if (ctx.isVip)                applied.push('vip')
  if (ctx.isLuggage)            applied.push('luggage')
  if (ctx.isIntermunicipal)     applied.push('intermunicipal')
  if (zoneMultiplier !== 1.0)   applied.push(`zoneMultiplier:${zoneMultiplier}`)
  if (networkFactor > 0)        applied.push(`networkLiquidity:${networkFactor}`)

  return applied
}
