# ALIADO — REWARD DISTRIBUTION

## Architectural Decision Record (ADR)

**Documento:** ADR-003 — Reward Distribution
**Versão:** 1.0 (Frozen)
**Status:** ✅ Aprovado
**Tipo:** Architectural Decision Record (ADR)
**Depende de:** ADR-001 (Pricing), ADR-002 (Ownership & Revenue Distribution)

---

# Contexto

A ADR-001 respondeu: **"Quanto custa a corrida?"**

A ADR-002 respondeu: **"Como a receita operacional é distribuída?"**

A ADR-003 responde: **"Como os incentivos são distribuídos e rastreados?"**

---

# 1. Princípio Central

Todo incentivo financeiro da plataforma — seja para motorista, passageiro, rede ou parceiro — passa pelo domínio **RewardDistribution**.

Nenhum componente fora desse domínio distribui incentivos diretamente.

---

# 2. Posição na Cadeia Econômica

```
Settlement
        │
        ▼
Revenue
        ├── platformCents   → Plataforma (operação)
        ├── driverCents     → Motorista (execução)
        └── rootDriverCents → Root Driver (rede)
        │
        ▼
RewardDistribution
        ├── Driver Bonus
        ├── Root Driver Reward
        ├── Passenger Cashback
        ├── Campaign Rewards
        ├── Corporate Rewards
        ├── Gamification
        └── Future Loyalty Programs
```

**Regra:** `RewardDistribution` consome receita da plataforma (Fundo de Incentivos). Jamais consome `driverCents` ou `rootDriverCents`.

---

# 3. Fundo de Incentivos

O cashback e os incentivos são financiados pela Receita da Plataforma.

```
Taxa Operacional Cyborg (R$2,50)
        │
        ▼
Receita da Plataforma
        │
        ├── Custo de Infraestrutura
        ├── Custo Operacional
        └── Fundo de Incentivos
                │
                ├── Passenger Cashback
                ├── Driver Bonus
                ├── Campanhas
                └── Fidelidade
```

Nenhum incentivo reduz:
* remuneração do Motorista;
* remuneração do Root Driver;
* Settlement operacional.

---

# 4. Catálogo de Incentivos (MVP e Futuro)

| Código | Tipo | Beneficiário | Base | Regra |
|--------|------|-------------|------|-------|
| `PASSENGER_CASHBACK_P2P` | Cashback | Passageiro indicador | driverNetAmount do indicado | até 1%, máx R$10, 12 meses |
| `DRIVER_BONUS_ONBOARDING` | Bônus | Motorista | fixo | R$ a definir por campanha |
| `DRIVER_BONUS_PERFORMANCE` | Bônus | Motorista | corridas/período | meta de corridas |
| `ROOT_DRIVER_EXTRA` | Bônus extra | Root Driver | driverNetAmount | campanhas premium |
| `CAMPAIGN_GENERIC` | Campanha | Qualquer ator | configurável | datas e regras da campanha |
| `CORPORATE_DISCOUNT` | Desconto | Passageiro PJ | fixo ou % | convênios corporativos |
| `GOVERNMENT_SUBSIDY` | Subsídio | Passageiro | fixo | convênios públicos |
| `FRANCHISE_SHARE` | Participação | Franqueado | configurável | modelo de franquia |
| `GAMIFICATION_BADGE` | Recompensa | Motorista / Passageiro | metas | conquistas e rankings |

---

# 5. Entidade RewardEvent

Todo incentivo distribuído gera um `RewardEvent` com rastreabilidade completa.

```
RewardEvent
├── id              String    (UUID)
├── rewardCode      String    (referencia catálogo: PASSENGER_CASHBACK_P2P, etc.)
├── settlementId    String?   (Settlement que originou — null para incentivos assíncronos)
├── beneficiaryType ActorType (DRIVER | PASSENGER | ROOT_DRIVER)
├── beneficiaryId   String    (FK para Driver ou Passenger)
├── originActorId   String?   (quem gerou o direito — ex: passageiro indicador)
├── rideId          String?   (corrida de referência)
├── paymentId       String?   (pagamento de referência)
├── amountCents     Int       (valor do incentivo em centavos)
├── status          RewardStatus (PENDING | CREDITED | EXPIRED | CANCELLED)
├── expiresAt       DateTime? (prazo para uso)
├── creditedAt      DateTime? (quando foi utilizado/sacado)
└── createdAt       DateTime
```

**Invariante:** nenhum `RewardEvent` pode existir sem `settlementId` confirmado (exceto incentivos administrativos com origem explícita).

---

# 6. Carteira Virtual (WalletBalance)

Recompensas do tipo cashback e bônus acumulam-se em carteira virtual por ator.

```
WalletBalance
├── actorType   ActorType
├── actorId     String
├── balanceCents Int      (saldo atual em centavos)
└── updatedAt   DateTime
```

**MVP:** saldo utilizável apenas como crédito em novas corridas.

**Futuro:**
* saque via PIX;
* assinatura Premium;
* marketplace de parceiros;
* benefícios corporativos;
* programas de fidelidade.

---

# 7. Passenger Cashback — Regra Oficial (MVP)

**Ativação:** somente após:
1. cadastro concluído;
2. onboarding concluído;
3. pagamento confirmado;
4. segunda corrida concluída e liquidada pelo passageiro indicado.

**Base de cálculo:**
```
cashbackCents = floor(driverNetAmount_cents_do_indicado × baseBps / 10_000)
```

**Parâmetros MVP:**
* `baseBps = 100` (1% do driverNetAmount)
* máximo por corrida: R$10,00 (1.000 cents)
* validade: 12 meses a partir da data da corrida do indicado
* somente corridas liquidadas

**Política:** `PASSENGER_CASHBACK_P2P` na entidade `RevenuePolicy`.

---

# 8. Invariantes Econômicos (documentação viva)

Os invariantes abaixo devem ser validados por testes automatizados e servem como contrato do domínio econômico.

| # | Invariante | Descrição |
|---|-----------|-----------|
| I-1 | `platformCents >= 0` | Taxa da plataforma nunca negativa |
| I-2 | `driverCents >= 0` | Remuneração do motorista nunca negativa |
| I-3 | `rootDriverCents >= 0` | Participação do root driver nunca negativa |
| I-4 | `platformCents + driverCents + rootDriverCents = totalCents` | Soma invariante — nenhum centavo perdido ou duplicado |
| I-5 | `platformCents = platformFee do Pricing Snapshot` | Taxa sempre proveniente do Snapshot; nunca recalculada |
| I-6 | `rootDriverCents <= driverNetAmount` | Root Driver nunca pode receber mais que o operacional inteiro |
| I-7 | Settlement nunca recalcula preço | O valor liquidado é sempre o do Pricing Snapshot |
| I-8 | Settlement nunca altera Pricing Snapshot | Imutabilidade do Snapshot após persistência |
| I-9 | `RewardEvent.amountCents` financiado pela Receita da Plataforma | Incentivos nunca reduzem driverCents ou rootDriverCents |
| I-10 | `RewardEvent` sem `settlementId` confirmado é inválido (exceto admin) | Rastreabilidade obrigatória |
| I-11 | `cashbackCents <= driverNetAmount_do_indicado` | Cashback nunca ultrapassa a receita operacional que o originou |
| I-12 | `cashbackCents <= 1_000` (R$10,00 máx por corrida no MVP) | Teto de cashback por corrida |

---

# 9. Separação de Responsabilidades (Atualizada)

```
Pricing Engine       → calcula quanto custa a corrida
Settlement           → liquida os valores do Pricing Snapshot
RevenuePolicy        → define as regras de distribuição da receita operacional
Ownership            → determina o proprietário econômico (rootDriverId)
RevenueSplit         → registra a distribuição financeira por beneficiário
RewardDistribution   → distribui incentivos, cashback e recompensas
WalletBalance        → acumula e controla o saldo virtual de cada ator
```

---

# 10. Ordem de Implementação

```
Fase 1 — Concluída (ADR-001 + ADR-002 encerradas)
  ✅ Pricing Engine unificado
  ✅ Pricing Snapshot persistido
  ✅ Settlement com taxa fixa
  ✅ RevenuePolicy (modelo de política)

Fase 2 — Settlement V2 (ADR-002 §9)
  [ ] Entidade RevenuePolicy no schema
  [ ] Seed ROOT_DRIVER_STANDARD (500 bps)
  [ ] RevenueSplitService com RevenuePolicy
  [ ] SettlementService resolve política + rootDriverCents
  [ ] 3 RevenueSplit rows quando rootDriverId != null

Fase 3 — RewardDistribution V1
  [ ] Entidade RewardEvent no schema
  [ ] Entidade WalletBalance no schema
  [ ] RewardDistributionService (PASSENGER_CASHBACK_P2P)
  [ ] Validação dos invariantes I-9 a I-12
  [ ] API de consulta de saldo e histórico

Fase 4 — Wallet & Uso
  [ ] Crédito de corrida via WalletBalance
  [ ] Expiração automática de RewardEvents
  [ ] Relatórios de incentivos por campanha

Fase 5 — Futuro (sem data)
  [ ] Saque PIX
  [ ] Marketplace de parceiros
  [ ] Gamificação
  [ ] Campanhas corporativas / governamentais
```

---

# 11. Compatibilidade com Produção

Toda implementação respeita a política de migração incremental da ADR-001 §11.

`RewardEvent` e `WalletBalance` são entidades novas — sem breaking change no schema existente.

---

## Status

**ADR-003 — Reward Distribution**

* **Versão:** 1.0
* **Status:** Frozen
* **Aprovado para implementação**
* **Pré-requisitos:** ADR-001 ✅ ADR-002 ✅
