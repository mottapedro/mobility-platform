/**
 * RouteCalculator — Port (Interface)
 *
 * Contrato para qualquer provedor de cálculo de rota.
 * Plugável — trocar o adaptador não altera o PricingEngine.
 *
 * Adaptadores disponíveis:
 *   HaversineRouteCalculator  ← Fase 3 (atual)
 *   GoogleMapsRouteCalculator ← Futuro
 *   MapboxRouteCalculator     ← Futuro
 */

import { RouteResult } from './RouteResult'

export interface RouteCalculator {
  calculate(
    originLat: number,
    originLng: number,
    destinationLat: number,
    destinationLng: number
  ): Promise<RouteResult>
}
