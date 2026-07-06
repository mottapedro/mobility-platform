/**
 * NavigationProvider — Port (Interface) de Navegação
 *
 * O domínio nunca conhece Google Maps, Waze ou Mapbox.
 * Conhece apenas NavigationProvider.
 *
 * Plugável — trocar o adaptador não altera o TripExecutionService.
 * Mesmo padrão do RouteCalculator no Financial Domain.
 *
 * Adaptadores:
 *   HaversineNavigationAdapter  ← Fase 2 (atual)
 *   GoogleMapsNavigationAdapter ← Futuro
 *   WazeDeepLinkAdapter         ← Futuro
 */

export type NavigationProviderType =
  | "haversine_estimate"
  | "google_maps"
  | "waze_deeplink"
  | "mapbox"
  | "here"

export interface NavigationInstruction {
  /** Tempo estimado de chegada em minutos */
  etaMinutes:   number

  /** Distância até o destino em km */
  distanceKm:   number

  /** Link direto para app externo de navegação (opcional) */
  deepLink?:    string

  /** Provedor que calculou esta instrução */
  provider:     NavigationProviderType

  /** Timestamp do cálculo — para cache e observabilidade */
  calculatedAt: Date
}

export interface NavigationProvider {
  /**
   * Retorna instrução de navegação entre dois pontos.
   *
   * @param fromLat  Latitude de origem (posição atual do driver)
   * @param fromLng  Longitude de origem
   * @param toLat    Latitude do destino
   * @param toLng    Longitude do destino
   */
  getInstruction(
    fromLat: number,
    fromLng: number,
    toLat:   number,
    toLng:   number,
  ): Promise<NavigationInstruction>
}
