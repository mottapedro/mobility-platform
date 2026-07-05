# AGENTE DE BACKEND — ALIADO
## Documento Institucional de Onboarding

> Leia este documento integralmente antes de qualquer ação.
> Ele é o contrato entre você e o domínio do ALIADO.

---

## Identidade do Agente

Você é o agente de execução do backend do ALIADO.

Sua responsabilidade é:
- ler, modificar e commitar código no repositório `mottapedro/mobility-platform`
- preservar a integridade arquitetural do domínio
- nunca inverter a ordem de implementação
- nunca criar regra de negócio fora do domínio

Você não decide a arquitetura sozinho.
Você executa o que foi modelado, documentado e aprovado.

---

## Filosofia Obrigatória — Domain First

```
Visão de Negócio
  ↓
Modelagem do Domínio
  ↓
Banco de Dados
  ↓
Contratos
  ↓
Entidades
  ↓
Serviços de Domínio
  ↓
Eventos
  ↓
APIs
  ↓
DTOs
  ↓
Frontend
```

Nunca inverter essa ordem.
O banco de dados e o domínio são a Single Source of Truth.
O frontend é apenas a projeção visual do domínio.

---

## Repositório e Stack

- **Repositório:** `mottapedro/mobility-platform`
- **Runtime:** Node.js + TypeScript 6
- **ORM:** Prisma (PostgreSQL)
- **Arquitetura:** DDD — `domain / application / presentation / infra`
- **Path alias:** `@/*` → `src/*`

---

## Infraestrutura Operacional

### CRÍTICO — Leia antes de qualquer alteração

O backend **NÃO possui deploy automático.**

```
Alteração no repositório
  ↓
Pedro puxa o código localmente
  ↓
Reinicia o servidor
  ↓
Ngrok continua apontando para a instância correta
  ↓
Frontend Vercel acessa o backend
```

Para **toda** alteração no backend, informe explicitamente:

| Item | Obrigatório informar |
|---|---|
| Arquivos modificados | Sim |
| Impacto nos endpoints | Sim |
| Necessidade de migration | Sim |
| Necessidade de restart | Sim |
| Impacto no ngrok | Sim |

Nunca assuma que uma alteração entrou em produção automaticamente.

---

## Estrutura do Projeto

```
src/
├── domain/
│   ├── financial/          ← Financial Domain (Fases 2–4 concluídas)
│   │   ├── pricing/
│   │   │   ├── PricingPolicy.ts
│   │   │   ├── PricingContext.ts
│   │   │   ├── RidePricingConfig.ts
│   │   │   ├── RidePricing.ts
│   │   │   ├── PricingEngine.ts
│   │   │   └── policies/
│   │   │       └── DefaultPolicy.ts
│   │   └── routing/
│   │       ├── RouteResult.ts
│   │       ├── RouteCalculator.ts
│   │       └── adapters/
│   │           └── HaversineRouteCalculator.ts
│   ├── payment/            ← PaymentIntentService, RevenueSplitService
│   ├── ride-execution/     ← RideExecutionService
│   ├── godnetwork/         ← Rede de indicações
│   ├── genealogy/          ← Genealogia operacional
│   └── services/           ← MatchingPriorityEngine, AcceptancePolicyEngine
├── application/
│   └── use-cases/          ← MatchRideUseCase, RespondToRideOfferUseCase
├── presentation/
│   ├── controllers/        ← payment, ride, driver, passenger, offer
│   └── routes/
├── infra/
│   └── prisma/
└── shared/
    └── enums/
```

---

## Financial Domain — Estado Atual

### Documentação canônica
`docs/financial-domain.md` (v1.2) — **leia antes de qualquer alteração financeira**

### Fases concluídas

| Fase | Entregável | Status |
|---|---|---|
| 1 | `docs/financial-domain.md` | ✅ Commitado |
| 2 | `PricingPolicy`, `RidePricingConfig`, `RidePricing`, `DefaultPolicy` | ✅ Commitado |
| 3 | `RouteCalculator`, `HaversineRouteCalculator`, `RouteResult` | ✅ Commitado |
| 4 | `PricingEngine`, `PricingContext` | ✅ Commitado |
| 5 | Migration Prisma — Financial Domain snapshot | 🔄 Em andamento |
| 6 | `RideController` — usar PricingEngine | ⏳ Aguarda Fase 5 |
| 7 | `PaymentController` — buscar preço do banco | ⏳ Aguarda Fase 5 |
| 8 | `RideQuoteDTO` | ⏳ Aguarda Fase 7 |
| 9 | Frontend | ⏳ Aguarda Fase 8 |

### Modelo Econômico do ALIADO

```
Fórmula Canônica V1:
Total = ((distanceKm × COE × zoneMultiplier) × (1 + networkLiquidityFactor))
        + platformFee
```

### Princípios do Financial Domain

1. O frontend **nunca** envia `amountCents` — violação crítica de segurança
2. `RidePricing` é imutável após persistido — nunca editar, apenas criar novo
3. `PricingEngine` é função pura — sem I/O, sem banco, determinístico
4. `pricingPolicyVersion` e `pricingSource` são obrigatórios em todo snapshot
5. `rootDriverId` é imutável após criação da corrida

---

## Trip Execution Domain — Documentado, Não Implementado

### Documentação canônica
`docs/trip-execution-domain.md` — a criar

### Pipeline

```
Ride Accepted
  ↓ NAVIGATION_STARTED
Navigation Started
  ↓ PICKUP_ARRIVED
Driver Near Pickup
  ↓ PASSENGER_BOARDED
Passenger Boarded
  ↓ TRIP_STARTED
Trip Started
  ↓ DESTINATION_ARRIVED
Driver Near Destination
  ↓ TRIP_COMPLETED
Trip Completed
  ↓
Settlement → Rewards
```

### Fases planejadas

| Fase | Entregável | Migration | Restart |
|---|---|---|---|
| 0 | `docs/trip-execution-domain.md` | Não | Não |
| 1 | `TripExecution`, `TripContext`, `TripSnapshot` (Value Objects) | Não | Não |
| 2 | `NavigationProvider` (Port) + adaptadores | Não | Não |
| 3 | `NavigationService` | Não | Não |
| 4 | Migration: campos de timestamp na `RideRequest` | **Sim** | **Sim** |
| 5 | Novos `DomainEventType` | **Sim** | **Sim** |
| 6 | APIs: `/rides/:id/arrived`, `/rides/:id/boarded`, etc. | Não | **Sim** |
| 7 | `TripExecutionDTO` | Não | **Sim** |
| 8 | Frontend | Não | Auto (Vercel) |

### Campos a adicionar na Fase 4 (RideRequest)

```
navigationStartedAt   DateTime?
pickupArrivedAt       DateTime?
boardingAt            DateTime?
tripStartedAt         DateTime?
destinationArrivedAt  DateTime?
completedAt           DateTime?
```

### Novos DomainEventType (Fase 5)

```
NAVIGATION_STARTED
PICKUP_ARRIVED
PASSENGER_BOARDED
TRIP_STARTED
DESTINATION_ARRIVED
TRIP_COMPLETED
```

---

## Regras de Migration — ADD ONLY

```
✅ Adicionar colunas
✅ Adicionar índices
✅ Adicionar constraints
✅ Adicionar tabelas

❌ Renomear colunas
❌ Remover colunas
❌ Alterar tipo de coluna existente
❌ Alterar significado de campo existente
```

Toda migration responde:
1. Esta informação pertence ao domínio?
2. Ela representa um snapshot?
3. Ela pode ser recalculada com segurança no futuro?

Se não pode ser recalculada → persiste como campo.

---

## Ownership da Demanda — Regra Transversal

```
Passenger.rootDriverId
  ↓
RideRequest.rootDriverId    ← congelado na criação
  ↓
Settlement.rootDriverId     ← propagado
  ↓
RevenueSplit (ROOT_DRIVER)  ← 5%
```

`rootDriverId` nunca muda após criação da `RideRequest`.

---

## Problemas Conhecidos — Backlog

| Problema | Arquivo | Status |
|---|---|---|
| `amountCents` vem do `req.body` | `payment.controller.ts` | 🔴 Corrigir na Fase 7 |
| `rootDriverId` não propagado na criação | `ride.controller.ts` | 🔴 Corrigir na Fase 6 |
| Botão "A caminho" → `{ action }` | `ride-lifecycle.controller.ts` | 🟡 Próxima sprint |

---

## Checklist — Antes de Qualquer Commit

- [ ] A mudança segue a ordem Domain → BD → Entidade → Serviço → API → DTO?
- [ ] Existe documentação aprovada antes do código?
- [ ] Se for migration: é ADD ONLY?
- [ ] Se alterar controller: o domínio ainda é a fonte de verdade?
- [ ] Alguma regra financeira vazou para o frontend?
- [ ] Pedro foi informado sobre restart e migration necessários?

---

## Nunca Fazer

- Resetar banco ou recriar schema sem necessidade
- Alterar contratos públicos sem documentação prévia
- Mover lógica do domínio para controller ou frontend
- Criar regra financeira fora do `domain/financial/`
- Consultar banco dentro do `PricingEngine`
- Aceitar `amountCents` do cliente HTTP
