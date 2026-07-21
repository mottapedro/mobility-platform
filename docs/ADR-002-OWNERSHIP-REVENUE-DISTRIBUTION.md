# ALIADO — OWNERSHIP & REVENUE DISTRIBUTION

## Architectural Decision Record (ADR)

**Documento:** ADR-002 — Ownership & Revenue Distribution
**Versão:** 1.0 (Frozen)
**Status:** ✅ Aprovado
**Tipo:** Architectural Decision Record (ADR)
**Depende de:** ADR-001 — Economic Domain (MVP)

---

# Contexto

A ADR-001 respondeu: **"Quanto custa a corrida?"**

A ADR-002 responde: **"Como a receita operacional é distribuída?"**

---

# 1. Separação das Três Economias

O Settlement operará sobre três economias distintas e não intercambiáveis:

```
Plataforma   → recebe pela operação (Taxa Operacional Cyborg)
Motorista    → recebe pela execução da corrida
Root Driver  → recebe pela geração da rede
```

Essas três economias jamais se misturam.

---

# 2. Sequência Econômica Oficial

```
Preço Operacional
        +
Taxa Operacional Cyborg
        │
        ▼
Total Pago pelo Passageiro
        │
        ▼
Settlement
        │
        ├── Taxa Operacional → Plataforma  (sempre R$2,50)
        │
        └── Receita Operacional (driverNetAmount)
                │
                ├── Motorista Executor
                └── Root Driver (quando aplicável)
```

**Princípio:** a plataforma retira sua taxa operacional primeiro. Somente depois a receita operacional é distribuída entre Motorista e Root Driver.

---

# 3. Base de Cálculo do Root Driver

## Decisão

```
Base de Distribuição = driverNetAmount
```

## Proibido

```
Base = totalPassengerPrice  ← inclui a taxa da plataforma
Base = platformFee          ← pertence exclusivamente à plataforma
```

## Justificativa

O Root Driver participa da geração da rede operacional, não da receita da plataforma.
A Taxa Operacional Cyborg remunera a infraestrutura tecnológica e nunca integra a
base de distribuição da rede.

---

# 4. Exemplo Oficial

```
Preço Operacional   = R$32,50
Taxa Cyborg         = R$ 2,50
Total (passageiro)  = R$35,00
```

**Settlement:**

```
Plataforma  = R$2,50          (sempre fixo — ADR-001 §3)

Receita Operacional = R$32,50

Root Driver = 5% × R$32,50 = R$1,63
Motorista   = R$32,50 − R$1,63 = R$30,87
```

A plataforma recebe exatamente R$2,50. Sempre.

---

# 5. Modelo de Políticas (RevenuePolicy)

O percentual do Root Driver **não será gravado dentro do Settlement**.

Será gravado como uma **política de distribuição** referenciada pelo Settlement.

## Entidade RevenuePolicy

```
RevenuePolicy
├── code        String   (identificador único da política)
├── name        String   (nome legível)
├── baseBps     Int      (basis points sobre driverNetAmount)
├── isActive    Boolean
└── createdAt   DateTime
```

## Políticas do MVP

| Código | Nome | BPS | % |
|--------|------|-----|---|
| `ROOT_DRIVER_STANDARD` | Padrão | 500 | 5% |

## Políticas futuras (sem alteração de código)

| Código | Nome | BPS | % |
|--------|------|-----|---|
| `ROOT_DRIVER_PREMIUM` | Premium | 800 | 8% |
| `EMPRESA` | Empresa sem comissão | 0 | 0% |
| `CAMPANHA_LANCAMENTO` | Campanha de lançamento | 1000 | 10% |

A troca de política por corrida, motorista, região ou campanha ocorrerá via configuração de dados — sem deploy de código.

---

# 6. Fórmula de Distribuição

```
rootDriverCents = floor(driverNetAmount_cents × baseBps / 10_000)
driverCents     = driverNetAmount_cents − rootDriverCents
platformCents   = PLATFORM_FEE_CENTS  (R$2,50 — sempre fixo)
```

Invariante obrigatório:

```
platformCents + driverCents + rootDriverCents = totalCents
```

---

# 7. Quando Root Driver = null

Quando o passageiro não possui rootDriverId (corrida orgânica), `rootDriverCents = 0` e o motorista recebe `driverNetAmount` integralmente.

Não existe redistribuição para a plataforma do valor não-distribuído ao Root Driver.

---

# 8. Ownership

O `rootDriverId` é o identificador do proprietário econômico da corrida.

Regras:

* Determinado pelo `passenger.rootDriverId` no momento do Settlement.
* Congelado no registro do Settlement — imutável após a liquidação.
* `null` é um estado válido (corrida orgânica).
* Jamais recalculado após persistido.

---

# 9. Ordem Oficial de Implementação (Settlement V2)

```
1. Criar entidade RevenuePolicy no schema (ADD ONLY)
2. Seed da política ROOT_DRIVER_STANDARD (500 bps)
3. Atualizar RevenueSplitService para aceitar RevenuePolicy
4. Atualizar SettlementService para resolver a política e calcular rootDriverCents
5. Atualizar ProcessRideSettlementUseCase (mesma lógica de delegação)
6. Criar RevenueSplit row ROOT_DRIVER quando rootDriverId != null
7. Atualizar testes para modelo de 3 rows (quando rootDriverId presente)
8. Atualizar testes para modelo de 2 rows (quando rootDriverId null)
```

---

# 10. Invariantes

| Invariante | Descrição |
|-----------|-----------|
| I-1 | `platformCents = PLATFORM_FEE_CENTS` sempre |
| I-2 | `rootDriverCents = floor(driverNetAmount × policy.baseBps / 10_000)` |
| I-3 | `driverCents = driverNetAmount - rootDriverCents` |
| I-4 | `platformCents + driverCents + rootDriverCents = totalCents` |
| I-5 | `rootDriverId` congelado no Settlement — nunca atualizado após liquidação |
| I-6 | Quando `rootDriverId = null`, `rootDriverCents = 0` obrigatoriamente |
| I-7 | `platformFee` nunca integra base de cálculo da rede |

---

# 11. Princípios de Evolução

* Novos percentuais → nova entrada em `RevenuePolicy` (dados, não código)
* Novas campanhas → nova política com `code` específico (dados, não código)
* Hierarquia de políticas (por motorista, região, campanha) → resolvida por um `PolicyResolver` futuro
* A lógica de Settlement permanece estável independentemente das políticas

---

# 12. Compatibilidade com Produção

Toda implementação deverá respeitar a política de migração incremental da ADR-001 §11.

Settlements históricos com `rootDriverCents = 0` permanecem válidos — representam corridas liquidadas antes da ativação do Ownership V2.

---

## Status

**ADR-002 — Ownership & Revenue Distribution**

* **Versão:** 1.0
* **Status:** Frozen
* **Aprovado para implementação**
* **Pré-requisito:** ADR-001 encerrada ✅ (commit a7848aa)
