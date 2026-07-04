/**
 * RidePricing — Value Object Imutável
 *
 * É o SNAPSHOT FINANCEIRO da corrida no momento em que foi calculado.
 * Persiste todos os valores efetivamente utilizados — nunca referências.
 *
 * Após calculado e persistido, NUNCA é alterado.
 * Mudança de preço gera um novo RidePricing.
 *
 * Invariante V1:
 *   driverNetAmount + platformFeeAmount === totalPassengerPrice
 *
 * (Válida para Pricing Policy V1. Futuro com descontos:
 *   totalPassengerPrice = driverNetAmount + platformFeeAmount - discounts)
 *
 * Fórmula Canônica V1:
 *   total = ((distanceKm × COE × zoneMultiplier) × (1 + networkLiquidityFactor))
 *           + platformFee
 */

import { PricingSource } from './PricingPolicy'

export interface RidePricing {
  // ── Rota ────────────────────────────────────────────────────────────────
  distanceKm: number
  estimatedDurationMin: number

  // ── Custo Operacional (COE) ─────────────────────────────────────────────
  /** Valor do COE efetivamente aplicado no cálculo — snapshot */
  coeApplied: number

  /** distanceKm × coeApplied */
  baseOperationalCost: number

  // ── Ajustes aplicados ───────────────────────────────────────────────────
  /** Multiplicador de zona efetivamente aplicado */
  zoneMultiplierApplied: number

  /** baseOperationalCost × zoneMultiplierApplied */
  zoneAdjustment: number

  /** Fator de liquidez da rede efetivamente aplicado */
  networkLiquidityFactor: number

  /** zoneAdjustment × (1 + networkLiquidityFactor) */
  networkAdjustment: number

  // ── Resultado financeiro ─────────────────────────────────────────────────
  /** O que o motorista recebe. baseFare = networkAdjustment (≥ minimumFare) */
  driverNetAmount: number

  /** Taxa da plataforma efetivamente aplicada */
  platformFeeAmount: number

  /** Total pago pelo passageiro = driverNetAmount + platformFeeAmount */
  totalPassengerPrice: number

  // ── Rastreabilidade ──────────────────────────────────────────────────────
  /** Lista de multiplicadores aplicados — ex: ["airport", "night"] */
  multipliersApplied: string[]

  /** Qual política foi utilizada — ex: "AIRPORT_POLICY" */
  pricingSource: PricingSource

  /** Versão da política vigente no momento do cálculo — ex: "v1" */
  pricingPolicyVersion: string

  // ── Auditoria ────────────────────────────────────────────────────────────
  calculatedAt: Date
}

/**
 * Valida a invariante financeira V1.
 * Lança erro se violada — nunca persiste um RidePricing inconsistente.
 */
export function assertRidePricingInvariant(pricing: RidePricing): void {
  const expected = Math.round(
    (pricing.driverNetAmount + pricing.platformFeeAmount) * 100
  )
  const actual = Math.round(pricing.totalPassengerPrice * 100)

  if (expected !== actual) {
    throw new Error(
      `[RidePricing] Invariante financeira violada: ` +
      `driverNet(${pricing.driverNetAmount}) + platformFee(${pricing.platformFeeAmount}) ` +
      `= ${expected / 100} ≠ total(${pricing.totalPassengerPrice})`
    )
  }
}
