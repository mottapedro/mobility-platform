/**
 * TripStage — Estados Internos do Trip Execution Domain
 *
 * Esses estados são ORTOGONAIS ao RideLifecycle público.
 * O RideStatus externo permanece IN_PROGRESS durante toda a execução.
 * O TripStage descreve o que acontece DENTRO desse estado.
 *
 * RideLifecycle (público):
 *   PENDING → ACCEPTED → IN_PROGRESS → COMPLETED
 *
 * TripStage (interno — dentro do IN_PROGRESS):
 *   NAVIGATING_TO_PICKUP → PICKUP_ARRIVED → PASSENGER_BOARDED
 *   → IN_TRIP → DESTINATION_ARRIVED → COMPLETED
 *
 * REGRA: Nunca alterar RIDE_LIFECYCLE_TRANSITIONS para acomodar
 * TripStage. São domínios separados.
 */

export const TripStage = {
  /** Motorista a caminho do passageiro */
  NAVIGATING_TO_PICKUP: "NAVIGATING_TO_PICKUP",

  /** Motorista chegou ao local de embarque */
  PICKUP_ARRIVED:       "PICKUP_ARRIVED",

  /** Passageiro confirmou embarque */
  PASSENGER_BOARDED:    "PASSENGER_BOARDED",

  /** Viagem em andamento — motorista a caminho do destino */
  IN_TRIP:              "IN_TRIP",

  /** Motorista chegou ao destino */
  DESTINATION_ARRIVED:  "DESTINATION_ARRIVED",

  /** Viagem encerrada — aguardando liquidação */
  COMPLETED:            "COMPLETED",
} as const

export type TripStage = (typeof TripStage)[keyof typeof TripStage]

/**
 * Matriz de transições válidas do TripStage.
 * Determinística — mesma entrada, mesma saída.
 */
export const TRIP_STAGE_TRANSITIONS: Readonly<
  Record<TripStage, readonly TripStage[]>
> = Object.freeze({
  NAVIGATING_TO_PICKUP: ["PICKUP_ARRIVED"],
  PICKUP_ARRIVED:       ["PASSENGER_BOARDED"],
  PASSENGER_BOARDED:    ["IN_TRIP"],
  IN_TRIP:              ["DESTINATION_ARRIVED"],
  DESTINATION_ARRIVED:  ["COMPLETED"],
  COMPLETED:            [],
})

export function isValidTripStageTransition(
  from: TripStage,
  to:   TripStage,
): boolean {
  return (TRIP_STAGE_TRANSITIONS[from] as readonly string[]).includes(to)
}

/**
 * Guarda de transição com mensagem de erro descritiva.
 * Lança erro se a transição for inválida — nunca silencia falhas de estado.
 */
export function assertTripStageTransition(
  from: TripStage,
  to:   TripStage,
): void {
  if (!isValidTripStageTransition(from, to)) {
    throw new Error(
      `[TripStage] Transição inválida: ${from} → ${to}. ` +
      `Transições permitidas: ${TRIP_STAGE_TRANSITIONS[from].join(", ") || "nenhuma"}`,
    )
  }
}
