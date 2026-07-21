# ALIADO — ECONOMIC ARCHITECTURE INDEX

**Documento:** ADR-000 — Economic Architecture Index
**Versão:** 1.0 (Living Document)
**Status:** ✅ Ativo — atualizado a cada novo ADR econômico
**Tipo:** Índice Arquitetural

---

## Propósito

Este documento organiza as quatro ADRs que formam o modelo econômico do Aliado
como um **único sistema arquitetural**, não como documentos independentes.

É o ponto de entrada para qualquer desenvolvedor que precise entender, modificar
ou evoluir qualquer parte do domínio financeiro da plataforma.

---

## Os Quatro Domínios

```text
Ownership
        │  "Quem é o proprietário econômico?"
        ▼
Pricing
        │  "Quanto custa a corrida?"
        ▼
Settlement / Revenue
        │  "Como a receita é distribuída?"
        ▼
Rewards
           "Como os incentivos são distribuídos?"
```

Cada domínio responde a exatamente uma pergunta.
Cada domínio tem seu próprio snapshot imutável.
Cada domínio é implementado por sua própria cadeia de responsabilidades.

---

## Índice dos ADRs

| ADR | Domínio | Pergunta central | Status |
| --- | ------- | ---------------- | ------ |
| [ADR-001](ADR-001-ECONOMIC-DOMAIN.md) | Pricing | Quanto custa a corrida? | ✅ Frozen |
| [ADR-002](ADR-002-OWNERSHIP-REVENUE-DISTRIBUTION.md) | Revenue Distribution | Como a receita operacional é distribuída? | ✅ Frozen v1.1 |
| [ADR-003](ADR-003-REWARD-DISTRIBUTION.md) | Reward Distribution | Como os incentivos são distribuídos e rastreados? | ✅ Frozen |
| [ADR-004](ADR-004-OWNERSHIP-RESOLUTION.md) | Ownership Resolution | Quem é o proprietário econômico desta corrida? | ✅ Frozen |

---

## Cadeia Completa de Auditabilidade

Toda corrida do Aliado deve permitir reconstruir a cadeia econômica completa
**sem depender do estado atual do banco**:

```text
Ride
        │
        ▼
OwnershipSnapshot         ADR-004  quem é o dono e como foi resolvido
        │
        ▼
PricingSnapshot           ADR-001  quanto custou
        │
        ▼
RevenuePolicy             ADR-002  qual política de distribuição foi aplicada
        │
        ▼
Settlement                ADR-002  como a receita foi liquidada e distribuída
        │
        ▼
RewardEvents              ADR-003  quais incentivos foram distribuídos
```

Cada snapshot é imutável.
Cada FK aponta para o registro exato que estava ativo no momento da transação.
Nenhuma consulta precisa reconstruir o estado — o estado foi gravado no momento certo.

---

## Princípios Compartilhados

### 1. Imutabilidade dos Snapshots

Cada domínio persiste um snapshot no momento da transação. Após criado, o snapshot
nunca é atualizado. Mudanças futuras nas regras de negócio afetam apenas transações futuras.

| Snapshot | Persistido quando | Conteúdo |
| -------- | ----------------- | -------- |
| `OwnershipSnapshot` | Criação da corrida | Quem é o owner e como foi resolvido |
| `PricingSnapshot` | Criação da corrida | Todos os campos do preço calculado |
| `RevenuePolicyId/Version` | Settlement | Qual política foi aplicada |
| `RewardEvent.settlementId` | Reward | Qual settlement originou o incentivo |

### 2. Políticas Dirigidas por Dados

Nenhuma regra de negócio econômica está codificada diretamente nos serviços.
As regras vivem em entidades de política (`RevenuePolicy`, `OwnershipPolicy`) e
são resolvidas dinamicamente.

Novos percentuais, novos tiers, novas campanhas → nova entrada de dados, sem deploy.

### 3. Single Source of Truth

Cada valor econômico tem exatamente uma fonte canônica:

| Valor | Fonte canônica |
| ----- | -------------- |
| Preço da corrida | `PricingSnapshot` (nunca recalculado) |
| Owner econômico | `OwnershipSnapshot` (nunca relido do Passenger) |
| Política de distribuição | `RevenuePolicyId` no Settlement |
| Split do motorista | `RevenueSplit` row DRIVER |
| Split da plataforma | `RevenueSplit` row PLATFORM |
| Split do root driver | `RevenueSplit` row ROOT_DRIVER |
| Incentivo distribuído | `RewardEvent` |

### 4. Separação das Três Economias

As três economias do Aliado nunca se misturam:

```text
Plataforma   → Taxa Operacional Cyborg (R$2,50 fixo — ADR-001 §3)
Motorista    → Receita pela execução da corrida
Root Driver  → Participação pela geração da rede
```

`Rewards` são financiados exclusivamente pela Receita da Plataforma.
`driverCents` e `rootDriverCents` nunca são reduzidos por incentivos.

### 5. Validation Gate como Contrato

Antes de qualquer Settlement, o `ValidationGate` (ADR-002 §9) verifica
que todos os invariantes I-1..I-8 e VG-1..VG-6 estão satisfeitos.
Se qualquer invariante falhar, o Settlement não é criado.

---

## Dependências entre ADRs

```text
ADR-001 (Pricing)
        │
        ├──▶ ADR-002 (Revenue)        Settlement lê o PricingSnapshot da ADR-001
        │         │
        │         └──▶ ADR-003 (Rewards)  Rewards leem o Settlement da ADR-002
        │
        └──▶ ADR-004 (Ownership)      Ownership é resolvido antes do Pricing e congelado
                  │
                  └──▶ ADR-002       Settlement lê o OwnershipSnapshot da ADR-004
```

**Regra de dependência:** um ADR nunca pode depender de um ADR com número maior.
ADR-004 não pode depender de ADR-001, ADR-002 ou ADR-003.
(Ownership é resolvido antes de tudo — é a primeira etapa da cadeia.)

---

## Invariantes do Sistema (Documentação Viva)

Os invariantes abaixo cobrem o sistema como um todo. Cada um tem testes
correspondentes em `tests/architecture/`.

### Pricing (I-P)

| # | Invariante |
| - | ---------- |
| I-P1 | `baseFare = baseCOE × zoneMultiplier` |
| I-P2 | `liquidityAmount = baseFare × liquidityMargin` |
| I-P3 | `driverNetAmount = baseFare + liquidityAmount` |
| I-P4 | `totalPassengerPrice = driverNetAmount + platformFee` (ou mínimo) |
| I-P5 | `platformFee` nunca integra `driverNetAmount` |
| I-P6 | `liquidityMargin ∈ {0.20, 0.55}` |
| I-P7 | `PRICING_CONFIG.platformFeeDefault × 100 = PLATFORM_FEE_CENTS` |

### Settlement / Revenue (I-1..I-8)

| # | Invariante |
| - | ---------- |
| I-1 | `platformCents >= 0` |
| I-2 | `driverCents >= 0` |
| I-3 | `rootDriverCents >= 0` |
| I-4 | `platformCents + driverCents + rootDriverCents = totalCents` |
| I-5 | `platformCents = PLATFORM_FEE_CENTS` sempre |
| I-6 | `rootDriverCents <= driverNetAmount` |
| I-7 | Settlement nunca recalcula preço |
| I-8 | Settlement não é criado sem `PricingSnapshot` |

### Validation Gate (VG)

| # | Código | Condição |
| - | ------ | -------- |
| VG-1 | `MissingPricingSnapshot` | Snapshot incompleto bloqueia Settlement |
| VG-2 | `NoPolicyApplicable` | Sem política vigente bloqueia Settlement |
| VG-3 | `SnapshotInconsistent` | `driverNetAmount ≠ total - platformFee` bloqueia Settlement |
| VG-4 | `SumInvariantViolated` | Soma dos splits ≠ total bloqueia Settlement |
| VG-5 | `RootDriverExceedsOperational` | `rootDriverCents > driverNetAmount` bloqueia |
| VG-6 | `PolicyMismatch` | rootDriverId presente + policy bps = 0 bloqueia |

### Revenue Policy (I-RP)

| # | Invariante |
| - | ---------- |
| I-RP1 | Política ativa dentro da vigência é sempre resolvida |
| I-RP2 | Política fora da vigência nunca é resolvida |
| I-RP3 | Política com `isActive = false` nunca é resolvida |
| I-RP4 | Entre múltiplas versões ativas, a de maior `version` prevalece |
| I-RP5 | `(code, version)` é a chave única — múltiplas versões do mesmo code permitidas |
| I-RP6 | Sem política vigente → `resolveForRide` retorna null → VG-2 bloqueia Settlement |

### Rewards (I-R / I-9..I-12)

| # | Invariante |
| - | ---------- |
| I-9 | Incentivos financiados pela Receita da Plataforma — nunca por `driverCents` |
| I-10 | `RewardEvent` sem `settlementId` é inválido (exceto admin) |
| I-11 | `cashbackCents <= driverNetAmount do indicado` |
| I-12 | `cashbackCents <= 1.000` (R$10,00 máx por corrida no MVP) |

### Ownership (IO)

| # | Invariante |
| - | ---------- |
| IO-1 | Cada corrida tem exatamente um `OwnershipSnapshot` |
| IO-2 | `OwnershipSnapshot` nunca é atualizado após criação |
| IO-3 | Settlement lê `ownerId` do `OwnershipSnapshot`, nunca do `Passenger` diretamente |
| IO-4 | `OwnershipResolver` é o único serviço autorizado a determinar ownership |
| IO-5 | `ownerId = null` é estado válido (corrida orgânica) |
| IO-6 | Mudanças no grafo não afetam snapshots já criados |
| IO-7 | `resolutionSource` identifica exatamente qual campo ou política foi usado |

---

## O que este índice NÃO É

- Não é um roadmap de produto.
- Não define regras de negócio específicas (percentuais, tiers, campanhas).
- Não substitui os ADRs individuais — é uma camada de navegação acima deles.
- Não define implementações — define o sistema como um conjunto coerente.

---

## Quando Criar um Novo ADR Econômico

Crie um novo ADR quando uma decisão:

1. Introduz um novo domínio (ex: `Wallet`, `Subscription`, `Marketplace`).
2. Altera um princípio compartilhado (imutabilidade, separação de economias).
3. Adiciona um novo tipo de snapshot imutável.

**Não** crie um ADR para:
- Novos percentuais ou políticas (→ nova `RevenuePolicy` ou `OwnershipPolicy` no banco).
- Novas campanhas ou incentivos (→ novo `RewardCode` no catálogo da ADR-003).
- Novos tiers de indicação (→ nova `OwnershipPolicy` na ADR-004).

---

**ADR-000 — Economic Architecture Index**
Versão: 1.0 | Status: Living Document
Mantido por: domínio econômico do Aliado
