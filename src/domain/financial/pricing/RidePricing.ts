/**
 * RidePricing — Value Object Imutável
 *
 * Snapshot financeiro da corrida no momento em que foi calculado.
 * Persiste todos os valores efetivamente utilizados — nunca referências.
 *
 * Após calculado e persistido, NUNCA é alterado.
 * Mudança de preço gera um novo RidePricing.
 *
 * Invariante V1:
 *   driverNetAmount + platformFeeAmount === totalPassengerPrice
 *
 * Fórmula Canônica V1:
 *   total = ((distanceKm × COE × zoneMultiplier)
 *           × (1 + networkLiquidityFactor)) + platformFee
 */

import { RouteCalculatorProvider } from '../routing/RouteResult'
import { PricingSource } from './PricingPolicy'

/** Contexto de observabilidade do cálculo — PricingTrace */
export interface PricingTrace {
  /** Política utilizada */
  policyUsed: PricingSource
  /** Versão da política vigente no momento */
  policyVersion: string
  /** Adaptador de rota utilizado */
  calculatedBy: RouteCalculatorProvider
  /** Tempo de cálculo em ms — para diagnóstico de performance */
  calculationDurationMs: number
  /** Timestamp da requisição original */
  requestedAt: Date
}

export interface RidePricing {
  // ── Rota ────────────────────────────────────────────────────────────────
  distanceKm: number
  estimatedDurationMin: number

  // ── Custo Operacional (COE) ─────────────────────────────────────────────
  coeApplied: number
  baseOperationalCost: number

  // ── Ajustes aplicados ───────────────────────────────────────────────────
  zoneMultiplierApplied: number
  zoneAdjustment: number
  networkLiquidityFactor: number
  networkAdjustment: number

  // ── Resultado financeiro ─────────────────────────────────────────────────
  driverNetAmount: number
  platformFeeAmount: number
  totalPassengerPrice: number

  // ── Rastreabilidade ──────────────────────────────────────────────────────
  multipliersApplied: string[]
  pricingSource: PricingSource
  pricingPolicyVersion: string

  // ── Observabilidade ──────────────────────────────────────────────────────
  /** PricingTrace — contexto completo do cálculo para auditoria */
  pricingTrace: PricingTrace

  // ── Auditoria ────────────────────────────────────────────────────────────
  calculatedAt: Date
}

/**
 * Valida a invariante financeira V1.
 * Lança erro se violada — nunca persiste RidePricing inconsistente.
 *
 * V1: driverNetAmount + platformFeeAmount === totalPassengerPrice
 * Futuro: totalPassengerPrice = driverNetAmount + platformFeeAmount - discounts
 */
export function assertRidePricingInvariant(pricing: RidePricing): void {
  const expected = Math.round(
    (pricing.driverNetAmount + pricing.platformFeeAmount) * 100
  )
  const actual = Math.round(pricing.totalPassengerPrice * 100)

  if (expected !== actual) {
    throw new Error(
      `[RidePricing] Invariante financeira violada: ` +
      `driverNet(${pricing.driverNetAmount}) + ` +
      `platformFee(${pricing.platformFeeAmount}) ` +
      `= ${expected / 100} ≠ total(${pricing.totalPassengerPrice})`
    )
  }
}
