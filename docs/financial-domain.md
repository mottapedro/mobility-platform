# Financial Domain — Aliado Nacional
## Documento de Contratos Arquiteturais

> **Versão:** 1.0  
> **Status:** Aprovado para implementação  
> **Princípio:** O banco de dados e o domínio são a fonte oficial da verdade. O frontend apenas renderiza DTOs.

---

## Visão Geral

O Financial Domain é um subdomínio da plataforma Aliado responsável por **toda inteligência financeira da operação**. Ele substitui o atual `domain/payment/` e expande suas responsabilidades.

### Fluxo Canônico

```
Offer
  ↓
RouteCalculator          ← calcula distância e duração (plugável)
  ↓
RouteResult              ← value object com distanceKm + estimatedDurationMin
  ↓
PricingEngine            ← aplica RidePricingConfig → produz RidePricing
  ↓
RidePricing              ← value object: source of truth financeira da corrida
  ↓
RideRequest (persiste)   ← priceEstimated, priceOffered, pricingVersion, rootDriverId
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

### 1. RidePricingConfig

**Tipo:** Configuration Object  
**Localização:** `src/domain/financial/pricing/RidePricingConfig.ts`  
**Responsabilidade:** Centralizar todos os parâmetros de precificação. Nunca hardcoded nos serviços.

```typescript
interface RidePricingConfig {
  // Tarifa base
  baseCostPerKm: number;          // ex: 2.50 (R$/km)
  baseCostPerMinute: number;      // ex: 0.35 (R$/min)
  minimumFare: number;            // ex: 12.00 (R$)

  // Taxa da plataforma
  platformFeePercent: number;     // ex: 0.15 (15%)

  // Multiplicadores de contexto
  airportMultiplier: number;      // ex: 1.25
  vipMultiplier: number;          // ex: 1.30
  nightMultiplier: number;        // ex: 1.15 (22h–06h)
  executiveMultiplier: number;    // ex: 1.40

  // Versionamento
  pricingVersion: string;         // ex: "v1"
}
```

**Evolução futura:** Migrar para tabela de banco de dados `pricing_configurations` com vigência por data. Hoje: objeto de configuração em `src/config/pricing.ts`.

---

### 2. RouteResult

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

### 3. RouteCalculator

**Tipo:** Port (Interface)  
**Localização:** `src/domain/financial/routing/RouteCalculator.ts`  
**Responsabilidade:** Definir o contrato para cálculo de rota. Plugável — trocar o provedor não altera o Pricing.

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

| Adaptador | Status | Localização |
|---|---|---|
| `HaversineRouteCalculator` | ✅ Fase 2 | `src/domain/financial/routing/adapters/` |
| `GoogleMapsRouteCalculator` | 🔜 Futuro | `src/domain/financial/routing/adapters/` |
| `MapboxRouteCalculator` | 🔜 Futuro | `src/domain/financial/routing/adapters/` |

---

### 4. RidePricing

**Tipo:** Value Object  
**Localização:** `src/domain/financial/pricing/RidePricing.ts`  
**Responsabilidade:** Resultado definitivo da precificação. Representa **tudo** que o domínio financeiro precisa saber sobre o preço de uma corrida.

```typescript
interface RidePricing {
  // Rota
  distanceKm: number;
  estimatedDurationMin: number;

  // Composição do preço
  baseFare: number;               // valor operacional da corrida
  platformFeePercent: number;     // percentual da taxa (ex: 0.15)
  platformFeeAmount: number;      // valor da taxa em R$
  driverNetAmount: number;        // o que o motorista recebe (baseFare)
  totalPassengerPrice: number;    // o que o passageiro paga (baseFare + platformFee)

  // Multiplicadores aplicados
  multipliersApplied: string[];   // ex: ["airport", "night"]

  // Auditoria
  pricingVersion: string;         // ex: "v1"
  calculatedAt: Date;
}
```

**Invariante:** `driverNetAmount + platformFeeAmount === totalPassengerPrice`

---

### 5. PricingEngine

**Tipo:** Domain Service (função pura)  
**Localização:** `src/domain/financial/pricing/PricingEngine.ts`  
**Responsabilidade:** Aplicar `RidePricingConfig` sobre `RouteResult` e `RideContext` para produzir `RidePricing`. Coração do Financial Domain.

**Entradas:**
- `RouteResult` — distância e duração calculadas
- `RidePricingConfig` — parâmetros operacionais
- `RideContext` — isVip, isAirport, isLuggage, etc.

**Saída:** `RidePricing`

**Regras:**
- Função pura — sem side effects, sem I/O
- Determinística — mesma entrada → mesma saída
- Testável isoladamente sem banco de dados
- Respeita `minimumFare`
- Registra todos os multiplicadores aplicados em `multipliersApplied`

---

### 6. PaymentProvider

**Tipo:** Port (Interface genérica)  
**Localização:** `src/domain/financial/payment/PaymentProvider.ts`  
**Responsabilidade:** Abstração genérica para qualquer gateway de pagamento. O `PixProvider` existente passa a ser uma especialização.

```typescript
interface PaymentProvider {
  createCharge(input: ChargeInput): Promise<ChargeResult>;
  refund?(chargeId: string): Promise<void>;
}
```

**Hierarquia:**

```
PaymentProvider          ← interface genérica
  ↓
PixProvider              ← especialização PIX (já existente)
  ↓
InMemoryPixProvider      ← adaptador de teste (já existente)

(futuro)
PicPayProvider
MercadoPagoProvider
PagSeguroProvider
PagarMeProvider
```

---

### 7. Settlement *(existente — sem alteração de responsabilidade)*

**Tipo:** Entity + Domain Service  
**Localização:** `src/domain/payment/SettlementService.ts` → mover para `src/domain/financial/settlement/`  
**Responsabilidade:** Liquidar um `PaymentIntent` confirmado. Produzir `Settlement` + `RevenueSplit[]`.

**Mantém:** lógica atual de split 80/15/5, idempotência por `paymentIntentId`, transação atômica.

**Recebe:** `rootDriverId` do `RideRequest` (campo já existente no schema, mas ainda não propagado na criação).

---

### 8. RevenueSplitService *(existente — sem alteração de responsabilidade)*

**Tipo:** Pure Function  
**Localização:** `src/domain/payment/RevenueSplitService.ts` → mover para `src/domain/financial/settlement/`

**Regra atual (PR-2):**

| Beneficiário | BPS | Percentual |
|---|---|---|
| Driver | 8000 | 80% |
| Platform | 1500 | 15% |
| Root Driver | 500 | 5% |

Quando `rootDriverId === null`: os 5% sobem para Platform.

---

### 9. RideQuoteDTO

**Tipo:** DTO de resposta da API  
**Localização:** `src/presentation/dtos/RideQuoteDTO.ts`  
**Responsabilidade:** Contrato público da API para o frontend. Extensível sem quebrar compatibilidade.

```typescript
interface RideQuoteDTO {
  // Identificação
  rideId: string;
  pricingVersion: string;

  // Valores para exibição
  breakdown: {
    baseFare: number;               // "Serviço de Transporte"
    platformFee: number;            // "Taxa Cyborg"
    total: number;                  // "Aliado Mobilidade"
  };

  // Rota
  distanceKm: number;
  estimatedDurationMin: number;

  // Contexto (para exibição)
  multipliersApplied: string[];

  // Expiração da cotação
  validUntil: string;               // ISO 8601

  // Espaço para evolução futura
  discount?: number;                // promoções
  couponCode?: string;              // cupons
  notes?: string;                   // observações tarifárias
}
```

---

### 10. Ledger *(Placeholder — Fase futura)*

**Responsabilidade futura:** Separar o ciclo de vida financeiro completo.

```
LedgerEntryType:
  PAYMENT_RECEIVED
  DRIVER_PAYOUT_SCHEDULED
  DRIVER_PAYOUT_SETTLED
  PLATFORM_FEE_COLLECTED
  REFUND_ISSUED
  CANCELLATION_FEE
  DISPUTE_HOLD
  RECONCILIATION_ENTRY
```

Não implementar agora. Estrutura reservada.

---

### 11. Reward *(Placeholder — Fase futura)*

**Responsabilidade futura:** Distribuição de recompensas pela rede de indicações.

```
RewardType:
  NETWORK_RIDE_COMMISSION
  REFERRAL_BONUS
  LOYALTY_CASHBACK
```

Não implementar agora. Estrutura reservada.

---

## Estrutura de Pastas — Financial Domain

```
src/domain/financial/
│
├── pricing/
│   ├── RidePricingConfig.ts       ← parâmetros de precificação
│   ├── RidePricing.ts             ← value object (resultado)
│   └── PricingEngine.ts           ← função pura de cálculo
│
├── routing/
│   ├── RouteResult.ts             ← value object (rota)
│   ├── RouteCalculator.ts         ← interface (port)
│   └── adapters/
│       ├── HaversineRouteCalculator.ts    ← Fase 2
│       └── GoogleMapsRouteCalculator.ts   ← Futuro
│
├── payment/
│   ├── PaymentProvider.ts         ← interface genérica
│   ├── PaymentIntentService.ts    ← movido de domain/payment/
│   └── providers/
│       ├── PixProvider.ts         ← existente
│       └── InMemoryPixProvider.ts ← existente
│
└── settlement/
    ├── SettlementService.ts       ← movido de domain/payment/
    └── RevenueSplitService.ts     ← movido de domain/payment/
```

---

## Regras de Ouro do Financial Domain

1. **O frontend nunca envia `amountCents`.** O valor sempre vem do banco via `RidePricing`.
2. **`rootDriverId` é imutável** após a criação da corrida.
3. **`pricingVersion`** é obrigatório em todo `RidePricing` persistido.
4. **`PricingEngine` é uma função pura.** Sem banco, sem I/O, sem side effects.
5. **`RouteCalculator` é um port.** O adaptador pode ser trocado sem alterar o Pricing.
6. **`PaymentProvider` é um port.** O gateway pode ser trocado sem alterar as regras de negócio.
7. **`Settlement` é imutável** após a criação.
8. **Todo número financeiro é em centavos inteiros** no banco. Conversão para reais ocorre apenas na camada de apresentação (DTO).

---

## Checklist de Auditoria Frontend x Backend

Antes de qualquer deploy, verificar:

- [ ] O frontend envia algum valor financeiro no request? → **Proibido**
- [ ] O frontend calcula taxa ou split? → **Proibido**
- [ ] O frontend conhece `platformFeePercent`? → **Proibido**
- [ ] O frontend conhece `SPLIT_BPS`? → **Proibido**
- [ ] O frontend conhece `rootDriverId` para fins de cálculo? → **Proibido**
- [ ] O frontend renderiza apenas valores recebidos do DTO? → **Obrigatório**
- [ ] O DTO retornado pelo backend contém `pricingVersion`? → **Obrigatório**
- [ ] O DTO retornado pelo backend contém `breakdown` estruturado? → **Obrigatório**

---

## Próximas Fases

| Fase | Entregável | Impacto no Backend | Migration |
|---|---|---|---|
| **2** | `RidePricing` + `RidePricingConfig` | Novo arquivo | Não |
| **3** | `RouteCalculator` + `HaversineAdapter` | Novo arquivo | Não |
| **4** | `PricingEngine` | Novo arquivo | Não |
| **5** | Migration Prisma | Schema | **Sim** — restart obrigatório |
| **6** | `RideController` atualizado | Controller | Restart |
| **7** | `PaymentController` atualizado | Controller | Restart |
| **8** | `RideQuoteDTO` | DTO | Não |
| **9** | Frontend atualizado | Deploy Vercel | Auto |
