/**
 * TripExecutionInstruction — Instrução de Execução para o Motorista
 *
 * Saída do NavigationService.
 * O motorista nunca interpreta TripStage — recebe instrução e age.
 *
 * Princípio:
 *   O sistema responde "E agora?" em cada etapa.
 *   O motorista não pensa. O sistema guia.
 */

import type { TripStage } from "../TripStage"

export type TripAction =
  | "OPEN_NAVIGATION"      // abrir app de navegação externo
  | "CONFIRM_ARRIVAL"      // motorista chegou ao local
  | "CONFIRM_BOARDING"     // passageiro embarcou
  | "START_TRIP"           // iniciar viagem ao destino
  | "COMPLETE_TRIP"        // encerrar a corrida
  | "NONE"                 // aguardar — nenhuma ação disponível

export interface TripExecutionInstruction {
  // Estado atual para rastreabilidade interna
  stage:        TripStage

  // Conteúdo para o frontend renderizar
  title:        string          // ex: "Indo buscar o passageiro"
  subtitle?:    string          // ex: "ETA 6 min · 2,1 km"

  // Métricas de navegação
  etaMinutes?:  number
  distanceKm?:  number

  // Ação e botão
  action:       TripAction
  buttonLabel:  string          // ex: "Abrir Navegação"

  // Deep link para app externo (opcional — dependente do adaptador)
  deepLink?:    string
}
