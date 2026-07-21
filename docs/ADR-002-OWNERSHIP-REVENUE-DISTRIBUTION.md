# ALIADO — OWNERSHIP & REVENUE DISTRIBUTION

**Documento:** ADR-002 — Ownership & Revenue Distribution
**Versão:** 1.1 (Frozen — refinamento pré-Settlement V2)
**Status:** ✅ Aprovado
**Tipo:** Architectural Decision Record (ADR)
**Depende de:** ADR-001 — Economic Domain (MVP)

---

## Contexto

A ADR-001 respondeu: **"Quanto custa a corrida?"**

A ADR-002 responde: **"Como a receita operacional é distribuída?"**

---

## 1. Separação das Três Economias

O Settlement operará sobre três economias distintas e não intercambiáveis:

```text
Plataforma   → recebe pela operação (Taxa Operacional Cyborg)
Motorista    → recebe pela execução da corrida
Root Driver  → recebe pela geração da rede
```

Essas três economias jamais se misturam.

---

## 2. Sequência Econômica Oficial

```text
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

## 3. Base de Cálculo do Root Driver

### Decisão

```text
Base de Distribuição = driverNetAmount
```

### Proibido

```text
Base = totalPassengerPrice  ← inclui a taxa da plataforma
Base = platformFee          ← pertence exclusivamente à plataforma
```

### Justificativa

O Root Driver participa da geração da rede operacional, não da receita da plataforma.
A Taxa Operacional Cyborg remunera a infraestrutura tecnológica e nunca integra a
base de distribuição da rede.

---

## 4. Exemplo Oficial

```text
Preço Operacional   = R$32,50
Taxa Cyborg         = R$ 2,50
Total (passageiro)  = R$35,00
```

**Settlement:**

```text
Plataforma  = R$2,50          (sempre fixo — ADR-001 §3)

Receita Operacional = R$32,50

Root Driver = 5% × R$32,50 = R$1,63
Motorista   = R$32,50 − R$1,63 = R$30,87
```

A plataforma recebe exatamente R$2,50. Sempre.

---

## 5. Modelo de Políticas (RevenuePolicy)

O percentual do Root Driver **não será gravado dentro do Settlement**.

Será gravado como uma **política de distribuição** referenciada pelo Settlement.

### Entidade RevenuePolicy (v1.1)

```text
RevenuePolicy
├── id              String    (UUID)
├── code            String    (identificador único — imutável após criação)
├── name            String    (nome legível)
├── version         Int       (incrementado a cada nova vigência do mesmo code)
├── baseType        String    (OPERATIONAL_REVENUE — base de cálculo; extensível)
├── rootDriverBps   Int       (basis points sobre baseType)
├── effectiveFrom   DateTime  (início de vigência — null = sempre ativa desde criação)
├── effectiveUntil  DateTime? (fim de vigência — null = sem data de encerramento)
├── isActive        Boolean
└── createdAt       DateTime
```

### Por que `version` e `effectiveFrom`/`effectiveUntil`?

Permitem versionamento e vigência temporal de políticas **sem alterar código**.

Exemplo: aumentar o Root Driver de 5% para 8% em uma campanha de verão:

1. Inserir nova linha `ROOT_DRIVER_PREMIUM, effectiveFrom: 2026-12-01, effectiveUntil: 2027-01-31`
2. Ao final da campanha, nenhuma mudança de código — a política expira automaticamente

### Por que `baseType`?

Permite que políticas futuras utilizem bases diferentes (ex: `GROSS_TOTAL` para modelos
de franquia) sem alterar a interface de `RevenueSplitService`.

### Pipeline oficial de distribuição

```text
Ride
        │
        ▼
Pricing Snapshot            ← "quanto existe para distribuir"
        │
        ▼
RevenuePolicy               ← "como distribuir"
        │
        ▼
RevenueSplitService         ← "executa a política"
        │
        ▼
Settlement
```

`RevenueSplitService` não conhece regras de negócio.
Ele apenas executa a política recebida como parâmetro.

### Políticas do MVP

| Código                 | Nome   | BPS | %  | baseType            |
| ---------------------- | ------ | --- | -- | ------------------- |
| `ROOT_DRIVER_STANDARD` | Padrão | 500 | 5% | OPERATIONAL_REVENUE |

### Políticas futuras (sem alteração de código)

| Código                  | Nome     | BPS          | %   | Cenário                |
| ----------------------- | -------- | ------------ | --- | ---------------------- |
| `ROOT_DRIVER_PREMIUM`   | Premium  | 800          | 8%  | Programa premium       |
| `ROOT_DRIVER_CAMPAIGN`  | Campanha | 1000         | 10% | Campanhas promocionais |
| `EMPRESA`               | Empresa  | 0            | 0%  | Convênios corporativos |
| `GOVERNMENT`            | Governo  | 0            | 0%  | Convênios públicos     |
| `FRANCHISE`             | Franquia | configurável | —   | Modelo de franquia     |

A troca de política por corrida, motorista, região ou campanha ocorrerá via configuração de dados — sem deploy de código.

---

## 6. Fórmula de Distribuição

```text
rootDriverCents = floor(driverNetAmount_cents × baseBps / 10_000)
driverCents     = driverNetAmount_cents − rootDriverCents
platformCents   = PLATFORM_FEE_CENTS  (R$2,50 — sempre fixo)
```

Invariante obrigatório:

```text
platformCents + driverCents + rootDriverCents = totalCents
```

---

## 7. Quando Root Driver = null

Quando o passageiro não possui rootDriverId (corrida orgânica), `rootDriverCents = 0` e o motorista recebe `driverNetAmount` integralmente.

Não existe redistribuição para a plataforma do valor não-distribuído ao Root Driver.

---

## 8. Ownership

O `rootDriverId` é o identificador do proprietário econômico da corrida.

Regras:

- Determinado pelo `passenger.rootDriverId` no momento do Settlement.
- Congelado no registro do Settlement — imutável após a liquidação.
- `null` é um estado válido (corrida orgânica).
- Jamais recalculado após persistido.

---

## 9. Validation Gate (pré-condição do Settlement)

Antes de criar qualquer `Settlement`, o sistema deve verificar as seguintes
condições. Se qualquer verificação falhar, o Settlement **não é criado** e um
erro descritivo é lançado.

| #    | Verificação                                                         | Erro se falhar                 |
| ---- | ------------------------------------------------------------------- | ------------------------------ |
| VG-1 | Existe `PricingSnapshot` válido (campos não nulos)                  | `MissingPricingSnapshot`       |
| VG-2 | Existe `RevenuePolicy` ativa e vigente no momento do Settlement     | `NoPolicyApplicable`           |
| VG-3 | `driverNetAmount = priceEstimated - platformFee`                    | `SnapshotInconsistent`         |
| VG-4 | `platformCents + driverCents + rootDriverCents = totalCents` (I-4)  | `SumInvariantViolated`         |
| VG-5 | `rootDriverCents <= driverNetAmount_cents` (I-6)                    | `RootDriverExceedsOperational` |
| VG-6 | Quando `rootDriverId != null`, a policy retorna `rootDriverBps > 0` | `PolicyMismatch`               |

O Validation Gate é implementado como uma função pura e testável, chamada
pelo `SettlementService` e pelo `ProcessRideSettlementUseCase` antes da
transação de escrita.

---

## 10. Ordem Oficial de Implementação (Settlement V2)

```text
0. Validation Gate (função pura — VG-1 a VG-6)
1. Criar entidade RevenuePolicy no schema (ADD ONLY — com version, baseType,
   effectiveFrom, effectiveUntil)
2. Migration + Seed ROOT_DRIVER_STANDARD (500 bps, OPERATIONAL_REVENUE)
3. RevenueSplitService: aceita RevenuePolicy como parâmetro; não conhece
   regras de negócio — apenas executa a política
4. SettlementService: resolve RevenuePolicy vigente + chama Validation Gate +
   calcula rootDriverCents = floor(driverNetAmount × policy.rootDriverBps / 10_000)
5. ProcessRideSettlementUseCase: mesma delegação (resolve policy, chama gate)
6. Criar RevenueSplit row ROOT_DRIVER quando rootDriverId != null
7. Testes: 3 rows quando rootDriverId presente, 2 rows quando null
8. Testes dos invariantes I-1 a I-8 como suite dedicada
```

---

## 11. Invariantes

| Invariante | Descrição |
| ---------- | --------- |
| I-1 | `platformCents = PLATFORM_FEE_CENTS` sempre |
| I-2 | `rootDriverCents = floor(driverNetAmount × policy.baseBps / 10_000)` |
| I-3 | `driverCents = driverNetAmount - rootDriverCents` |
| I-4 | `platformCents + driverCents + rootDriverCents = totalCents` |
| I-5 | `rootDriverId` congelado no Settlement — nunca atualizado após liquidação |
| I-6 | Quando `rootDriverId = null`, `rootDriverCents = 0` obrigatoriamente |
| I-7 | `platformFee` nunca integra base de cálculo da rede |

---

## 12. Princípios de Evolução

- Novos percentuais → nova entrada em `RevenuePolicy` (dados, não código)
- Novas campanhas → nova política com `code` específico (dados, não código)
- Hierarquia de políticas (por motorista, região, campanha) → resolvida por um `PolicyResolver` futuro
- A lógica de Settlement permanece estável independentemente das políticas

---

## 13. Compatibilidade com Produção

Toda implementação deverá respeitar a política de migração incremental da ADR-001 §11.

Settlements históricos com `rootDriverCents = 0` permanecem válidos — representam corridas liquidadas antes da ativação do Ownership V2.

---

**ADR-002 — Ownership & Revenue Distribution**
Versão: 1.1 | Status: Frozen | Aprovado para implementação
Pré-requisito: ADR-001 encerrada ✅ (commit a7848aa)
