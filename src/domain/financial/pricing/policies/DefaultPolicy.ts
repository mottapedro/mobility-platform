/**
 * DefaultPolicy — Política Padrão de Precificação V1
 *
 * Primeira implementação concreta de PricingPolicy.
 * Aplica-se a todas as corridas que não se enquadrem
 * em políticas mais específicas (Airport, Executive, etc.).
 *
 * Parâmetros iniciais baseados no modelo operacional do ALIADO.
 * Futuramente: carregar de tabela pricing_configurations com vigência.
 */

import { PricingPolicy, PricingSource, RideContext } from '../PricingPolicy'
import { RidePricingConfig } from '../RidePricingConfig'

const DEFAULT_CONFIG: RidePricingConfig = {
  // COE — Custo Operacional por Km (base Região Metropolitana RJ)
  coePerKm: 2.50,
  coePerMinute: 0.35,
  minimumFare: 12.00,

  // Taxa fixa da plataforma
  platformFeeFixed: 2.50,

  // Multiplicadores de zona operacional
  zoneMultipliers: {
    urban: 1.0,
    mountain: 1.4,
    countryside: 1.7,
    intermunicipal: 2.0,
    airport: 1.2,
    emptyReturn: 1.5,
  },

  // Fator de liquidez da rede — valor inicial conservador
  networkLiquidityFactor: 0.10,

  pricingVersion: 'v1',
}

export class DefaultPolicy implements PricingPolicy {
  readonly name = 'DefaultPolicy'
  readonly version = 'v1'
  readonly source: PricingSource = 'SYSTEM_DEFAULT'

  getConfig(_context: RideContext): RidePricingConfig {
    // DefaultPolicy usa a mesma config para qualquer contexto.
    // Políticas especializadas (AirportPolicy, etc.) sobrescreverão
    // parâmetros específicos conforme o contexto.
    return DEFAULT_CONFIG
  }

  appliesTo(_context: RideContext): boolean {
    // DefaultPolicy sempre se aplica — é o fallback final.
    // Deve ser registrada por último na cadeia de políticas do PricingEngine.
    return true
  }
}
