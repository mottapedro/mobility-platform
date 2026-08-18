/**
 * NavigationService — Coração do Trip Execution Domain
 *
 * Responsabilidade única: responder "Qual é o próximo passo do motorista?"
 *
 * Entrada:  TripContext + posição atual do driver
 * Saída:    TripExecutionInstruction
 *
 * REGRAS FUNDAMENTAIS:
 *   ✗ Não consulta banco de dados
 *   ✗ Não conhece adaptadores concretos (Haversine, Google Maps)
 *   ✗ Não contém lógica de pagamento ou precificação
 *   ✗ Não altera RideStatus externo
 *   ✓ Função pura — mesma entrada → mesma saída
 *   ✓ Determinístico — testável sem infraestrutura
 *   ✓ Delega cálculo de ETA/distância ao NavigationProvider injetado
 *
 * Testabilidade (indicador de desacoplamento):
 *   const instruction = await NavigationService.getInstruction(ctx, lat, lng)
 *   // Sem banco. Sem Prisma. Sem HTTP. Sem Google Maps.
 */

import type { TripContext }               from "../TripContext"
import type { TripStage }                 from "../TripStage"
import type { NavigationProvider }        from "./NavigationProvider"
import type { TripExecutionInstruction,
              TripAction }                from "./TripExecutionInstruction"

export interface DriverPosition {
  lat: number
  lng: number
}

export class NavigationService {
  constructor(private readonly provider: NavigationProvider) {}

  /**
   * Calcula a instrução de execução para o estágio atual da viagem.
   * Delega métricas de rota ao NavigationProvider injetado.
   */
  async getInstruction(
    ctx:      TripContext,
    driver:   DriverPosition,
  ): Promise<TripExecutionInstruction> {
    switch (ctx.currentStage) {

      case "NAVIGATING_TO_PICKUP": {
        const nav = await this.provider.getInstruction(
          driver.lat, driver.lng,
          ctx.originLat, ctx.originLng,
        )
        return {
          stage:       ctx.currentStage,
          title:       "Indo buscar o passageiro",
          subtitle:    `ETA ${nav.etaMinutes} min · ${nav.distanceKm} km`,
          etaMinutes:  nav.etaMinutes,
          distanceKm:  nav.distanceKm,
          action:      "OPEN_NAVIGATION",
          buttonLabel: "Abrir Navegação",
          deepLink:    nav.deepLink,
        }
      }

      case "PICKUP_ARRIVED": {
        return {
          stage:       ctx.currentStage,
          title:       "Você chegou ao local",
          subtitle:    "Aguardando o passageiro",
          action:      "CONFIRM_BOARDING",
          buttonLabel: "Confirmar Embarque",
        }
      }

      case "PASSENGER_BOARDED": {
        const nav = await this.provider.getInstruction(
          driver.lat, driver.lng,
          ctx.destinationLat, ctx.destinationLng,
        )
        return {
          stage:       ctx.currentStage,
          title:       "Passageiro embarcou",
          subtitle:    `Destino: ${ctx.destinationAddress}`,
          etaMinutes:  nav.etaMinutes,
          distanceKm:  nav.distanceKm,
          action:      "OPEN_NAVIGATION",
          buttonLabel: "Navegar ao Destino",
          deepLink:    nav.deepLink,
        }
      }

      case "IN_TRIP": {
        const nav = await this.provider.getInstruction(
          driver.lat, driver.lng,
          ctx.destinationLat, ctx.destinationLng,
        )
        return {
          stage:       ctx.currentStage,
          title:       "Em viagem",
          subtitle:    `ETA ${nav.etaMinutes} min · ${nav.distanceKm} km restantes`,
          etaMinutes:  nav.etaMinutes,
          distanceKm:  nav.distanceKm,
          action:      "OPEN_NAVIGATION",
          buttonLabel: "Navegar",
          deepLink:    nav.deepLink,
        }
      }

      case "DESTINATION_ARRIVED": {
        return {
          stage:       ctx.currentStage,
          title:       "Você chegou ao destino",
          subtitle:    ctx.destinationAddress,
          action:      "COMPLETE_TRIP",
          buttonLabel: "Finalizar Corrida",
        }
      }

      case "COMPLETED": {
        return {
          stage:       ctx.currentStage,
          title:       "Corrida encerrada",
          subtitle:    "Aguardando liquidação",
          action:      "NONE",
          buttonLabel: "",
        }
      }

      default: {
        // TypeScript exhaustiveness check — nunca deve chegar aqui
        const _exhaustive: never = ctx.currentStage
        throw new Error(
          `[NavigationService] TripStage não mapeado: ${String(_exhaustive)}`,
        )
      }
    }
  }
}
