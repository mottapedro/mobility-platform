# Aliado — Economic Domain: Implementation Audit

**Data:** 2026-07-20  
**Branch auditado:** `feat/aliado-v2-domain-hardening`  
**Modo:** READ-ONLY — nenhum arquivo foi alterado.

---

## Índice

1. [Pricing Engine](#1-pricing-engine)
2. [COE — Custo Operacional Efetivo](#2-coe--custo-operacional-efetivo)
3. [Multiplicador de Zona](#3-multiplicador-de-zona)
4. [Margem da Rede](#4-margem-da-rede)
5. [Taxa Operacional Cyborg](#5-taxa-operacional-cyborg)
6. [Settlement](#6-settlement)
7. [PIX e PaymentIntent](#7-pix-e-paymentintent)
8. [DTOs Relacionados ao Preço](#8-dtos-relacionados-ao-preço)
9. [Banco de Dados — Schema](#9-banco-de-dados--schema)
10. [Fluxo Real Atual](#10-fluxo-real-atual)
11. [Tabela de Divergências](#11-tabela-de-divergências)
12. [Impacto da Refatoração](#12-impacto-da-refatoração)

---

## 1. Pricing Engine

### Arquivos e responsabilidades

| Arquivo | Responsabilidade | Chamado por | Retorna |
|---------|-----------------|-------------|---------|
| `src/domain/pricing/PricingConfiguration.ts` | Constantes de pricing (tarifas, margens, fee) | `PricingEngine.ts` | `PricingConfiguration` |
| `src/domain/pricing/RouteCalculator.ts` | Calcula distância (Haversine) e duração (30 km/h fixo) | `ride.controller.ts` | `{ distanceKm, estimatedDurationMin }` |
| `src/domain/pricing/PricingEngine.ts` | Aplica fórmula COE → baseFare → liquidity → platformFee → total | `PricingService.ts` | `RidePricing` |
| `src/domain/pricing/services/PricingService.ts` | Orquestra: resolve região, conta motoristas, chama PricingEngine | `ride.controller.ts` | `PricingServiceResult` |
| `src/domain/pricing/RidePricing.ts` | Interface de saída do PricingEngine | - | type/interface |

### Constantes de pricing (`PricingConfiguration.ts`)

```ts
baseCostPerKm:          1.20   // R$/km  — base do COE
platformFeeDefault:     2.50   // R$     — Taxa Cyborg fixa
liquidityMarginNormal:  0.20   // 20%    — zona com > 2 motoristas
liquidityMarginHigh:    0.55   // 55%    — zona com ≤ 2 motoristas (escassez)
highScarcityThreshold:  2      // limiar de escassez
minimumFare:            5.00   // R$     — tarifa mínima
zoneCoefficients:       { local: 1.0, intercity: 2.0 }
pricingVersion:         "v1"
```

### Fórmula de precificação (`PricingEngine.ts` linhas 63–81)

```
1. baseCOE           = distanceKm × R$1,20/km
2. zoneCoeff         = peso_esforco da OperationalZone (DB) ← multiplier
3. baseFare          = round(baseCOE × zoneCoeff)
4. liquidityAmount   = round(baseFare × liquidityMargin)
5. driverNetAmount   = round(baseFare + liquidityAmount)
6. platformFee       = R$2,50 fixo  (ENV: PLATFORM_FEE, fallback 2.50)
7. rawTotal          = driverNetAmount + platformFee
8. totalPassengerPrice = max(rawTotal, R$5,00)
```

### Cálculo de rota (`RouteCalculator.ts`)

> ⚠️ **NÃO existe integração com Google Maps ou qualquer API externa de rotas.**  
> Distância = fórmula Haversine (linha reta entre coordenadas).  
> Duração = `round((distanceKm / 30) × 60)` minutos (velocidade fixa de 30 km/h).

---

## 2. COE — Custo Operacional Efetivo

### Existe?

**Parcialmente.** O conceito existe como variável local intermediária no `PricingEngine`, mas **não é armazenado como campo independente** no banco.

### Como é calculado

```ts
// PricingEngine.ts linha 66
const baseCOE = distanceKm * PRICING_CONFIG.baseCostPerKm;
// = distanceKm × R$1,20
```

### Onde aparece

| Local | Uso |
|-------|-----|
| `PricingEngine.ts` linha 66 | Variável local `baseCOE` |
| `RidePricing.ts` (jsdoc) | `baseFare` documentado como "COE × zoneCoeff" |
| `payment.controller.ts` | Breakdown label: `"Custo de Deslocamento"` |

### O que NÃO existe

- Coluna `coe` ou `operationalCost` em nenhuma tabela do schema.
- COE como campo salvo na `RideRequest` — apenas `baseFare` (já com zoneCoeff aplicado) é persistido.
- Parâmetros externos de COE (combustível, desgaste, região) — é estritamente `km × 1.20`.

---

## 3. Multiplicador de Zona

### Onde nasce

**Tabela `OperationalZone`** → coluna `peso_esforco Float? @default(1.0)`

### Como é resolvido (`PricingEngine.ts` linhas 23–45)

```ts
function resolveZoneCoefficient(originRegion, destRegion, zones) {
  // Se origem e destino estão na mesma zona → 1.0 (local)
  // Se zona tem peso_esforco definido → usa o valor do DB
  // Fallback → 2.0 (intercity)
}
```

### Influência no preço

**Sim, influencia diretamente o preço.**  
`baseFare = round(baseCOE × zoneCoeff)`  
Zona com `peso_esforco = 2.0` dobra o baseFare antes da margem de liquidez.

### O que NÃO existe

- Campo `zoneMultiplier` ou `zoneCoeff` armazenado na `RideRequest`. O efeito está embutido em `baseFare`.
- Interface de administração para editar `peso_esforco` via API/frontend.
- `RegionMultiplier`, `DispatchRegion`, `RideRegion` como entidades nomeadas — a lógica vive inline em `PricingEngine.resolveZoneCoefficient()`.

---

## 4. Margem da Rede

### Existe?

**Não existe** como conceito implementado.  
O termo `networkMargin` não aparece em nenhum arquivo do codebase.

### O que existe no lugar

**Margem de Liquidez** (`liquidityMargin`) — premium de oferta/demanda por zona:

| Condição | Margem |
|----------|--------|
| `availableDrivers > 2` | 20% sobre `baseFare` |
| `availableDrivers ≤ 2` | 55% sobre `baseFare` (escassez) |

Esta margem **não é** uma margem da rede de indicação. É um ajuste de liquidez de oferta/demanda local.

---

## 5. Taxa Operacional Cyborg

### Resumo de todas as ocorrências

| Arquivo | Linha | Valor | Contexto |
|---------|-------|-------|----------|
| `src/domain/pricing/PricingConfiguration.ts` | 13 | `2.50` (R$ fixo) | Constante de configuração |
| `src/domain/pricing/PricingEngine.ts` | 54–57 | `process.env.PLATFORM_FEE \|\| 2.50` | Resolve via ENV com fallback |
| `src/domain/pricing/PricingEngine.ts` | 79 | `platformFee = round(resolvePlatformFee())` | Aplicado na fórmula |
| `src/application/use-cases/ProcessRideSettlementUseCase.ts` | 41 | `platformCents = 250` (R$2,50 hardcoded) | Settlement path A (cash/manual) |
| `src/presentation/controllers/payment.controller.ts` | 126 | `process.env.PLATFORM_FEE_VALIDATION \|\| 2.50` | Validação breakdown PIX |
| `src/domain/payment/RevenueSplitService.ts` | 14 | `PLATFORM: 1500` (15% bps) | Settlement path B (PIX webhook) |

### Divergência crítica

Existem **dois modelos de taxa incompatíveis** em produção:

| Path | Taxa | Motorista | Plataforma | Root Driver |
|------|------|-----------|------------|-------------|
| `ProcessRideSettlementUseCase` (cash/manual) | R$2,50 fixo | `gross - 250 cents` | `250 cents` | `0` |
| `SettlementService` (PIX webhook) | 15% percentual | 80% | 15% | ~5% |

**Exemplo prático (corrida de R$21,22 = 2.122 cents):**

| Modelo | Plataforma | Motorista | Root Driver |
|--------|-----------|-----------|-------------|
| R$2,50 fixo | R$2,50 | R$18,72 | R$0,00 |
| 15% percentual | R$3,18 | R$16,98 | ~R$1,06 |

---

## 6. Settlement

### Estrutura do Settlement (schema)

```
Settlement
├── totalCents      Int    — bruto total
├── driverCents     Int    — parte do motorista
├── platformCents   Int    — parte da Cyborg (taxa)
├── rootDriverCents Int    — parte do motorista raiz (rede)
└── rootDriverId    String?— owner econômico congelado no momento do settlement
```

O settlement **separa os valores** — não é lump sum. Mas os dois paths usam modelos diferentes.

### Path A — `ProcessRideSettlementUseCase.ts`

Acionado por: `POST /rides/:id/lifecycle/complete`

```
platformCents   = 250         (R$2,50 fixo)
driverCents     = gross - 250
rootDriverCents = 0           ← motorista raiz não recebe nada neste path
```

Cria: `RevenueSplit` com 2 linhas (PLATFORM + DRIVER). Sem ROOT_DRIVER.

### Path B — `SettlementService.ts` (via PIX webhook)

Acionado por: `POST /pix/webhook` → status CONFIRMED

```
driverCents     = floor(totalCents × 0.80)  → 80%
platformCents   = floor(totalCents × 0.15)  → 15%
rootDriverCents = totalCents - driver - platform → ~5%
```

Cria: `RevenueSplit` com 3 linhas (DRIVER + PLATFORM + ROOT_DRIVER).

---

## 7. PIX e PaymentIntent

### Fluxo

```
POST /rides/:id/payment/intent
  → lê ride.priceOffered ?? ride.priceEstimated (bruto total do passageiro)
  → amountCents = round(priceBrl × 100)
  → cria PaymentIntent com amountCents (valor TOTAL, incluindo taxa Cyborg)
  → gera QR Code EMVCo estático localmente (sem HTTP externo)
  → retorna { totalPrice, qrCode, breakdown }
```

### Valor no QR Code

**O QR Code codifica o valor total bruto do passageiro** (`driverNetAmount + platformFee`).  
Não há campo separado de taxa no payload PIX.

A separação financeira ocorre apenas contabilmente, após a confirmação do pagamento, dentro do `Settlement`.

### Schema `PaymentIntent`

| Campo | Tipo | Conteúdo |
|-------|------|---------|
| `amountCents` | `Int` | Valor total em centavos (passageiro paga) |
| `status` | `PaymentStatus` | PENDING / CONFIRMED / FAILED / CANCELLED |
| `externalId` | `String?` | txid PIX |
| `qrCode` | `String?` | BRCode EMVCo completo |
| `confirmedAt` | `DateTime?` | Timestamp da confirmação |

Não existe campo `platformFeeCents`, `operationalAmountCents` ou similar no `PaymentIntent`.

---

## 8. DTOs Relacionados ao Preço

### `RidePricing` (`src/domain/pricing/RidePricing.ts`)

```ts
interface RidePricing {
  distanceKm:            number   // Haversine km
  estimatedDurationMin:  number   // round((km/30)*60)
  baseFare:              number   // COE × zoneCoeff (R$)
  liquidityAmount:       number   // baseFare × liquidityMargin (R$)
  platformFee:           number   // R$2,50 fixo
  driverNetAmount:       number   // baseFare + liquidityAmount
  totalPassengerPrice:   number   // max(driverNetAmount + platformFee, 5.00)
  pricingVersion:        string   // "v1"
  breakdown:             PriceBreakdownItem[]
}
```

### `PricingServiceResult` (`src/domain/pricing/services/PricingService.ts`)

Extende `RidePricing` com:
```ts
originRegion:         string   // nome da zona de origem
destinationRegion:    string   // nome da zona de destino
availableDriversInZone: number // quantidade de motoristas na zona (determina liquidityMargin)
```

### `PaymentIntentResponseDTO` (inline em `payment.controller.ts`)

```ts
{
  success:    boolean
  rideId:     string
  intentId:   string
  externalId: string
  totalPrice: number   // R$ — valor total passageiro
  amount:     number   // cents
  qrCode:     string   // BRCode EMVCo
  breakdown:  Array<{ label: string; value: number }>
}
```

### `RevenueSplitResult` (`src/domain/payment/RevenueSplitService.ts`)

```ts
{
  totalCents:       number
  driverCents:      number
  platformCents:    number
  rootDriverCents:  number
  rootDriverId:     string | null
}
```

### O que NÃO existe como DTO nomeado

- `EstimateRideResponse` — response do estimate é inline em `ride.controller.ts`
- `RideQuote` — não existe como interface
- `SettlementDTO` — não existe como arquivo separado
- `QuoteService` — não existe

---

## 9. Banco de Dados — Schema

### Tabela `RideRequest`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `distanceKm` | `Float?` | Distância Haversine (km) |
| `durationMin` | `Int?` | Duração estimada (min) |
| `priceEstimated` | `Float?` | `totalPassengerPrice` calculado pelo PricingEngine |
| `priceOffered` | `Float?` | Preço ofertado/aceito (pode diferir do estimate) |
| `baseFare` | `Float?` | COE × zoneCoeff (já com multiplicador) |
| `platformFee` | `Float?` | R$2,50 Cyborg (salvo pelo PricingEngine) |
| `driverNetAmount` | `Float?` | baseFare + liquidityAmount |
| `pricingVersion` | `String?` | `"v1"` |

**Ausentes:** `coe`, `liquidityAmount`, `zoneMultiplier`, `networkMargin`, `operationalPrice`

### Tabela `PaymentIntent`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `amountCents` | `Int` | Valor total bruto em centavos |
| `status` | `PaymentStatus` | Estado do pagamento |
| `externalId` | `String?` | txid PIX |
| `qrCode` | `String?` | BRCode EMVCo |
| `confirmedAt` | `DateTime?` | Timestamp confirmação |

**Ausentes:** `platformFeeCents`, `operationalAmountCents`, `driverAmountCents`

### Tabela `Settlement`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `totalCents` | `Int` | Bruto total |
| `driverCents` | `Int` | Parte do motorista |
| `platformCents` | `Int` | Parte da Cyborg |
| `rootDriverCents` | `Int` | Parte do motorista raiz (rede) |
| `rootDriverId` | `String?` | Owner econômico (frozen at write) |
| `settledAt` | `DateTime` | Timestamp do settlement |

### Tabela `RevenueSplit`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `beneficiaryType` | `SplitBeneficiaryType` | DRIVER / PLATFORM / ROOT_DRIVER |
| `beneficiaryDriverId` | `String?` | FK Driver (null para PLATFORM) |
| `amountCents` | `Int` | Valor desta linha |
| `percentBps` | `Int` | Basis points (10000 = 100%) |

### Tabela `OperationalZone`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `peso_esforco` | `Float? @default(1.0)` | Multiplicador de zona usado pelo PricingEngine |

---

## 10. Fluxo Real Atual

```
POST /rides  (ride.controller.ts:create)
│
├─► HaversineRouteCalculator.calculate()
│     Haversine(originLat/Lng, destLat/Lng) → distanceKm
│     round((distanceKm / 30) × 60)         → estimatedDurationMin
│     ⚠️  Sem Google Maps. Linha reta.
│
├─► PricingService.estimate()
│   ├─► RegionResolver.resolve(origin, dest)
│   │     → identifica OperationalZone de origem e destino
│   ├─► prisma.operationalZone.findFirst()
│   │     → conta motoristas disponíveis na zona (determina liquidityMargin)
│   └─► PricingEngine.calculate()
│         baseCOE           = km × 1.20
│         zoneCoeff         = OperationalZone.peso_esforco (DB)
│         baseFare          = baseCOE × zoneCoeff
│         liquidityMargin   = 0.20 ou 0.55 (conforme drivers na zona)
│         liquidityAmount   = baseFare × liquidityMargin
│         driverNetAmount   = baseFare + liquidityAmount
│         platformFee       = 2.50 (ENV ou fallback)
│         total             = max(driverNetAmount + 2.50, 5.00)
│
└─► prisma.rideRequest.create()
      priceEstimated  = total
      baseFare        = baseFare (já com zoneCoeff)
      platformFee     = 2.50
      driverNetAmount = driverNetAmount
      distanceKm, durationMin, pricingVersion

─────────────── Passageiro decide pagar ───────────────

POST /rides/:id/payment/intent  (payment.controller.ts:createIntent)
├─► lê ride.priceOffered ?? ride.priceEstimated
├─► amountCents = round(price × 100)
├─► prisma.paymentIntent.create({ amountCents, status: PENDING })
├─► buildStaticPix(amountCents, intentId)  [EMVCo local, sem HTTP]
└─► retorna { qrCode, totalPrice, breakdown }
      breakdown: [
        { label: "Serviço de Transporte", value: driverNetAmount },
        { label: "Taxa Cyborg",           value: 2.50 }
      ]

─────────────── Pagamento confirmado ───────────────

OPÇÃO A — PIX webhook  (POST /pix/webhook)
├─► handlePixWebhook() → PaymentIntentService.ts
├─► prisma.paymentIntent.update(status: CONFIRMED)
└─► settleConfirmedPayment() → SettlementService.ts
      computeRevenueSplit(totalCents, rootDriverId)
        driverCents     = floor(totalCents × 0.80)  ← 80%
        platformCents   = floor(totalCents × 0.15)  ← 15%
        rootDriverCents = totalCents - driver - platform ← ~5%
      prisma.settlement.create()
      prisma.revenueSplit.createMany()  [3 rows]

OPÇÃO B — Manual / cash  (POST /rides/:id/lifecycle/complete)
└─► ProcessRideSettlementUseCase.execute()
      platformCents   = 250           ← R$2,50 fixo
      driverCents     = gross - 250
      rootDriverCents = 0             ← raiz não recebe nada
      prisma.settlement.create()
      prisma.revenueSplit.createMany()  [2 rows — sem ROOT_DRIVER]
```

---

## 11. Tabela de Divergências

| Conceito | Esperado | Implementado | Status |
|----------|----------|-------------|--------|
| **COE** | Campo salvo no DB, calculado com parâmetros variáveis (combustível, região) | Variável local `baseCOE = km × 1.20`; não salvo no DB | ⚠️ Parcial |
| **Multiplicador de Zona** | Influenciar preço final | Influencia `baseFare` via `peso_esforco` do DB | ✅ Implementado |
| **Margem da Rede** | Percentual sobre receita da rede de indicações | Não existe. `liquidityMargin` é margem de liquidez (oferta/demanda), não rede | ❌ Inexistente |
| **Taxa Cyborg fixa (R$2,50)** | Único modelo de taxa em todos os paths | Existe em 2 paths com modelos incompatíveis: R$2,50 fixo (cash) vs. 15% (PIX webhook) | ⚠️ Inconsistente |
| **Settlement separado** | `operationalValue + platformFee` explicitamente separados | Separado em colunas (`driverCents`, `platformCents`) mas paths A e B calculam de forma diferente | ⚠️ Parcial |
| **Root Driver Split** | Root driver recebe share em todos os settlements | Só no path B (PIX webhook). Path A (cash/manual) define `rootDriverCents = 0` | ⚠️ Incompleto |
| **Google Maps / Rota real** | Distância e duração reais por trânsito | Haversine (linha reta) + 30 km/h fixo | ❌ Não implementado |
| **Cashback passageiro** | Percentual sobre corridas da rede P2P | `estimatedRevenue = 0` — sem taxa definida | ⚠️ Zerado (intencional) |
| **Campo `coe` no DB** | Coluna `coe` em `RideRequest` | Ausente. `baseFare` embute COE × zoneCoeff | ❌ Inexistente |
| **`liquidityAmount` no DB** | Campo recuperável para auditoria | Ausente — recuperável por `driverNetAmount - baseFare` | ❌ Inexistente |
| **ENV `PLATFORM_FEE`** | Configurável externamente | Lido em `PricingEngine.ts` e `payment.controller.ts` mas não em `ProcessRideSettlementUseCase.ts` (hardcoded `250`) | ⚠️ Inconsistente |
| **DTOs nomeados** | `EstimateRideResponse`, `RideQuote`, `SettlementDTO` | Inline nos controllers. Apenas `RidePricing` e `RevenueSplitResult` são interfaces nomeadas | ⚠️ Faltando |

---

## 12. Impacto da Refatoração

### Objetivo adotado

> **Preço Operacional** (`baseFare + liquidityAmount`) + **Taxa Operacional Cyborg** (R$2,50 fixo) = `totalPassengerPrice`  
> Settlement único: R$2,50 plataforma, `(gross - 2.50)` motorista, `0` root driver (split de rede a definir separadamente).

---

### Arquivos que precisarão ser alterados

#### Services / Domain

| Arquivo | O que mudar |
|---------|------------|
| `src/domain/payment/RevenueSplitService.ts` | Substituir split percentual (80/15/5 bps) por lógica baseada em R$2,50 fixo |
| `src/domain/payment/SettlementService.ts` | Usar `platformCents = 250` em vez de `computeRevenueSplit()` com percentuais |
| `src/application/use-cases/ProcessRideSettlementUseCase.ts` | Já corrigido (R$2,50). Adicionar `rootDriverCents` quando regra de split de rede for definida |
| `src/domain/pricing/PricingConfiguration.ts` | Manter `platformFeeDefault: 2.50`. Remover `liquidityMarginNormal`/`High` se modelo de scarcity for descontinuado |
| `src/domain/pricing/PricingEngine.ts` | Separar explicitamente `operationalPrice` de `platformFee` no resultado; renomear `baseFare` para `operationalBaseFare` se COE passar a ser campo salvo |

#### DTOs

| Arquivo | O que mudar |
|---------|------------|
| `src/domain/pricing/RidePricing.ts` | Adicionar campo `operationalPrice` (= `driverNetAmount`) e tornar `platformFee` mandatório |
| `src/presentation/controllers/ride.controller.ts` | Atualizar inline estimate response para incluir `operationalPrice` |
| `src/presentation/controllers/payment.controller.ts` | Garantir que `PaymentIntentResponseDTO` retorne `operationalPrice` e `platformFee` como campos tipados, não só no breakdown |

#### Prisma / Banco

| Tabela | Campo | Ação |
|--------|-------|------|
| `PaymentIntent` | `operationalAmountCents Int?` | Adicionar — valor que vai para o motorista |
| `PaymentIntent` | `platformFeeCents Int?` | Adicionar — taxa Cyborg em centavos |
| `RideRequest` | `liquidityAmount Float?` | Adicionar — para auditoria da margem de liquidez |
| `RideRequest` | `baseCoe Float?` | Opcional — `km × 1.20` antes do zoneCoeff |

> Requer nova migration. Campos opcionais (`?`) — sem breaking change.

#### Controllers / APIs

| Arquivo | O que mudar |
|---------|------------|
| `src/presentation/controllers/payment.controller.ts` | Separar `amountCents` em `operationalAmountCents + platformFeeCents` ao criar `PaymentIntent` |
| `src/presentation/controllers/ride.controller.ts` | Salvar `liquidityAmount` e/ou `baseCoe` no `RideRequest` se campos forem adicionados ao schema |

#### Frontend

| Impacto | Local |
|---------|-------|
| Ganhos page — `estimatedRevenue` já usa `driverCents` do Settlement | Sem mudança se Settlement estiver correto |
| Breakdown exibido ao passageiro (QR code) | Atualizar labels se campos tipados forem adicionados |
| Rede page — `estimatedRevenue` motorista usa `settledRevenueShareCents` | Sem mudança |

#### Testes / Seeds

| Arquivo | O que mudar |
|---------|------------|
| `e2e/smoke/smoke-pix-payment.spec.ts` | Verificar assertions de `platformCents` para garantir R$2,50 no path PIX |
| Seeds de `OperationalZone` | Confirmar que `peso_esforco` está populado corretamente para testes |
| Qualquer test que asserta `platformCents = floor(totalCents × 0.15)` | Atualizar para R$2,50 fixo |

---

### Ordem recomendada de implementação

```
1. Unificar modelo de taxa:
   └─► RevenueSplitService.ts: substituir 15% por R$2,50 fixo
   └─► SettlementService.ts: usar platformCents = 250

2. Adicionar campos ao PaymentIntent (migration):
   └─► operationalAmountCents, platformFeeCents

3. Atualizar payment.controller.ts:
   └─► popular os novos campos ao criar PaymentIntent

4. Adicionar campos à RideRequest (migration opcional):
   └─► liquidityAmount — para auditoria histórica

5. Nomear DTOs faltantes:
   └─► EstimateRideResponse, SettlementDTO em arquivos dedicados

6. Definir e implementar split de rede para root driver:
   └─► Regra: % sobre qual base? Após taxa Cyborg ou sobre o bruto?
   └─► Adicionar ao ProcessRideSettlementUseCase e SettlementService

7. Definir taxa de cashback passageiro P2P:
   └─► Atualizar buildNetworkContextForPassenger com o cálculo real

8. Avaliar integração Google Maps:
   └─► Substituir HaversineRouteCalculator por Directions API
   └─► Impacto: RouteCalculator.ts, ride.controller.ts
```

---

### Riscos da migração

| Risco | Nível | Mitigação |
|-------|-------|-----------|
| Settlements históricos com modelo percentual (15%) ficam inconsistentes com novos (R$2,50) | Alto | Não retroprocessar; documentar a data de corte |
| `RevenueSplitService` mudando de percentual para fixo quebra `SettlementService` (único consumer) | Alto | Cobrir com teste de integração antes de alterar |
| `peso_esforco = null` em `OperationalZone` causa `NaN` no preço | Médio | `@default(1.0)` no schema protege; mas zones criadas sem o campo ficam com `null` |
| Haversine subestima distância urbana (~30–40% a menos que rota real) | Alto | Preço atual é estruturalmente mais baixo que o custo real do motorista |
| ENV `PLATFORM_FEE` ignorada em `ProcessRideSettlementUseCase` (hardcoded `250`) | Baixo | Centralizar em constante importada de `PricingConfiguration.ts` |

---

*Fim da auditoria. Nenhum arquivo foi modificado.*
