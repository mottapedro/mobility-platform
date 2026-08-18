# Trip Execution Domain — Aliado Nacional
## Documento de Contratos Arquiteturais

> **Versão:** 1.0
> **Branch:** feat/aliado-v2-domain-hardening
> **Status:** Aprovado para implementação
> **Princípio:** O Trip Execution Domain é o elo entre o aceite da corrida
> e sua liquidação. Ele transforma uma mudança de status em uma
> experiência operacional completa para motorista e passageiro.

---

## Princípio Fundamental

> O Trip Execution Domain não altera o `RideLifecycle` público.
> Ele orquestra o que acontece **dentro** do estado `IN_PROGRESS`,
> guiando motorista e passageiro através de micro-estados operacionais
> invisíveis ao domínio externo.

O motorista nunca deve pensar: *"E agora?"*
O sistema responde essa pergunta em cada etapa.

---

## Posição na Arquitetura

```
Dispatch Domain
  ↓
ACCEPTED                    ← entrada do Trip Execution Domain
  ↓
┌─────────────────────────────────────────────┐
│  Trip Execution Domain                      │
│                                             │
│  NavigationStarted                          │
│    ↓                                        │
│  PickupArrived                              │
│    ↓                                        │
│  PassengerBoarded                           │
│    ↓                                        │
│  TripStarted                                │
│    ↓                                        │
│  DestinationArrived                         │
│    ↓                                        │
│  TripCompleted                              │
└─────────────────────────────────────────────┘
  ↓
COMPLETED                   ← saída para Financial Domain
  ↓
Settlement → Rewards
```

**Separação crítica:**
- `RideStatus` (público): `PENDING → ACCEPTED → IN_PROGRESS → COMPLETED`
- `TripStage` (interno): estados operacionais dentro do `IN_PROGRESS`

O `RideLifecycle` existente **não muda**. O `TripStage` é ortogonal a ele.

---

## Integração com o Financial Domain

```
ACCEPTED
  ↓
Payment (opcional antes da viagem)
  ↓
NavigationStarted
  ↓
[viagem acontece]
  ↓
TripCompleted
  ↓
Settlement.execute(rootDriverId, RidePricing)
  ↓
Rewards
```

O pagamento deixa de ser um evento isolado — passa a fazer parte
da jornada completa da corrida.

---

## Ownership da Demanda — Invariante

O `rootDriverId` congelado na criação da `RideRequest` atravessa
todo o Trip Execution Domain sem alteração.

```
RideRequest.rootDriverId   ← imutável desde a criação
  ↓
TripExecution.rootDriverId ← propagado no TripContext
  ↓
Settlement.rootDriverId    ← propagado para liquidação
```

---

## Componentes do Domínio

---

### 1. TripStage

**Tipo:** Enum — Estados internos do Trip Execution
**Localização:** `src/domain/trip/TripStage.ts`
**Responsabilidade:** Descrever em qual micro-estado a execução se encontra.

```typescript
export const TripStage = {
  // Motorista indo buscar o passageiro
  NAVIGATING_TO_PICKUP: "NAVIGATING_TO_PICKUP",

  // Motorista chegou ao local de embarque
  PICKUP_ARRIVED:       "PICKUP_ARRIVED",

  // Passageiro confirmou embarque
  PASSENGER_BOARDED:    "PASSENGER_BOARDED",

  // Viagem iniciada — motorista indo ao destino
  IN_TRIP:              "IN_TRIP",

  // Motorista chegou ao destino
  DESTINATION_ARRIVED:  "DESTINATION_ARRIVED",

  // Viagem encerrada — aguardando liquidação
  COMPLETED:            "COMPLETED",
} as const

export type TripStage = (typeof TripStage)[keyof typeof TripStage]
```

**Matriz de transições:**

```
NAVIGATING_TO_PICKUP → PICKUP_ARRIVED
PICKUP_ARRIVED       → PASSENGER_BOARDED | CANCELLED
PASSENGER_BOARDED    → IN_TRIP
IN_TRIP              → DESTINATION_ARRIVED
DESTINATION_ARRIVED  → COMPLETED
```

---

### 2. TripContext

**Tipo:** Value Object — Contexto operacional da viagem
**Localização:** `src/domain/trip/TripContext.ts`
**Responsabilidade:** Agregar tudo que o Trip Execution Domain precisa
saber sobre a corrida em execução. Entrada única do `TripExecutionService`.

```typescript
export interface TripContext {
  // Identidade
  rideId:        string
  rootDriverId:  string          // imutável — genealogia operacional
  driverId:      string
  passengerId:   string

  // Localização
  originLat:     number
  originLng:     number
  destinationLat: number
  destinationLng: number

  // Precificação já calculada (RidePricing snapshot)
  pricingSnapshot: {
    totalPassengerPrice: number
    driverNetAmount:     number
    platformFeeAmount:   number
    pricingPolicyVersion: string
  }

  // Estado atual
  currentStage:  TripStage
  startedAt:     Date

  // Timestamps de micro-estados (todos opcionais — ADD ONLY)
  navigationStartedAt?:  Date
  pickupArrivedAt?:      Date
  boardingAt?:           Date
  tripStartedAt?:        Date
  destinationArrivedAt?: Date
  completedAt?:          Date
}
```

---

### 3. TripSnapshot

**Tipo:** Value Object Imutável — Fotografia da viagem em um momento
**Localização:** `src/domain/trip/TripSnapshot.ts`
**Responsabilidade:** Capturar o estado completo da execução para
auditoria, replay e observabilidade.

```typescript
export interface TripSnapshot {
  rideId:       string
  rootDriverId: string
  stage:        TripStage
  capturedAt:   Date

  // Duração por estágio (em segundos)
  stageDurations: Partial<Record<TripStage, number>>

  // Distância percorrida até o momento (se disponível)
  distanceTravelledKm?: number

  // Desvios do planejado
  delayMinutes?: number

  // Referência ao pricing snapshot
  pricingPolicyVersion: string
}
```

---

### 4. NavigationProvider

**Tipo:** Port (Interface)
**Localização:** `src/domain/trip/navigation/NavigationProvider.ts`
**Responsabilidade:** Contrato para qualquer provedor de navegação.
O domínio nunca conhece Google Maps, Waze ou Mapbox.
Conhece apenas `NavigationProvider`.

```typescript
export interface NavigationInstruction {
  etaMinutes:   number
  distanceKm:   number
  deepLink?:    string          // link para app externo (Waze, Google Maps)
  provider:     NavigationProviderType
}

export type NavigationProviderType =
  | "google_maps"
  | "waze_deeplink"
  | "mapbox"
  | "haversine_estimate"

export interface NavigationProvider {
  getInstruction(
    driverLat:    number,
    driverLng:    number,
    targetLat:    number,
    targetLng:    number,
  ): Promise<NavigationInstruction>
}
```

**Adaptadores planejados:**

| Adaptador | Status |
|---|---|
| `HaversineNavigationAdapter` | ✅ Fase 2 |
| `GoogleMapsNavigationAdapter` | 🔜 Futuro |
| `WazeDeepLinkAdapter` | 🔜 Futuro |

---

### 5. NavigationService

**Tipo:** Domain Service
**Localização:** `src/domain/trip/navigation/NavigationService.ts`
**Responsabilidade:** Responder: *"Qual é o próximo passo do motorista?"*

**Entradas:** `TripContext`, posição atual do driver
**Saída:** `TripExecutionInstruction`

```typescript
export interface TripExecutionInstruction {
  stage:        TripStage
  title:        string           // "Indo buscar passageiro"
  subtitle?:    string           // "ETA 6 min · 2,1 km"
  etaMinutes?:  number
  distanceKm?:  number
  action:       TripAction
  buttonLabel:  string
  deepLink?:    string           // abrir app de navegação
}

export type TripAction =
  | "OPEN_NAVIGATION"
  | "CONFIRM_ARRIVAL"
  | "CONFIRM_BOARDING"
  | "START_TRIP"
  | "COMPLETE_TRIP"
  | "NONE"
```

**Exemplos por estágio:**

```
NAVIGATING_TO_PICKUP →
  title:  "Indo buscar o passageiro"
  subtitle: "ETA 6 min · 2,1 km"
  action: OPEN_NAVIGATION
  button: "Abrir Navegação"

PICKUP_ARRIVED →
  title:  "Você chegou ao local"
  subtitle: "Aguardando embarque"
  action: CONFIRM_BOARDING
  button: "Confirmar Embarque"

PASSENGER_BOARDED →
  title:  "Passageiro embarcou"
  subtitle: "Destino: [endereço]"
  action: OPEN_NAVIGATION
  button: "Navegar ao Destino"

DESTINATION_ARRIVED →
  title:  "Você chegou ao destino"
  action: COMPLETE_TRIP
  button: "Finalizar Corrida"
```

---

### 6. TripExecutionDTO

**Tipo:** DTO de resposta da API
**Localização:** `src/presentation/dtos/TripExecutionDTO.ts`
**Responsabilidade:** Contrato público da API para o frontend.

O frontend **nunca interpreta** `TripStage` diretamente.
Recebe `TripExecutionDTO` e renderiza.

```typescript
export interface TripExecutionDTO {
  rideId:       string
  stage:        TripStage
  title:        string
  subtitle?:    string
  etaMinutes?:  number
  distanceKm?:  number
  action:       TripAction
  buttonLabel:  string
  deepLink?:    string

  // Para exibição no mapa (futuro)
  passengerLocation?: { lat: number; lng: number }
  driverLocation?:    { lat: number; lng: number }
}
```

---

### 7. DomainEventType — Novos Eventos

Os eventos abaixo serão adicionados ao enum `DomainEventType`
existente na Fase 5. Não alterar agora.

```typescript
// Trip Execution Events
NAVIGATION_STARTED
PICKUP_ARRIVED
PASSENGER_BOARDED
TRIP_STARTED
DESTINATION_ARRIVED
TRIP_COMPLETED
```

Todos persistidos em `DomainEvent` — auditáveis e replayáveis.

---

## APIs Planejadas — Fase 6

```
POST /rides/:id/navigation/start    ← ACCEPTED → NAVIGATING_TO_PICKUP
POST /rides/:id/arrived             ← NAVIGATING_TO_PICKUP → PICKUP_ARRIVED
POST /rides/:id/boarded             ← PICKUP_ARRIVED → PASSENGER_BOARDED
POST /rides/:id/start               ← PASSENGER_BOARDED → IN_TRIP
POST /rides/:id/arrived-destination ← IN_TRIP → DESTINATION_ARRIVED
POST /rides/:id/complete            ← DESTINATION_ARRIVED → COMPLETED

GET  /rides/:id/execution           ← retorna TripExecutionDTO atual
```

---

## Estrutura de Pastas

```
src/domain/trip/
│
├── TripStage.ts                     ← Fase 1
├── TripContext.ts                   ← Fase 1
├── TripSnapshot.ts                  ← Fase 1
│
├── navigation/
│   ├── NavigationProvider.ts        ← Fase 2 (port)
│   ├── NavigationService.ts         ← Fase 3
│   └── adapters/
│       ├── HaversineNavigationAdapter.ts  ← Fase 2
│       └── GoogleMapsNavigationAdapter.ts ← Futuro
│
└── events/
    └── TripDomainEvents.ts          ← Fase 5 (placeholder)
```

---

## Evolução Futura — Preparada pela Arquitetura Atual

| Funcionalidade | Preparada? |
|---|---|
| Compartilhamento da viagem em tempo real | ✅ `TripContext` tem localização |
| Botão SOS integrado ao estado da viagem | ✅ `TripStage` identifica momento |
| Registro de incidentes com fotos | ✅ `TripSnapshot` é extensível |
| Confirmação de embarque por QR/PIN | ✅ `CONFIRM_BOARDING` action |
| Rastreamento em tempo real | ✅ `NavigationProvider` plugável |
| Contratação por hora | ✅ `TripContext` tem timestamps |
| Múltiplos trechos (RideSegments) | ✅ `TripStage` é sequencial |

---

## Checklist de Auditoria

Antes de qualquer implementação neste domínio:

- [ ] O `TripStage` é ortogonal ao `RideLifecycle`? (não altera estados públicos)
- [ ] O `TripContext` carrega `rootDriverId`? (ownership preservado)
- [ ] O frontend recebe `TripExecutionDTO`? (nunca interpreta `TripStage` diretamente)
- [ ] Novos campos em `RideRequest` são todos `ADD ONLY`?
- [ ] Eventos de domínio estão sendo gerados e persistidos?
- [ ] A `NavigationProvider` é um port? (nunca Google Maps no domínio)

---

## Tabela de Fases

| Fase | Entregável | Migration | Restart |
|---|---|---|---|
| **0** | Este documento | Não | Não |
| **1** | `TripStage`, `TripContext`, `TripSnapshot` | Não | Não |
| **2** | `NavigationProvider` (port) + `HaversineNavigationAdapter` | Não | Não |
| **3** | `NavigationService` + `TripExecutionInstruction` | Não | Não |
| **4** | Migration: timestamps em `RideRequest` | **Sim** | **Sim** |
| **5** | `DomainEventType` + novos eventos | **Sim** | **Sim** |
| **6** | APIs: `/rides/:id/arrived`, `/boarded`, etc. | Não | **Sim** |
| **7** | `TripExecutionDTO` | Não | **Sim** |
| **8** | Frontend — tela orientada por instrução | Não | Auto (Vercel) |
