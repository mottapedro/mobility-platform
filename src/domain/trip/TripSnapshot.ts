/**
 * TripSnapshot — Fotografia Imutável da Execução
 *
 * Captura o estado completo da viagem em um momento específico.
 * Usado para auditoria, replay, observabilidade e diagnóstico.
 *
 * Princípio: se não pode ser observado, não deve existir.
 * Todo micro-estado da viagem gera um snapshot auditável.
 *
 * Imutabilidade:
 *   Após criado, nunca é alterado.
 *   Mudanças de estado geram novo TripSnapshot — nunca editam o anterior.
 */

import type { TripStage }   from "./TripStage"
import type { TripContext } from "./TripContext"

export interface StageDuration {
  stage:       TripStage
  startedAt:   Date
  endedAt:     Date
  durationSec: number
}

export interface TripSnapshot {
  // ── Identificação ─────────────────────────────────────────────────────
  rideId:       string
  rootDriverId: string           // genealogia operacional preservada
  driverId:     string
  passengerId:  string

  // ── Estado capturado ──────────────────────────────────────────────────
  stage:       TripStage
  capturedAt:  Date

  // ── Duração por estágio ────────────────────────────────────────────────
  /** Histórico de duração de cada estágio já concluído */
  stageDurations: StageDuration[]

  // ── Métricas de execução ───────────────────────────────────────────────
  /** Tempo total desde navigationStartedAt até capturedAt (segundos) */
  totalElapsedSec: number

  /** Distância percorrida até o momento (estimada ou real) */
  distanceTravelledKm?: number

  /** Desvio em relação ao ETA original (positivo = atraso em minutos) */
  delayMinutes?: number

  // ── Rastreabilidade de precificação ────────────────────────────────────
  pricingPolicyVersion: string   // ex: "v1"
  pricingSource:        string   // ex: "SYSTEM_DEFAULT"
}

/**
 * Produz um TripSnapshot a partir de um TripContext.
 * Função pura — sem side effects, sem I/O.
 */
export function buildTripSnapshot(
  ctx:  TripContext,
  now:  Date = new Date(),
): TripSnapshot {
  const totalElapsedSec = Math.round(
    (now.getTime() - ctx.startedAt.getTime()) / 1000,
  )

  const stageDurations = buildStageDurations(ctx)

  return {
    rideId:       ctx.rideId,
    rootDriverId: ctx.rootDriverId,
    driverId:     ctx.driverId,
    passengerId:  ctx.passengerId,
    stage:        ctx.currentStage,
    capturedAt:   now,
    stageDurations,
    totalElapsedSec,
    pricingPolicyVersion: ctx.pricingSnapshot.pricingPolicyVersion,
    pricingSource:        ctx.pricingSnapshot.pricingSource,
  }
}

/** Reconstrói as durações dos estágios a partir dos timestamps do contexto */
function buildStageDurations(ctx: TripContext): StageDuration[] {
  const durations: StageDuration[] = []
  const pairs: Array<{
    stage:     TripStage
    startedAt: Date | undefined
    endedAt:   Date | undefined
  }> = [
    {
      stage:     "NAVIGATING_TO_PICKUP",
      startedAt: ctx.navigationStartedAt,
      endedAt:   ctx.pickupArrivedAt,
    },
    {
      stage:     "PICKUP_ARRIVED",
      startedAt: ctx.pickupArrivedAt,
      endedAt:   ctx.boardingAt,
    },
    {
      stage:     "PASSENGER_BOARDED",
      startedAt: ctx.boardingAt,
      endedAt:   ctx.tripStartedAt,
    },
    {
      stage:     "IN_TRIP",
      startedAt: ctx.tripStartedAt,
      endedAt:   ctx.destinationArrivedAt,
    },
    {
      stage:     "DESTINATION_ARRIVED",
      startedAt: ctx.destinationArrivedAt,
      endedAt:   ctx.completedAt,
    },
  ]

  for (const { stage, startedAt, endedAt } of pairs) {
    if (startedAt && endedAt) {
      durations.push({
        stage,
        startedAt,
        endedAt,
        durationSec: Math.round(
          (endedAt.getTime() - startedAt.getTime()) / 1000,
        ),
      })
    }
  }

  return durations
}
