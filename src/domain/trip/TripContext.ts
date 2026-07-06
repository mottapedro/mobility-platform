/**
 * TripContext — Contexto Operacional da Viagem
 *
 * Value Object de entrada único do Trip Execution Domain.
 * Agrega tudo que o domínio precisa para orquestrar a execução.
 *
 * Princípio de Ownership:
 *   rootDriverId é imutável — propagado do RideRequest.rootDriverId.
 *   Mesmo que o driver executante mude, a genealogia operacional
 *   permanece congelada no momento da criação da corrida.
 *
 * Princípio de Snapshot:
 *   pricingSnapshot persiste os valores efetivos do momento da cotação.
 *   Nunca referenciar configurações globais — elas podem ter mudado.
 */

import type { TripStage } from "./TripStage"

export interface TripPricingSnapshot {
  totalPassengerPrice:  number
  driverNetAmount:      number
  platformFeeAmount:    number
  pricingPolicyVersion: string  // ex: "v1"
  pricingSource:        string  // ex: "SYSTEM_DEFAULT"
}

export interface TripContext {
  // ── Identidade ────────────────────────────────────────────────────────
  rideId:      string

  /** Driver raiz — imutável desde a criação da RideRequest */
  rootDriverId: string

  /** Driver executando a corrida (pode diferir do rootDriver em fallback) */
  driverId:    string

  passengerId: string

  // ── Localização ───────────────────────────────────────────────────────
  originLat:      number
  originLng:      number
  destinationLat: number
  destinationLng: number

  /** Endereços para exibição ao motorista */
  originAddress:      string
  destinationAddress: string

  // ── Precificação (snapshot imutável do momento da cotação) ────────────
  pricingSnapshot: TripPricingSnapshot

  // ── Estado atual ──────────────────────────────────────────────────────
  currentStage: TripStage
  startedAt:    Date

  // ── Timestamps de micro-estados (ADD ONLY — nunca remover) ───────────
  /** Momento em que o driver iniciou a navegação ao passageiro */
  navigationStartedAt?:  Date

  /** Momento em que o driver chegou ao local de embarque */
  pickupArrivedAt?:      Date

  /** Momento em que o passageiro confirmou embarque */
  boardingAt?:           Date

  /** Momento em que a viagem foi iniciada */
  tripStartedAt?:        Date

  /** Momento em que o driver chegou ao destino */
  destinationArrivedAt?: Date

  /** Momento em que a viagem foi encerrada */
  completedAt?:          Date
}
