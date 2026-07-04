/**
 * RidePricingConfig — Parâmetros de uma Política de Precificação
 *
 * Centraliza os PARÂMETROS operacionais de uma política.
 * Nunca hardcoded nos serviços — sempre injetado via PricingPolicy.
 *
 * Evolução futura: migrar para tabela pricing_configurations
 * com vigência por data, permitindo histórico de configurações.
 *
 * COE (Custo Operacional por Km) é o patrimônio intelectual da Cyborg.
 * Hoje é um número. Futuro: DriverOperationalProfile → OperationalCostEngine → COE.
 */

export interface RidePricingConfig {
  // ── Custo Operacional (COE) ─────────────────────────────────────────────
  /**
   * Custo Operacional por Km.
   * Representa quanto custa operar um veículo por quilômetro.
   * Futuro: calculado dinamicamente pelo DriverOperationalProfile.
   */
  coePerKm: number

  /**
   * Custo Operacional por Minuto.
   * Componente de duração para corridas mais lentas ou em trânsito.
   */
  coePerMinute: number

  /** Tarifa mínima garantida ao motorista independente da distância */
  minimumFare: number

  // ── Taxa da Plataforma ──────────────────────────────────────────────────
  /**
   * Taxa fixa da plataforma em reais (R$).
   * Transparente ao passageiro — exibida como "Taxa Cyborg".
   */
  platformFeeFixed: number

  // ── Multiplicadores de Zona ─────────────────────────────────────────────
  /**
   * Política operacional por zona.
   * NÃO é surge pricing — é uma política territorial explícita.
   */
  zoneMultipliers: ZoneMultipliers

  // ── Fator de Liquidez da Rede ───────────────────────────────────────────
  /**
   * Mede a disponibilidade de motoristas na rede.
   * Poucos motoristas → fator maior.
   * Muitos motoristas → fator menor.
   * Não é precificação dinâmica de oferta/demanda.
   */
  networkLiquidityFactor: number

  // ── Versionamento ───────────────────────────────────────────────────────
  /** Versão desta configuração de precificação — ex: "v1" */
  pricingVersion: string
}

export interface ZoneMultipliers {
  /** Zona urbana padrão — multiplicador base */
  urban: number            // ex: 1.0

  /** Regiões serranas — distância efetiva maior */
  mountain: number         // ex: 1.4

  /** Interior e zona rural */
  countryside: number      // ex: 1.7

  /** Corridas entre municípios */
  intermunicipal: number   // ex: 2.0

  /** Aeroportos — contexto operacional específico */
  airport: number          // ex: 1.2

  /** Retorno vazio após entrega */
  emptyReturn: number      // ex: 1.5
}
