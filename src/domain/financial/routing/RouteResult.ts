/**
 * RouteResult — Value Object de Resultado de Rota
 *
 * Transporta o resultado do cálculo de rota de forma imutável.
 * É a entrada principal do PricingEngine.
 *
 * Desacoplado do adaptador que o produziu — o PricingEngine
 * não precisa saber se veio de Haversine, Google Maps ou Mapbox.
 */

export type RouteCalculatorProvider =
  | 'haversine'
  | 'google_maps'
  | 'mapbox'
  | 'here'
  | 'openroute'

export interface RouteResult {
  distanceKm: number
  estimatedDurationMin: number
  calculatedBy: RouteCalculatorProvider
}
