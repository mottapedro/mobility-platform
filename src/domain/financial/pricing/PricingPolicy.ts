/**
 * PricingPolicy — Interface do Strategy Pattern de Precificação
 *
 * Representa a ESTRATÉGIA DE NEGÓCIO de precificação.
 * Cada política decide qual RidePricingConfig aplicar e se ela
 * é aplicável a um dado contexto de corrida.
 *
 * O PricingEngine nunca muda — muda-se a política.
 *
 * Hierarquia:
 *   PricingPolicy (esta interface)
 *   ├── DefaultPolicy          ← Fase 2
 *   ├── AirportPolicy          ← Futuro
 *   ├── ExecutivePolicy        ← Futuro
 *   ├── HourlyPolicy           ← Futuro
 *   ├── CorporatePolicy        ← Futuro
 *   └── PromotionalPolicy      ← Futuro
 */

import { RidePricingConfig } from './RidePricingConfig'

// Contexto da corrida disponível no momento da precificação
export interface RideContext {
  isAirport: boolean
  isVip: boolean
  isLuggage: boolean
  isAssistedTransport: boolean
  isNight: boolean          // 22h–06h
  isIntermunicipal: boolean
  zoneType: ZoneType
  scheduledAt: Date
}

export type ZoneType =
  | 'urban'
  | 'mountain'
  | 'countryside'
  | 'intermunicipal'
  | 'airport'
  | 'emptyReturn'

export type PricingSource =
  | 'SYSTEM_DEFAULT'
  | 'AIRPORT_POLICY'
  | 'EXECUTIVE_POLICY'
  | 'HOURLY_POLICY'
  | 'CORPORATE_POLICY'
  | 'PROMOTIONAL_POLICY'
  | 'MANUAL_OVERRIDE'

export interface PricingPolicy {
  /** Nome legível da política */
  readonly name: string

  /** Versão da política — ex: "v1", "v2" */
  readonly version: string

  /** Identificador de origem para rastreabilidade */
  readonly source: PricingSource

  /**
   * Retorna a configuração de parâmetros para o contexto dado.
   * Permite que políticas apliquem diferentes configs por contexto.
   */
  getConfig(context: RideContext): RidePricingConfig

  /**
   * Determina se esta política se aplica ao contexto da corrida.
   * O PricingEngine seleciona a primeira política aplicável.
   */
  appliesTo(context: RideContext): boolean
}
