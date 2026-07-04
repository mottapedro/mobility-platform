/**
 * HaversineRouteCalculator — Adaptador de Rota (Fase 3)
 *
 * Implementação inicial do RouteCalculator usando a fórmula de Haversine.
 * Calcula a distância em linha reta entre dois pontos geográficos.
 *
 * Adequado para a fase atual de validação operacional.
 * Substituível por Google Maps ou Mapbox sem alterar o PricingEngine.
 *
 * Limitações conhecidas (aceitas nesta fase):
 *   - Não considera rotas reais (vias, trânsito, pedágios)
 *   - Distância real de corrida é ~20-30% maior que linha reta urbana
 *   - Compensado pelo fator de correção urbanCorrectionFactor
 */

import { RouteCalculator } from '../RouteCalculator'
import { RouteResult } from '../RouteResult'

/** Raio médio da Terra em km */
const EARTH_RADIUS_KM = 6371

/**
 * Fator de correção para distância urbana.
 * A distância real percorrida em vias urbanas é ~25% maior
 * que a distância em linha reta (Haversine).
 */
const URBAN_CORRECTION_FACTOR = 1.25

/**
 * Velocidade média estimada em km/h para cálculo de duração.
 * Considera tráfego urbano moderado na Região Metropolitana do RJ.
 */
const AVERAGE_SPEED_KMH = 30

export class HaversineRouteCalculator implements RouteCalculator {
  async calculate(
    originLat: number,
    originLng: number,
    destinationLat: number,
    destinationLng: number
  ): Promise<RouteResult> {
    const straightLineKm = this.haversine(
      originLat,
      originLng,
      destinationLat,
      destinationLng
    )

    const distanceKm = parseFloat(
      (straightLineKm * URBAN_CORRECTION_FACTOR).toFixed(2)
    )

    const estimatedDurationMin = parseFloat(
      ((distanceKm / AVERAGE_SPEED_KMH) * 60).toFixed(0)
    )

    return {
      distanceKm,
      estimatedDurationMin,
      calculatedBy: 'haversine',
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
    lng2: number
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
