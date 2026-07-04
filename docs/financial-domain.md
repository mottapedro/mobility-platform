# Financial Domain — Aliado Nacional
## Documento de Contratos Arquiteturais

> **Versão:** 1.2  
> **Status:** Aprovado para implementação  

---

## Princípio Fundamental

> O Financial Domain é a fonte oficial da verdade para todas as informações financeiras do Aliado.
> Nenhuma regra de precificação, cálculo de valores, divisão de receitas ou repasses deve existir fora deste domínio.
> O frontend apenas apresenta os dados produzidos por ele.
> Gateways de pagamento apenas executam transações.

---

## Modelo Econômico do ALIADO

O ALIADO não usa precificação orientada a oferta e demanda.

**A maioria das plataformas:**
```
Oferta e demanda → Preço → Motorista recebe o restante
```

**O ALIADO:**
```
Custo operacional do motorista
  ↓
Preço mínimo sustentável
  ↓
Ajuste de zona operacional
  ↓
Fator de liquidez da rede
  ↓
Taxa da plataforma
  ↓
Preço final ao passageiro
```

> O motorista é o ativo estratégico da plataforma. O pricing nasce do seu custo, não do mercado.

---

## Fórmula Canônica V1

```
Total = ((distanceKm × COE × zoneMultiplier) × (1 + networkLiquidityFactor)) + platformFee
```

| Componente | Descrição |
|---|---|
| `COE` | Custo Operacional por Km — patrimônio intelectual da Cyborg |
| `zoneMultiplier` | Política operacional por zona (não surge/dinâmica) |
| `networkLiquidityFactor` | Disponibilidade da rede — maior escassez = maior fator |
| `platformFee` | Taxa fixa da plataforma — transparente ao passageiro |

---

## Pipeline do PricingEngine

Cada responsabilidade isolada em sua própria etapa:

```
RouteCalculator
  ↓ distanceKm, estimatedDurationMin
OperationalCostCalculator
  ↓ driverOperationalCost (COE × distance)
ZonePolicy
  ↓ zoneAdjustment (operationalCost × zoneMultiplier)
NetworkPolicy
  ↓ networkAdjustment (zoneAdjustment × (1 + networkLiquidityFactor))
PlatformPolicy
  ↓ platformFee (fixo)
PricingEngine (orquestrador)
  ↓
RidePricing (snapshot imutável)
```

O `PricingEngine` orquestra — nunca contém `if` de política.
Novas políticas = novas implementações. Engine nunca muda.

---

## COE — Custo Operacional por Km

O COE é o verdadeiro patrimônio intelectual da Cyborg.

Responde: *Quanto custa operar um veículo executivo por quilômetro?*

**Hoje:** valor configurado em `RidePricingConfig`.

**Futuro — DriverOperationalProfile:**
```
combustível + pneus + óleo + seguro + IPVA
+ manutenção + depreciação + lavagem
+ tempo parado + retorno vazio
  ↓
OperationalCostEngine
  ↓
COE personalizado por motorista
```

A arquitetura atual deve permitir essa evolução sem refatoração estrutural.

---

## Princípio do Snapshot Financeiro

> Todo `RidePricing` é um snapshot financeiro imutável da corrida no momento em que foi calculado.
> Ele não referencia configurações externas — persiste todos os valores efetivamente utilizados.

**Exemplo:**

| Momento | Platform Fee config | O que o RidePricing mostra |
|---|---|---|
| Corrida realizada hoje | 15% | **15% para sempre** |
| Config daqui a 1 ano | 18% | irrelevante para esta corrida |

---

## Versionamento da Política

| Campo | Responde | Exemplo |
|---|---|---|
| `pricingSource` | qual política foi utilizada | `EXECUTIVE_POLICY` |
| `pricingPolicyVersion` | qual versão estava vigente | `"v2"` |

---

## Invariante Financeira V1

```
totalPassengerPrice = driverNetAmount + platformFeeAmount
```

Válida para Pricing Policy V1.

**Futuro (com descontos):**
```
totalPassengerPrice = driverNetAmount + platformFeeAmount - discounts
```

---

## Ownership da Demanda

Toda entidade financeira deve responder: **quem é o driver raiz desta demanda?**

```
Passenger.rootDriverId
  ↓
RideRequest.rootDriverId    ← congelado na criação
  ↓
Settlement.rootDriverId     ← propagado
  ↓
RevenueSplit (ROOT_DRIVER)  ← 5%
```

`rootDriverId` é imutável após a criação da corrida.

---

## Componentes do Domínio

---

### 1. PricingPolicy

**Tipo:** Interface (Strategy Pattern)
**Localização:** `src/domain/financial/pricing/PricingPolicy.ts`
**Responsabilidade:** Estratégia de negócio — decide qual `RidePricingConfig` aplicar.

```typescript
interface PricingPolicy {
  name: string;
  version: string;
  source: PricingSource;
  getConfig(context: RideContext): RidePricingConfig;
  appliesTo(context: RideContext): boolean;
}
```

**Hierarquia:**
```
PricingPolicy (interface)
  ├── DefaultPolicy          ← Fase 2
  ├── AirportPolicy          ← Futuro
  ├── ExecutivePolicy        ← Futuro
  ├── HourlyPolicy           ← Futuro
  ├── CorporatePolicy        ← Futuro
  └── PromotionalPolicy      ← Futuro
```

---

### 2. RidePricingConfig

**Tipo:** Configuration Object
**Localização:** `src/domain/financial/pricing/RidePricingConfig.ts`

```typescript
interface RidePricingConfig {
  // Custo operacional
  coePerKm: number;               // Custo Operacional/km (COE)
  coePerMinute: number;           // Custo Operacional/min
  minimumFare: number;            // Tarifa mínima

  // Taxa da plataforma
  platformFeeFixed: number;       // Taxa fixa (R$)
  platformFeePercent?: number;    // Taxa percentual (opcional futuro)

  // Multiplicadores de zona
  zoneMultipliers: {
    urban: number;                // ex: 1.0
    mountain: number;             // ex: 1.4
    countryside: number;          // ex: 1.7
    intermunicipal: number;       // ex: 2.0
    airport: number;              // ex: 1.2
    emptyReturn: number;          // ex: 1.5
  };

  // Fator de liquidez da rede
  networkLiquidityFactor: number; // ex: 0.10 (10%)

  // Versionamento
  pricingVersion: string;         // ex: "v1"
}
```

---

### 3. RouteResult

**Tipo:** Value Object
**Localização:** `src/domain/financial/routing/RouteResult.ts`

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

| Adaptador | Status |
|---|---|
| `HaversineRouteCalculator` | ✅ Fase 3 |
| `GoogleMapsRouteCalculator` | 🔜 Futuro |

---

### 5. RidePricing

**Tipo:** Value Object — **Imutável**
**Localização:** `src/domain/financial/pricing/RidePricing.ts`

```typescript
interface RidePricing {
  // Rota
  distanceKm: number;
  estimatedDurationMin: number;

  // Custo operacional (COE)
  coeApplied: number;             // valor do COE efetivo
  baseOperationalCost: number;    // distanceKm × COE

  // Ajustes aplicados
  zoneMultiplierApplied: number;
  zoneAdjustment: number;         // após multiplicador de zona
  networkLiquidityFactor: number;
  networkAdjustment: number;      // após fator de rede

  // Resultado financeiro
  driverNetAmount: number;        // o que o motorista recebe
  platformFeeAmount: number;      // taxa da plataforma
  totalPassengerPrice: number;    // total pago pelo passageiro

  // Multiplicadores e políticas aplicadas
  multipliersApplied: string[];
  pricingSource: PricingSource;
  pricingPolicyVersion: string;

  // Auditoria
  calculatedAt: Date;
}
```

**Invariante V1:** `driverNetAmount + platformFeeAmount === totalPassengerPrice`

---

### 6. PricingEngine

**Tipo:** Domain Service — Função Pura
**Localização:** `src/domain/financial/pricing/PricingEngine.ts`
**Responsabilidade:** Orquestra o pipeline e produz `RidePricing`.

**Pipeline interno:**
```
1. OperationalCostCalculator  → baseOperationalCost = distanceKm × COE
2. ZonePolicy                 → zoneAdjustment = baseOperationalCost × zoneMultiplier
3. NetworkPolicy              → networkAdjustment = zoneAdjustment × (1 + networkLiquidityFactor)
4. PlatformPolicy             → platformFee = fixo
5. Composição final           → RidePricing
```

**Regras:**
- Função pura — sem I/O, sem side effects
- Determinística
- Testável isoladamente
- Respeita `minimumFare`

---

### 7. PaymentProvider

**Tipo:** Port (Interface genérica)
**Localização:** `src/domain/financial/payment/PaymentProvider.ts`

```
PaymentProvider
  ├── PixProvider (existente)
  │     └── InMemoryPixProvider (existente)
  ├── PicPayProvider (futuro)
  └── MercadoPagoProvider (futuro)
```

---

### 8. Settlement *(existente)*

Mantém lógica atual. Passa a receber `rootDriverId` do `RideRequest`.

---

### 9. RevenueSplitService *(existente)*

| Beneficiário | BPS | % |
|---|---|---|
| Driver | 8000 | 80% |
| Platform | 1500 | 15% |
| Root Driver | 500 | 5% |

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
    baseFare: number;             // "Serviço de Transporte"
    platformFee: number;          // "Taxa Cyborg"
    total: number;                // "Aliado Mobilidade"
  };

  distanceKm: number;
  estimatedDurationMin: number;
  multipliersApplied: string[];
  validUntil: string;

  // Evolução futura
  discount?: number;
  couponCode?: string;
  notes?: string;
}
```

---

### 11. Ledger *(Placeholder)*

```
PAYMENT_RECEIVED | DRIVER_PAYOUT_SCHEDULED | DRIVER_PAYOUT_SETTLED
PLATFORM_FEE_COLLECTED | REFUND_ISSUED | RECONCILIATION_ENTRY
```

---

### 12. Reward *(Placeholder)*

```
NETWORK_RIDE_COMMISSION | REFERRAL_BONUS | LOYALTY_CASHBACK
```

---

## Estrutura de Pastas

```
src/domain/financial/
│
├── pricing/
│   ├── PricingPolicy.ts
│   ├── policies/
│   │   ├── DefaultPolicy.ts       ← Fase 2
│   │   ├── AirportPolicy.ts       ← Futuro
│   │   └── ExecutivePolicy.ts     ← Futuro
│   ├── RidePricingConfig.ts
│   ├── RidePricing.ts
│   └── PricingEngine.ts
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
- [ ] O frontend calcula COE, zona ou liquidez? → **Proibido**
- [ ] O frontend conhece `platformFeePercent`? → **Proibido**
- [ ] O frontend renderiza apenas valores do DTO? → **Obrigatório**
- [ ] O DTO contém `pricingSource` e `pricingPolicyVersion`? → **Obrigatório**
- [ ] O DTO contém `breakdown` estruturado? → **Obrigatório**
- [ ] O `RidePricing` persiste os valores efetivos (não referências)? → **Obrigatório**
- [ ] O `COE` aplicado está salvo no snapshot? → **Obrigatório**

---

## Tabela de Fases

| Fase | Entregável | Migration | Restart Backend |
|---|---|---|---|
| **1** | Este documento | Não | Não |
| **2** | `PricingPolicy`, `RidePricingConfig`, `RidePricing` | Não | Não |
| **3** | `RouteCalculator`, `HaversineAdapter` | Não | Não |
| **4** | `PricingEngine` + `OperationalCostCalculator` + policies | Não | Não |
| **5** | Migration Prisma | **Sim** | **Sim** |
| **6** | `RideController` atualizado | Não | **Sim** |
| **7** | `PaymentController` atualizado | Não | **Sim** |
| **8** | `RideQuoteDTO` | Não | **Sim** |
| **9** | Frontend atualizado | Não | Auto (Vercel) |
