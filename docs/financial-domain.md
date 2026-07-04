# Financial Domain — Aliado Nacional
## Documento de Contratos Arquiteturais

> **Versão:** 1.1  
> **Status:** Aprovado para implementação  

---

## Princípio Fundamental

> O Financial Domain é a fonte oficial da verdade para todas as informações financeiras do Aliado.
> Nenhuma regra de precificação, cálculo de valores, divisão de receitas ou repasses deve existir fora deste domínio.
> O frontend apenas apresenta os dados produzidos por ele.
> Gateways de pagamento apenas executam transações.

Este princípio é a referência definitiva sempre que houver dúvida sobre onde implementar uma regra financeira.

---

## Princípio do Snapshot Financeiro

> Todo `RidePricing` representa um snapshot financeiro da corrida no momento em que foi calculado.
> Ele não depende de configurações atuais — persiste todos os valores efetivamente utilizados no cálculo.

**Exemplo:**

| Momento | Platform Fee | O que o RidePricing mostra |
|---|---|---|
| Corrida realizada hoje | 15% | **15%** para sempre |
| Configuração global daqui a 1 ano | 18% | irrelevante para esta corrida |

O `RidePricing` nunca armazena referências para buscar valores depois. Armazena os valores.

---

## Versionamento da Política de Precificação

Todo `RidePricing` carrega dois campos de rastreabilidade:

| Campo | O que responde | Exemplo |
|---|---|---|
| `pricingSource` | qual política foi utilizada | `EXECUTIVE_POLICY` |
| `pricingPolicyVersion` | qual versão da política estava vigente | `"v2"` |

Isso permite responder: *"Com qual política e qual versão desta política esta corrida foi calculada?"*

Essencial para auditoria financeira de corridas históricas quando políticas evoluem.

---

## Invariante Financeira V1

```
totalPassengerPrice = driverNetAmount + platformFeeAmount
```

**Esta invariante é válida para a Pricing Policy V1.**

Futuramente, políticas com desconto, cashback ou subsídio utilizarão:

```
totalPassengerPrice = driverNetAmount + platformFeeAmount - discounts
```

A invariante não é universal — é da política vigente. O `pricingPolicyVersion` identifica qual se aplica.

---

## Visão Geral

O Financial Domain substitui e expande o atual `domain/payment/`. É responsável por **toda inteligência financeira da operação**.

### Fluxo Canônico

```
RideRequest
  ↓
PricingPolicy            ← seleciona qual estratégia se aplica
  ↓
RidePricingConfig        ← parâmetros daquela política
  ↓
RouteCalculator          ← calcula distância e duração (plugável)
  ↓
RouteResult              ← value object: distanceKm + estimatedDurationMin
  ↓
PricingEngine            ← função pura: aplica política + rota → RidePricing
  ↓
RidePricing              ← snapshot financeiro imutável da corrida
  ↓
RideRequest (persiste)   ← priceEstimated, pricingVersion, rootDriverId
  ↓
PaymentIntent            ← amountCents vem de RidePricing, nunca do cliente
  ↓
SettlementService        ← Settlement + RevenueSplit
  ↓
DomainEvents             ← RIDE_SETTLED, REWARD_DISTRIBUTED
```

### Regra fundamental

> O frontend **nunca** envia `amountCents`.  
> O frontend **nunca** conhece percentuais, taxas ou regras de split.  
> O frontend recebe um `RideQuoteDTO` e renderiza.

---

## Ownership da Demanda

Toda entidade financeira deve conseguir responder: **quem é o driver raiz responsável pela origem desta demanda?**

```
Passenger.rootDriverId
  ↓
RideRequest.rootDriverId    ← congelado no momento da criação
  ↓
Settlement.rootDriverId     ← propagado do RideRequest
  ↓
RevenueSplit (ROOT_DRIVER)  ← 5% para o driver raiz
```

**Regra:** `rootDriverId` é imutável após a criação da corrida. Mesmo que a rede evolua depois, o histórico financeiro preserva a genealogia operacional do momento da oferta.

---

## Componentes do Domínio

---

### 1. PricingPolicy

**Tipo:** Interface (Strategy Pattern)  
**Localização:** `src/domain/financial/pricing/PricingPolicy.ts`  
**Responsabilidade:** Representar a **estratégia de negócio** de precificação. Decide qual `RidePricingConfig` aplicar e quais multiplicadores são relevantes para um dado contexto.

```typescript
interface PricingPolicy {
  name: string;
  version: string;                            // pricingPolicyVersion
  source: PricingSource;                      // pricingSource
  getConfig(context: RideContext): RidePricingConfig;
  appliesTo(context: RideContext): boolean;
}
```

**Hierarquia de políticas:**

```
PricingPolicy (interface)
  ├── DefaultPolicy          ← Fase 2 (v1)
  ├── AirportPolicy          ← Fase futura
  ├── ExecutivePolicy        ← Fase futura
  ├── HourlyPolicy           ← Fase futura
  ├── CorporatePolicy        ← Fase futura
  └── PromotionalPolicy      ← Fase futura
```

O `PricingEngine` nunca muda. Novas políticas são novas implementações da interface.

---

### 2. RidePricingConfig

**Tipo:** Configuration Object  
**Localização:** `src/domain/financial/pricing/RidePricingConfig.ts`  
**Responsabilidade:** Centralizar os **parâmetros** de uma política. Nunca hardcoded nos serviços.

```typescript
interface RidePricingConfig {
  baseCostPerKm: number;          // ex: 2.50 (R$/km)
  baseCostPerMinute: number;      // ex: 0.35 (R$/min)
  minimumFare: number;            // ex: 12.00 (R$)
  platformFeePercent: number;     // ex: 0.15 (15%)
  airportMultiplier: number;      // ex: 1.25
  vipMultiplier: number;          // ex: 1.30
  nightMultiplier: number;        // ex: 1.15
  executiveMultiplier: number;    // ex: 1.40
  pricingVersion: string;         // ex: "v1"
}
```

**Evolução futura:** Migrar para tabela `pricing_configurations` com vigência por data.

---

### 3. RouteResult

**Tipo:** Value Object  
**Localização:** `src/domain/financial/routing/RouteResult.ts`  
**Responsabilidade:** Transportar o resultado do cálculo de rota. Imutável.

```typescript
interface RouteResult {
  distanceKm: number;
  estimatedDurationMin: number;
  calculatedBy: "haversine" | "google_maps" | "mapbox" | "here";
}
```

---

### 4. RouteCalculator

**Tipo:** Port (Interface)  
**Localização:** `src/domain/financial/routing/RouteCalculator.ts`  
**Responsabilidade:** Contrato para cálculo de rota. Plugável — trocar o provedor não altera o Pricing.

```typescript
interface RouteCalculator {
  calculate(
    originLat: number,
    originLng: number,
    destinationLat: number,
    destinationLng: number
  ): Promise<RouteResult>;
}
```

**Adaptadores:**

| Adaptador | Status |
|---|---|
| `HaversineRouteCalculator` | ✅ Fase 3 |
| `GoogleMapsRouteCalculator` | 🔜 Futuro |
| `MapboxRouteCalculator` | 🔜 Futuro |

---

### 5. RidePricing

**Tipo:** Value Object — **Imutável**  
**Localização:** `src/domain/financial/pricing/RidePricing.ts`  
**Responsabilidade:** Snapshot financeiro definitivo da corrida. Persiste todos os valores efetivamente utilizados — nunca referências.

```typescript
interface RidePricing {
  // Rota
  distanceKm: number;
  estimatedDurationMin: number;

  // Composição do preço
  baseFare: number;
  platformFeePercent: number;       // valor efetivo no momento do cálculo
  platformFeeAmount: number;
  driverNetAmount: number;
  totalPassengerPrice: number;

  // Multiplicadores efetivamente aplicados
  multipliersApplied: string[];     // ex: ["airport", "night"]

  // Rastreabilidade
  pricingSource: PricingSource;     // ex: "EXECUTIVE_POLICY"
  pricingPolicyVersion: string;     // ex: "v2"
  calculatedAt: Date;
}

// Invariante V1:
// driverNetAmount + platformFeeAmount === totalPassengerPrice
```

**Imutabilidade:** após persistido, nunca alterado. Mudança de preço gera novo `RidePricing`.

---

### 6. PricingEngine

**Tipo:** Domain Service — Função Pura  
**Localização:** `src/domain/financial/pricing/PricingEngine.ts`  
**Responsabilidade:** Coração do Financial Domain. Aplica `PricingPolicy` + `RouteResult` + `RideContext` e produz `RidePricing`.

**Entradas:**
- `RouteResult`
- `PricingPolicy`
- `RideContext`

**Saída:** `RidePricing`

**Regras:**
- Função pura — sem side effects, sem I/O
- Determinística — mesma entrada → mesma saída
- Testável isoladamente
- Respeita `minimumFare`
- Registra todos os multiplicadores em `multipliersApplied`
- Persiste `platformFeePercent` efetivo no `RidePricing`

---

### 7. PaymentProvider

**Tipo:** Port (Interface genérica)  
**Localização:** `src/domain/financial/payment/PaymentProvider.ts`

```
PaymentProvider (interface)
  ↓
PixProvider              ← especialização PIX (existente)
  ↓
InMemoryPixProvider      ← adaptador de teste (existente)

(futuro)
PicPayProvider
MercadoPagoProvider
PagSeguroProvider
PagarMeProvider
```

---

### 8. Settlement *(existente)*

Mantém lógica atual. Passa a receber `rootDriverId` do `RideRequest`.

---

### 9. RevenueSplitService *(existente)*

**Regra V1:**

| Beneficiário | BPS | Percentual |
|---|---|---|
| Driver | 8000 | 80% |
| Platform | 1500 | 15% |
| Root Driver | 500 | 5% |

Quando `rootDriverId === null`: 5% sobem para Platform.

---

### 10. RideQuoteDTO

**Tipo:** DTO de resposta da API  
**Localização:** `src/presentation/dtos/RideQuoteDTO.ts`

```typescript
interface RideQuoteDTO {
  rideId: string;
  pricingSource: string;
  pricingPolicyVersion: string;

  breakdown: {
    baseFare: number;               // "Serviço de Transporte"
    platformFee: number;            // "Taxa Cyborg"
    total: number;                  // "Aliado Mobilidade"
  };

  distanceKm: number;
  estimatedDurationMin: number;
  multipliersApplied: string[];
  validUntil: string;

  // Espaço para evolução futura
  discount?: number;
  couponCode?: string;
  notes?: string;
}
```

---

### 11. Ledger *(Placeholder)*

```
LedgerEntryType:
  PAYMENT_RECEIVED
  DRIVER_PAYOUT_SCHEDULED
  DRIVER_PAYOUT_SETTLED
  PLATFORM_FEE_COLLECTED
  REFUND_ISSUED
  CANCELLATION_FEE
  RECONCILIATION_ENTRY
```

---

### 12. Reward *(Placeholder)*

```
RewardType:
  NETWORK_RIDE_COMMISSION
  REFERRAL_BONUS
  LOYALTY_CASHBACK
```

---

## Estrutura de Pastas

```
src/domain/financial/
│
├── pricing/
│   ├── PricingPolicy.ts           ← interface (strategy pattern)
│   ├── policies/
│   │   ├── DefaultPolicy.ts       ← Fase 2
│   │   ├── AirportPolicy.ts       ← Futuro
│   │   └── ExecutivePolicy.ts     ← Futuro
│   ├── RidePricingConfig.ts       ← parâmetros
│   ├── RidePricing.ts             ← value object imutável
│   └── PricingEngine.ts           ← função pura
│
├── routing/
│   ├── RouteResult.ts
│   ├── RouteCalculator.ts
│   └── adapters/
│       ├── HaversineRouteCalculator.ts
│       └── GoogleMapsRouteCalculator.ts  ← Futuro
│
├── payment/
│   ├── PaymentProvider.ts
│   ├── PaymentIntentService.ts
│   └── providers/
│       ├── PixProvider.ts
│       └── InMemoryPixProvider.ts
│
└── settlement/
    ├── SettlementService.ts
    └── RevenueSplitService.ts
```

---

## Checklist de Auditoria Frontend x Backend

- [ ] O frontend envia algum valor financeiro? → **Proibido**
- [ ] O frontend calcula taxa ou split? → **Proibido**
- [ ] O frontend conhece `platformFeePercent`? → **Proibido**
- [ ] O frontend conhece `pricingPolicyVersion`? → **Proibido**
- [ ] O frontend renderiza apenas valores do DTO? → **Obrigatório**
- [ ] O DTO contém `pricingSource` e `pricingPolicyVersion`? → **Obrigatório**
- [ ] O DTO contém `breakdown` estruturado? → **Obrigatório**
- [ ] O `RidePricing` persiste os valores efetivos (não referências)? → **Obrigatório**

---

## Tabela de Fases

| Fase | Entregável | Migration | Restart Backend |
|---|---|---|---|
| **1** | Este documento | Não | Não |
| **2** | `PricingPolicy`, `RidePricingConfig`, `RidePricing` | Não | Não |
| **3** | `RouteCalculator`, `HaversineAdapter` | Não | Não |
| **4** | `PricingEngine` | Não | Não |
| **5** | Migration Prisma | **Sim** | **Sim** |
| **6** | `RideController` atualizado | Não | **Sim** |
| **7** | `PaymentController` atualizado | Não | **Sim** |
| **8** | `RideQuoteDTO` | Não | **Sim** |
| **9** | Frontend atualizado | Não | Auto (Vercel) |
