/**
 * TripDomainEvents — Contratos de Eventos do Trip Execution Domain
 *
 * Fase 5 — Opção B: eventos como constantes TypeScript puras.
 * Desacoplados do Prisma nesta fase — entram no banco quando as
 * APIs da Fase 6 forem implementadas, em uma única migration coesa.
 *
 * Decisão arquitetural (Opção B):
 *   Os eventos existem como contratos de domínio agora.
 *   A persistência ocorre quando o ciclo estiver completo.
 *   Evita migration fragmentada antes das APIs existirem.
 *
 * Quando migrar para o schema Prisma (Fase 6):
 *   1. Adicionar valores ao enum DomainEventType no schema.prisma
 *   2. Executar: npx prisma migrate deploy
 *   3. Reiniciar o backend
 *   Nenhum código aqui precisará mudar — apenas a persistência é ativada.
 *
 * Padrão:
 *   Mesmo princípio do EngineSnapshot no Cyborg Sniper —
 *   contratos explícitos antes de infraestrutura.
 */

// ── Novos valores a adicionar em DomainEventType no schema.prisma (Fase 6) ──
//
//   NAVIGATION_STARTED
//   PICKUP_ARRIVED
//   PASSENGER_BOARDED
//   TRIP_STARTED
//   DESTINATION_ARRIVED
//   TRIP_COMPLETED

export const TripDomainEventType = {
  /** Driver iniciou navegação ao passageiro */
  NAVIGATION_STARTED:   "NAVIGATION_STARTED",

  /** Driver chegou ao local de embarque */
  PICKUP_ARRIVED:       "PICKUP_ARRIVED",

  /** Passageiro confirmou embarque */
  PASSENGER_BOARDED:    "PASSENGER_BOARDED",

  /** Viagem iniciada — driver a caminho do destino */
  TRIP_STARTED:         "TRIP_STARTED",

  /** Driver chegou ao destino */
  DESTINATION_ARRIVED:  "DESTINATION_ARRIVED",

  /** Viagem encerrada — pronto para liquidação */
  TRIP_COMPLETED:       "TRIP_COMPLETED",
} as const

export type TripDomainEventType =
  (typeof TripDomainEventType)[keyof typeof TripDomainEventType]

// ── Payload de cada evento ────────────────────────────────────────────────────

interface TripEventBase {
  rideId:      string
  rootDriverId: string    // ownership preservado em todo evento
  driverId:    string
  occurredAt:  Date
}

export interface NavigationStartedPayload extends TripEventBase {
  type: "NAVIGATION_STARTED"
  originLat:  number
  originLng:  number
}

export interface PickupArrivedPayload extends TripEventBase {
  type: "PICKUP_ARRIVED"
  arrivedAt: Date
}

export interface PassengerBoardedPayload extends TripEventBase {
  type: "PASSENGER_BOARDED"
  boardedAt: Date
}

export interface TripStartedPayload extends TripEventBase {
  type: "TRIP_STARTED"
  destinationLat: number
  destinationLng: number
  startedAt:      Date
}

export interface DestinationArrivedPayload extends TripEventBase {
  type: "DESTINATION_ARRIVED"
  arrivedAt: Date
}

export interface TripCompletedPayload extends TripEventBase {
  type: "TRIP_COMPLETED"
  completedAt:       Date
  totalDurationSec:  number
  distanceTravelledKm?: number
}

export type TripDomainEventPayload =
  | NavigationStartedPayload
  | PickupArrivedPayload
  | PassengerBoardedPayload
  | TripStartedPayload
  | DestinationArrivedPayload
  | TripCompletedPayload
