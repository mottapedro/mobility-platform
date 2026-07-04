/**
 * PricingContext — Objeto único de entrada do PricingEngine
 *
 * Reduz acoplamento: o Engine recebe um único contrato em vez
 * de múltiplos parâmetros. Novas entradas futuras (promoções,
 * override manual) entram aqui sem alterar a assinatura do Engine.
 *
 * O PricingContext não contém lógica — é apenas um transportador
 * de intenção de cálculo.
 */

import { RouteResult } from '../routing/RouteResult'
import { RideContext, PricingSource } from './PricingPolicy'
import { RidePricingConfig } from './RidePricingConfig'

export interface PricingContext {
  /** Resultado do cálculo de rota — distância e duração */
  route: RouteResult

  /** Configuração de parâmetros resolvida pela PricingPolicy */
  config: RidePricingConfig

  /** Contexto operacional da corrida (zona, período, categoria) */
  rideContext: RideContext

  /** Timestamp da requisição de precificação */
  requestedAt: Date

  /** Origem da política aplicada — para rastreabilidade */
  pricingSource: PricingSource

  /** Versão da política aplicada — para auditoria histórica */
  pricingPolicyVersion: string
}
