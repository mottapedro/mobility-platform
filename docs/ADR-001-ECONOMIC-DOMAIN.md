# ALIADO — ECONOMIC DOMAIN

## Architectural Decision Record (ADR)

**Documento:** ADR-001 — Economic Domain (MVP)
**Versão:** 1.0 (Frozen)
**Status:** ✅ Aprovado
**Tipo:** Architectural Decision Record (ADR)

---

# Objetivo

Estabelecer a arquitetura oficial do domínio econômico do Aliado para o MVP, definindo responsabilidades, regras financeiras e princípios de evolução.

Este documento torna-se a referência para todas as implementações futuras relacionadas ao Pricing, Settlement, Revenue e Reward Distribution.

---

# 1. Regra Financeira Única

Existe apenas uma regra financeira para formação do preço da corrida.

É proibida a coexistência de múltiplos motores financeiros produzindo resultados distintos para a mesma operação.

O Pricing Engine é a única autoridade responsável pela composição do preço.

---

# 2. Fonte Única da Verdade

O fluxo oficial de composição do preço é:

```
Pricing Engine
        │
        ▼
COE
        │
        ▼
Zone Multiplier
        │
        ▼
Liquidity Margin
        │
        ▼
Platform Fee
        │
        ▼
Total Passenger Price
```

Nenhum outro componente poderá recalcular preços, percentuais ou margens.

---

# 3. Modelo Econômico do MVP

O modelo econômico aprovado para o MVP é:

```
Preço Operacional

+

Taxa Operacional Cyborg

=

Preço Final Pago pelo Passageiro
```

A Taxa Operacional Cyborg será configurável pela plataforma e, para o MVP, permanecerá fixada em **R$ 2,50**.

Não serão utilizados percentuais para cálculo da taxa operacional.

---

# 4. Settlement

O Settlement não executa regras de precificação.

Sua única responsabilidade é liquidar os valores previamente persistidos pelo Pricing Engine.

É obrigatória a remoção do modelo percentual atualmente existente (80 / 15 / 5).

O Settlement utilizará exclusivamente os valores persistidos no Pricing Snapshot.

---

# 5. Pricing Snapshot

Toda corrida deverá possuir um Pricing Snapshot persistido.

O Pricing Snapshot representa uma fotografia imutável da composição financeira da corrida.

Após persistido, jamais poderá ser recalculado ou alterado.

Deverá armazenar, no mínimo:

* baseCOE
* zoneMultiplier
* liquidityMargin
* platformFee
* driverNetAmount
* totalPassengerPrice
* pricingVersion

---

# 6. Google Maps

O cálculo baseado em Haversine permanece válido para homologação.

A integração com Google Directions API será realizada em sprint posterior.

Essa decisão não impacta o modelo econômico.

---

# 7. Ordem de Evolução

Nenhuma implementação relacionada a:

* Ownership
* RevenueSplit V2
* RewardDistribution
* Passenger Cashback
* Economic Graph

poderá ser iniciada antes da unificação completa do modelo financeiro.

A unificação financeira é requisito obrigatório para a evolução do domínio econômico.

---

# 8. Ordem Oficial de Implementação

A implementação deverá ocorrer na seguinte sequência:

1. Eliminar o split percentual (80 / 15 / 5).
2. Unificar o Settlement utilizando a Taxa Operacional do MVP.
3. Implementar o Pricing Snapshot.
4. Atualizar DTOs, APIs e PaymentIntent para consumir os valores persistidos.
5. Evoluir para Settlement V2.
6. Implementar Ownership.
7. Implementar RevenueSplit.
8. Implementar RewardDistribution.

---

# 9. Passenger Referral Cashback (MVP)

## Objetivo

O Passenger Referral Cashback é uma política de aquisição e retenção de passageiros.

Ele não integra o Settlement operacional e jamais reduzirá a remuneração do motorista.

Arquiteturalmente pertence ao domínio:

```
RewardDistribution
```

---

## Princípio

Quando um passageiro indica outro passageiro, reduz o custo de aquisição (CAC) da plataforma.

Parte dessa economia poderá retornar ao passageiro indicador sob a forma de cashback.

```
Passageiro Indica Passageiro

↓

Novo Cliente Ativo

↓

Redução do CAC

↓

Cashback
```

---

## Ativação

O benefício somente será liberado após:

* cadastro concluído;
* onboarding concluído;
* pagamento confirmado;
* segunda corrida concluída e liquidada.

---

## Modelo Financeiro

O cashback será de **até 1%** do valor líquido da corrida.

Parâmetros do MVP:

* até 1% do valor líquido;
* limite máximo de R$ 10,00 por corrida;
* válido pelos primeiros 12 meses do passageiro indicado;
* apenas para corridas liquidadas.

O percentual poderá ser alterado futuramente por campanhas ou programas de fidelidade sem necessidade de alteração arquitetural.

---

## Origem do Recurso

O cashback será financiado exclusivamente pela Receita da Plataforma.

Jamais poderá reduzir:

* remuneração do motorista;
* remuneração do Root Driver;
* Settlement operacional.

Fluxo:

```
Preço Operacional

+

Taxa Operacional Cyborg

↓

Receita da Plataforma

↓

Fundo de Incentivos

↓

Passenger Cashback
```

---

## Carteira Virtual

O cashback será acumulado em carteira virtual.

No MVP poderá ser utilizado exclusivamente como crédito para novas corridas.

Funcionalidades futuras poderão incluir:

* saque via PIX;
* assinatura Premium;
* parceiros;
* marketplace;
* benefícios corporativos.

---

## Governança

Todo cashback deverá possuir rastreabilidade completa contendo:

* RewardId
* SettlementId
* PassengerId
* OriginPassengerId
* RideId
* PaymentId
* Timestamp
* Valor
* Status

Não poderá existir cashback sem Settlement previamente concluído.

---

# 10. Princípios Arquiteturais

## Single Source of Truth

Somente o Pricing Engine calcula preços.

---

## Imutabilidade

Nenhuma corrida poderá ter sua composição financeira recalculada após sua criação.

---

## Separação de Responsabilidades

Pricing Engine

→ calcula.

Settlement

→ liquida.

Ownership

→ determina propriedade econômica.

RevenueSplit

→ registra a distribuição financeira.

RewardDistribution

→ distribui incentivos, campanhas e cashback.

---

## Auditabilidade

Todo valor financeiro deverá ser rastreável desde:

* cálculo do preço;
* pagamento;
* settlement;
* distribuição;
* recompensa.

Nenhum valor poderá existir sem origem claramente identificada.

---

# 11. Compatibilidade com Produção

Toda evolução deverá respeitar a política oficial de migração incremental.

É proibido:

* recriar banco;
* apagar dados;
* resetar migrations;
* recalcular settlements históricos;
* alterar corridas já liquidadas.

Toda mudança deverá preservar integralmente os dados existentes em homologação e futura produção.

---

# Resultado Esperado

Ao final desta implementação, o domínio econômico do Aliado será organizado da seguinte forma:

```
Pricing Engine
        │
        ▼
Ride
        │
        ▼
Pricing Snapshot
        │
        ▼
Settlement
        │
        ▼
Revenue
        │
        ▼
RewardDistribution
        │
        ├── Driver Rewards
        ├── Root Driver Rewards
        ├── Passenger Cashback
        ├── Campaign Rewards
        └── Future Incentives
```

---

## Status

**ADR-001 — Economic Domain (MVP)**

* **Versão:** 1.0
* **Status:** Frozen
* **Aprovado para implementação**
