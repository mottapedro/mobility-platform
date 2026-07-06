/**
 * HaversineNavigationAdapter — Adaptador inicial de Navegação
 *
 * Implementação do NavigationProvider usando a fórmula de Haversine.
 * Mesmo padrão do HaversineRouteCalculator no Financial Domain.
 *
 * Adequado para a fase atual de validação operacional.
 * Substituível por Google Maps ou Waze sem alterar o domínio.
 *
 * Limitações conhecidas (aceitas nesta fase):
 *   - Não considera rotas reais, trânsito ou vias
 *   - ETA baseado em velocidade média urbana
 *   - Sem deep link para app externo (retorna undefined)
 *   - Compensado pelo URBAN_CORRECTION_FACTOR
 *
 * Quando substituir:
 *   - Quando a experiência do motorista exigir ETA preciso
 *   - Quando deep links para Waze/Google Maps forem necessários
 *   - Sem alterar NavigationService ou TripExecutionService
 */

import type {
  NavigationProvider,
  NavigationInstruction,
} from "../NavigationProvider"

/** Raio médio da Terra em km */
const EARTH_RADIUS_KM = 6371

/**
 * Fator de correção para distância urbana.
 * Distância real em vias é ~25% maior que linha reta.
 */
const URBAN_CORRECTION_FACTOR = 1.25

/**
 * Velocidade média urbana estimada (km/h).
 * Considera tráfego moderado na Região Metropolitana do RJ.
 */
const AVERAGE_SPEED_KMH = 25

export class HaversineNavigationAdapter implements NavigationProvider {
  async getInstruction(
    fromLat: number,
    fromLng: number,
    toLat:   number,
    toLng:   number,
  ): Promise<NavigationInstruction> {
    const straightLineKm = this.haversine(fromLat, fromLng, toLat, toLng)
    const distanceKm     = parseFloat(
      (straightLineKm * URBAN_CORRECTION_FACTOR).toFixed(2),
    )
    const etaMinutes = Math.max(
      1,
      Math.round((distanceKm / AVERAGE_SPEED_KMH) * 60),
    )

    return {
      etaMinutes,
      distanceKm,
      deepLink:    undefined,   // sem deep link nesta fase
      provider:    "haversine_estimate",
      calculatedAt: new Date(),
    }
  }

  /**
   * Fórmula de Haversine — distância entre dois pontos em uma esfera.
   * Retorna distância em quilômetros.
   */
  private haversine(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180

    const dLat = toRad(lat2 - lat1)
    const dLng = toRad(lng2 - lng1)

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2)

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

    return EARTH_RADIUS_KM * c
  }
}
