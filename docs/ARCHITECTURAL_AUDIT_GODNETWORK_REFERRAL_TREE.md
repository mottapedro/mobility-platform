# ARCHITECTURAL AUDIT — GODNETWORK + REFERRAL TREE

> Audit date: 2026-06-22
> Scope: backend read-only architectural audit for frontend network dashboards.
> No code was modified.

---

# 1. Current Referral Tree Structure

## 1.1 Persistence model

The project uses **two overlapping but distinct** graph models for the referral network.

### A. Write model / closure table: `DriverReferral`

`prisma/schema.prisma` model `DriverReferral`:

```prisma
model DriverReferral {
  id String @id @default(uuid())
  referrerDriverId String
  referredDriverId String
  level Int
  isDirect Boolean @default(true)
  createdAt DateTime @default(now())
  referrer Driver @relation("Referrer", fields: [referrerDriverId], references: [id])
  referred Driver @relation("Referred", fields: [referredDriverId], references: [id])
  @@unique([referrerDriverId, referredDriverId])
  @@index([referredDriverId])
  @@index([referrerDriverId, level])
  @@index([referrerDriverId, isDirect])
}
```

This is the **historical closure table** produced by `createDriverReferralChain` in `src/domain/services/DriverReferralService.ts`.
Key behaviours:

- A direct edge is recorded as `level=1, isDirect=true` (e.g. Pedro → João).
- Inherited edges are recorded with `level>1, isDirect=false` (e.g. Pedro → Carlinhos via João).
- Cycle guard: before writing, it checks whether an edge `(newDriverId → referrerDriverId)` already exists in `DriverReferral` in any direction, and throws `ReferralChainError` if so.
- Business depth cap: `REFERRAL_TREE_MAX_DEPTH = 5`.
- Self-referral guard at service entry (`newDriverId === referrerDriverId`).

Example materialized structure for the GodNetwork:

```
Pedro Paulo Motta
├── João Luiz Correa de Brito (level=1, isDirect=true)
│   ├── Carlinhos               (level=1 João, level=2 Pedro inherited)
│   ├── Jenner
│   ├── Bira
│   ├── Gisele
│   ├── Fábio
│   └── André Cabral
├── Anselmo Valle               (level=1, isDirect=true)
├── Fernando Barreira           (level=1, isDirect=true)
└── Carlos Henrique             (level=1, isDirect=true)
```

### B. Read / projection model: `ReferralRelationship`

`prisma/schema.prisma` model `ReferralRelationship`:

```prisma
model ReferralRelationship {
  id String @id @default(uuid())
  flowType ReferralFlowType
  inviterActorType ActorType
  inviterId String
  invitedActorType ActorType
  invitedId String
  rootDriverId String
  inviterDriverId String?
  createdAt DateTime @default(now())
  @@unique([invitedActorType, invitedId])
  @@index([rootDriverId])
  @@index([inviterActorType, inviterId])
  @@index([flowType])
}
```

This is the **V2 polymorphic graph projection** used by the new network services.
- It records exactly one inviter per invited actor (`@@unique([invitedActorType, invitedId])`).
- `rootDriverId` is the operational/economic owner of the entire sub-tree.
- `flowType` can be `DRIVER_TO_DRIVER`, `DRIVER_TO_PASSENGER`, `PASSENGER_TO_PASSENGER`.
- `inviterDriverId` is a convenience denormalization when the inviter is a driver.

## 1.2 Root ownership persistence

Root ownership is stored in **multiple places**:

1. `Driver.referredByDriverId` — the direct parent in the write model.
2. `DriverReferral` closure edges — ancestor chain for a driver.
3. `ReferralRelationship.rootDriverId` — the operational/economic root for any actor.
4. `Passenger.rootDriverId` — denormalized root for passengers.
5. `RideRequest.rootDriverId` — denormalized root for revenue attribution.

The canonical resolver is `resolveDriverRoot` in `src/domain/referral-network/DriverRootResolverService.ts`.

Rules for drivers:
- If `referredByDriverId` is null → the driver is its own root.
- Else, walk the closure table `DriverReferral` ordering by `level desc` to find the deepest ancestor; that ancestor is the operational root.
- If closure table is incomplete, fall back to recursive parent chain (defensive).

Rules for passengers:
- Return `passenger.rootDriverId` if set.
- Else follow `referredByDriverId` → resolve that driver's root.
- Else follow `referredByPassengerId` → resolve that passenger's root.
- Else return null.

## 1.3 Lineage reconstruction

There are two lineage reconstruction paths:

### Driver lineage (up to 5 levels)

`src/domain/services/DriverReferralService.ts`:
- `getDriverNetworkSnapshot(driverId)` reads `DriverReferral` where `referrerDriverId = driverId` and groups by `level` (1..5).
- Returns `DriverNetworkSnapshot` with `levels.level1`..`levels.level5`, summary counts, and passenger counts per driver.
- `getDriverNetwork(driverId)` is a compat layer returning only `level1/level2/level3` IDs.

### Generic actor ancestry (up to 15 hops)

`src/domain/network/NetworkContextProjectionService.ts`:
- `walkAncestors(actorType, actorId, db)` walks `ReferralRelationship` upward using `invitedActorType_invitedId` and returns `NetworkActor[]` from immediate inviter to root.
- Max 15 hops hard cap.

## 1.4 Recursive traversal

There is **no recursive CTE or recursive DB traversal** in the code. The services implement:

- **BFS over a pre-fetched adjacency list** in `buildGenealogyProjection` (`src/domain/genealogy/BuildGenealogyProjectionService.ts`). It loads all `ReferralRelationship` rows for a `rootDriverId` in a single query, builds an adjacency map, and then does a BFS in memory with visited/duplicate/self-edge guards.
- **Depth-limited recursive tree builder** in `buildDescendantsTree` (`src/domain/genealogy/treeBuilder.ts`), which converts the flat BFS result into a recursive `FrontendGenealogyNode[]` tree.

## 1.5 Services that generate the tree structure

| Service | File | Purpose |
|---|---|---|
| `createDriverReferralChain` | `src/domain/services/DriverReferralService.ts` | Writes closure edges when a driver is referred. |
| `getDriverNetworkSnapshot` | `src/domain/services/DriverReferralService.ts` | Reads driver network grouped by level (legacy shape). |
| `recordRelationship` | `src/domain/referral-network/ReferralRelationshipService.ts` | Writes V2 polymorphic `ReferralRelationship` rows. |
| `resolveDriverRoot` | `src/domain/referral-network/DriverRootResolverService.ts` | Resolves operational root for any actor. |
| `buildGenealogyProjection` | `src/domain/genealogy/BuildGenealogyProjectionService.ts` | BFS projection of entire root network into flat graph. |
| `buildDescendantsTree` | `src/domain/genealogy/treeBuilder.ts` | Converts flat graph into recursive tree. |
| `buildNetworkContextForDriver/Passenger` | `src/domain/network/NetworkContextProjectionService.ts` | Assembles full context (ancestry, descendants, lateral, metrics). |
| `getNetworkRelationships` | `src/domain/referral-network/NetworkGenealogyService.ts` | Lists flat `ReferralRelationship` rows for a root. |
| `SyncProjectionJob` | `src/domain/network/SyncProjectionJob.ts` | Reconciles `DriverReferral` → `ReferralRelationship` gaps. |
| `assertConformance` | `src/domain/godnetwork/GodNetworkService.ts` | Validates live DB against the locked GodNetwork contract. |

---

# 2. Frontend Readiness Audit

## 2.1 Dashboard Tree (recursive `{ id, name, children[] }`)

**Status: READY**

The endpoint `GET /drivers/:id/network/genealogy` (`src/presentation/routes/genealogy.routes.ts` + `GenealogyController.getDriverGenealogy`) returns a flat graph, but the backend also has the recursive converter ready.

For a driver-specific view, `GET /network/context?actorId=<id>&actorType=DRIVER` returns:

```json
{
  "genealogy": {
    "me": { "id", "name", "actorType": "driver", ... },
    "ancestors": [...],
    "descendants": [
      {
        "actor": { "id", "name", "actorType": "driver" },
        "depth": 1,
        "absoluteDepth": 2,
        "children": [ ... ],
        "nodeMetrics": { "directPassengerCount", "directDriverCount", "completedRides" }
      }
    ],
    "lateral": [...],
    "operationalOwner": null
  }
}
```

The `descendants` field exactly matches the requested recursive tree shape (see `FrontendGenealogyNode` in `src/domain/network/NetworkContextTypes.ts`).

If the frontend wants a global view starting from the root, it can call `GET /drivers/:id/network/genealogy` and recursively render from the `nodes`/`edges` array, or call `GET /drivers/:id/network/tree` (NetworkV2Controller) which returns the flat BFS projection with `rootDriver`, `nodes`, `edges`, `levels`, `metrics`, and `stats`.

## 2.2 Sponsor Chain (uplines)

**Status: READY**

`GET /network/context?actorId=<id>&actorType=DRIVER|PASSENGER` returns `genealogy.ancestors` as an ordered array from immediate inviter to root:

```json
[
  { "id": "joao-id", "name": "João", "actorType": "driver" },
  { "id": "pedro-id", "name": "Pedro Paulo Motta", "actorType": "driver" }
]
```

Implementation: `walkAncestors` in `NetworkContextProjectionService.ts` (max 15 hops).

## 2.3 Descendants List (downlines with level)

**Status: READY**

Two options:

1. **Recursive tree with levels**: `GET /network/context?actorId=<id>&actorType=DRIVER` returns `genealogy.descendants[]` with `depth` (relative to viewer) and `absoluteDepth` (from root).
2. **Flat list with levels**: `GET /drivers/:id/network/genealogy` returns `nodes[]` where each node has `level` (BFS depth from root) and `parentId`.

Both include `actorType`, so the frontend can distinguish drivers from passengers.

## 2.4 Network Summary

**Status: READY (with caveat)**

`GET /network/context` returns `networkMetrics`:

```json
{
  "totalActors": 10,
  "activeCount": 10,
  "depth": 2,
  "ridesFromNetwork": 0,
  "estimatedRevenue": 0,
  "growth": { "last7Days": 0, "last30Days": 0 }
}
```

Caveats:
- `activeCount` is currently set to `ownership.totalDriversInTree`, not the count of active drivers. It conflates drivers with total actors. **Minor data-semantic issue.**
- `estimatedRevenue` is in cents/100, derived from `RevenueSplit` where the driver is beneficiary. This is a settled-revenue view, not an estimated one.

## 2.5 Economic ownership / context projection

**Status: READY for root-driver metrics; PARTIALLY READY for per-node metrics.**

- `getOwnershipMetrics` (`src/domain/referral-network/NetworkOwnershipService.ts`) returns `OwnershipMetrics` for a driver/root.
- `NetworkContextProjectionService` attaches `NodeMetrics` to every driver node in the descendants tree (`directPassengerCount`, `directDriverCount`, `completedRides`).
- Passenger context returns `operationalOwner` (the driver who directly referred them).

---

# 3. Existing APIs

| Method | Route | Controller | Service(s) | DTO / Response Shape |
|---|---|---|---|---|
| GET | `/network/context?actorId=&actorType=` | `NetworkV2Controller.getNetworkContext` | `buildNetworkContextForDriver/Passenger`, `resolveDriverRoot` | `NetworkContext` (flowType, rootDriver, genealogy, metrics, inviteUrls, capabilities) |
| GET | `/drivers/:id/network` | `DriverController.getNetwork` | `getDriverNetworkSnapshot` | `DriverNetworkSnapshot` (legacy levels + summary) |
| GET | `/drivers/:id/network/hierarchy` | `DriverController.getNetworkHierarchy` | `getDriverNetworkSnapshot` | `{ me, levels, summary, totalPassengers }` |
| GET | `/drivers/:id/network/relationships` | `DriverController.getNetworkRelationships` | `getNetworkRelationships`, `getOwnershipMetrics`, `listDriverSkills` | `{ driverId, relationships, ownership, skills, capabilities }` |
| GET | `/drivers/:id/network/genealogy?maxDepth=N` | `GenealogyController.getDriverGenealogy` | `buildGenealogyProjection` | `GenealogyProjection` (rootDriver, nodes, edges, levels, metrics, stats) |
| GET | `/drivers/:id/network/tree?maxDepth=N` | `NetworkV2Controller.getGenealogyTree` | `buildGenealogyProjection`, `resolveDriverRoot` | `GenealogyProjection` (rootDriver, nodes, edges, levels, metrics, stats) |
| GET | `/drivers/:id/network/summary` | `NetworkV2Controller.getDriverNetwork` | `getNetworkRelationships`, `getOwnershipMetrics`, `listDriverSkills` | Same as `/drivers/:id/network/relationships` |
| GET | `/drivers/:id/ownership` | `NetworkV2Controller.getDriverOwnership` | `getOwnershipMetrics` | `OwnershipMetrics` |
| GET | `/passengers/:id/lineage` | `NetworkV2Controller.getPassengerLineage` | `getPassengerLineage` | Passenger lineage DTO |
| GET | `/drivers/r/:slug` | `DriverController.resolvePublicReferral` | direct Prisma query | `{ slug, referralCode, driver }` |
| GET | `/drivers/:referralCode` (legacy) | `DriverController.getPublicProfile` | direct Prisma query | `{ name, referralCode, experienceLevel, memberSince, regions, vehicles }` |
| GET | `/godnetwork/status` | `GodNetworkController.getStatus` | `assertConformance`, `getOfficialStructure` | `GodNetworkConformance` + `officialStructure` |
| POST | `/auth/register` (driver) | `auth.controller.ts` | `createDriverReferralChain`, `recordRelationship` | Onboarding response |
| POST | `/auth/register` (passenger) | `auth.controller.ts` | `createPassengerReferral`, `assignPassengerIdentity`, `recordRelationship` | Onboarding response |
| GET | `/onboarding/context/:slug` | `NetworkV2Controller.getOnboardingContext` | `resolveOnboardingContext` | Onboarding context DTO |

Notes:
- `driversNetworkRouter` and `genealogyRouter` are both mounted on `/drivers`, so `/drivers/:id/network/genealogy` and `/drivers/:id/network/tree` coexist. The route order matters and is already defined in `src/server.ts`.
- There is no `/network/tree` route independent of a driver; a caller must provide a driver ID, and the backend resolves the root first.

---

# 4. Missing Pieces for Frontend Rendering

| Feature | Status | Notes |
|---|---|---|
| **Tree View** | READY | Use `GET /network/context` → `genealogy.descendants`, or `GET /drivers/:id/network/genealogy`. |
| **Sponsor Chain (uplines)** | READY | Use `GET /network/context` → `genealogy.ancestors`. |
| **Network Graph** | READY | `GET /drivers/:id/network/genealogy` returns `nodes`/`edges` ready for graph libraries (D3, Cytoscape, React Flow). |
| **Organizational Chart** | PARTIALLY READY | Backend has the recursive tree and depth fields. The frontend must style/render. No org-chart-specific DTO with `managerId`/`reports` naming exists, but the structure is convertible in ≤5 lines. |
| **Referral Dashboard** | PARTIALLY READY | `/network/context` provides most widgets. Missing: a dedicated dashboard summary endpoint that returns only the widgets the dashboard needs (e.g. `kpi`, `recentInvites`, `topPerformers`). This can be assembled client-side from existing endpoints. |
| **Per-node revenue** | PARTIALLY READY | `NodeMetrics` has `completedRides`. It does not expose revenue per descendant. Revenue is aggregated at root level via `OwnershipMetrics`. |
| **Avatar URLs** | MISSING | `NetworkActor` has `avatarUrl?: string | null` in the type, but the backend does not populate it (no avatar field in schema). |
| **Phone / contact visibility** | MISSING | Driver/passenger phone is not included in network DTOs for privacy reasons. A policy decision is needed before exposing. |
| **Pagination / large-tree pagination** | MISSING | Projections cap at `maxDepth=10` and `ABSOLUTE_MAX_DEPTH=10`, but there is no pagination. Very large networks could return huge payloads. |
| **Search / filter descendants** | MISSING | No endpoint to search/filter descendants by name, region, level, or status. |
| **Real-time network updates** | MISSING | No WebSocket or SSE for network changes. The frontend must poll. |
| **Network health / conformance endpoint for frontend** | READY | `GET /godnetwork/status` is available, but it is more of an admin/audit endpoint. |

---

# 5. GodNetwork Compliance

## 5.1 Single root ownership

**Status: COMPLIANT, with a caveat.**

- The `ReferralRelationship` table has a single `rootDriverId` per invited actor, enforced by `@@unique([invitedActorType, invitedId])` (one inviter per actor) and the resolver logic.
- The `DriverRootResolverService` resolves one root per actor.
- Caveat: there are two root concepts in flight:
  - **Operational root** (`resolveDriverRoot`) used for network context and genealogy.
  - **Economic root** (`RideRequest.rootDriverId`, `Passenger.rootDriverId`) used for revenue attribution.
  These are intended to be the same, but the denormalization creates a risk of drift if a backfill fails. `SyncProjectionJob` reconciles `DriverReferral` → `ReferralRelationship`, but not the denormalized columns on `Passenger`/`RideRequest`.

## 5.2 Immutable lineage

**Status: COMPLIANT for `ReferralRelationship`; WEAK for `DriverReferral`.**

- `ReferralRelationship` is append-only in normal flow (`recordRelationship` returns existing rows without mutation). There is no update/delete service for it.
- `DriverReferral` rows are also append-only via `createMany({ skipDuplicates: true })`.
- However, there is no DB-level guarantee preventing manual updates. AGENTS.md §2 says economic entities are immutable, but `DriverReferral`/`ReferralRelationship` are not explicitly listed.

## 5.3 Economic ownership separation

**Status: COMPLIANT in design; PARTIALLY READY in enforcement.**

- `Settlement`, `RevenueSplit`, and `RewardDistribution` are marked immutable in AGENTS.md §2.
- `RideRequest.rootDriverId` and `Passenger.rootDriverId` are denormalized economic ownership fields.
- The conformance test (`assertConformance`) validates the GodNetwork structure but does not validate economic ownership mapping.

## 5.4 Referral invariants

**Status: COMPLIANT.**

- One inviter per invited actor: `@@unique([invitedActorType, invitedId])` on `ReferralRelationship`.
- No self-referral: checked in `recordRelationship` and `createDriverReferralChain`.
- Cycle guard: `createDriverReferralChain` checks for reverse edges; `buildGenealogyProjection` uses visited/self-edge/duplicate-edge guards.
- Max depth 5 for write model, 10 for read projections.

## 5.5 Network governance rules

**Status: COMPLIANT.**

- `GodNetworkService.ts` is the "locked contract" with the official structure.
- `assertConformance` validates:
  - Root driver exists (`mottapedro01@gmail.com`).
  - 4 direct L1 children under root.
  - 6 direct children under João.
  - ≥10 closure edges from root.
  - Gisele has skill `COLECIONADOR`.
- CI gate: `.github/workflows/godnetwork-governance.yml` and `npm run audit:godnetwork`.
- `tests/contracts/` validates schema drift.

## 5.6 Reported violations / risks

1. **Dual graph models (legacy `DriverReferral` + V2 `ReferralRelationship`)** create two sources of truth. `SyncProjectionJob` reconciles D2D direct referrals only; it does not reconcile passenger relationships or inherited edges. This is a **governance risk**.
2. **Denormalized root columns** (`Passenger.rootDriverId`, `RideRequest.rootDriverId`) can drift from `ReferralRelationship.rootDriverId`. No automated reconciliation job covers them.
3. **Legacy `DriverReferral` closure vs. V2 graph** — the `DriverReferral` closure table stores inherited edges, while `ReferralRelationship` stores only direct inviter relationships. The genealogy projection reads from `ReferralRelationship`, which currently only has direct edges (D2D) unless `SyncProjectionJob` or onboarding backfilled them. This means inherited edges (e.g. Pedro → Carlinhos) may not be present in `ReferralRelationship`, depending on whether the backfill/population job materialized them. **Potential tree gap for deep descendants.**
4. **4 tests failing** (per `docs/test-failures-summary.md`): settlement-service, onboarding-context-service, network-ownership-service, matching. These are not directly related to the network read model, but they indicate instability in the onboarding/ownership/economic flows that feed the network.

---

# 6. Recommendations

## 6.1 Minimum API contract for frontend consumption

The existing `NetworkContext` DTO is already a strong contract. For a dedicated dashboard, the frontend can consume:

```ts
// From GET /network/context?actorId=<id>&actorType=DRIVER
interface NetworkContext {
  flowType: "DRIVER_TO_DRIVER" | "DRIVER_TO_PASSENGER" | "PASSENGER_TO_PASSENGER";
  targetActorExpected: "driver" | "passenger";
  rootDriver: NetworkDriverActor | null;
  genealogy: {
    me: NetworkActor;
    ancestors: NetworkActor[];                 // sponsor chain
    descendants: FrontendGenealogyNode[];      // recursive tree
    lateral: NetworkActor[];                   // siblings
    operationalOwner: NetworkDriverActor | null;
  };
  networkMetrics: {
    totalActors: number;
    activeCount: number;                      // currently == totalDriversInTree
    depth: number;
    ridesFromNetwork?: number;
    estimatedRevenue?: number;
    growth?: { last7Days?: number; last30Days?: number; };
  };
  inviteUrls?: { d2d?, d2p?, p2p?, driverToPassenger?, driverToDriver?, passengerToPassenger? };
  capabilities?: {
    canInvitePassengers: boolean;
    canInviteDrivers: boolean;
    canReceiveRewards: boolean;
    canExpandNetwork: boolean;
    skillCodes: string[];
  };
}

interface FrontendGenealogyNode {
  actor: NetworkActor;
  depth: number;            // relative to viewer
  absoluteDepth: number;    // from root
  children: FrontendGenealogyNode[];
  nodeMetrics?: {
    directPassengerCount: number;
    directDriverCount: number;
    completedRides: number;
  };
}

interface NetworkActor {
  id: string;
  actorType: "driver" | "passenger";
  name: string;
  slug?: string | null;
  region?: string | null;
  avatarUrl?: string | null;   // currently always null
  joinedAt?: string | null;
}

interface NetworkDriverActor extends NetworkActor {
  actorType: "driver";
  vehicle?: { brand?; model?; plate?; category? } | null;
  rating?: number | null;
  offersAssistedTransport?: boolean;
  regions?: string[] | null;
  networkLevel?: number | null;
}
```

## 6.2 Suggested frontend endpoints to use

| Frontend View | Recommended Endpoint | Field(s) |
|---|---|---|
| Network dashboard | `GET /network/context?actorId=<id>&actorType=DRIVER` | `genealogy`, `networkMetrics`, `capabilities`, `inviteUrls` |
| Tree widget | same as above | `genealogy.descendants` |
| Sponsor chain | same as above | `genealogy.ancestors` |
| Siblings | same as above | `genealogy.lateral` |
| Org chart / graph | `GET /drivers/:id/network/genealogy?maxDepth=5` | `nodes`, `edges`, `levels`, `metrics` |
| KPI summary | `GET /drivers/:id/ownership` | `OwnershipMetrics` |
| Network conformance | `GET /godnetwork/status` | `assertConformance` output |

## 6.3 Suggested backend improvements (non-blocking)

1. **Fix `activeCount` semantics** in `NetworkContextProjectionService`: make it the count of active drivers, not total drivers in tree. This is a one-line change in `buildNetworkContextForDriver`/`buildNetworkContextForPassenger`.
2. **Add per-node revenue** to `NodeMetrics` if the dashboard needs revenue attribution per descendant.
3. **Add pagination or cursor-based fetching** to genealogy endpoints for large networks (e.g. `?limit` and `?cursor` on `GET /drivers/:id/network/genealogy`).
4. **Add a search/filter parameter** to genealogy endpoints (`?name`, `?level`, `?actorType`, `?activeOnly`).
5. **Add avatar field to User/Driver/Passenger** or remove `avatarUrl` from the DTO to avoid frontend confusion.
6. **Reconcile denormalized root columns** (`Passenger.rootDriverId`, `RideRequest.rootDriverId`) with `ReferralRelationship.rootDriverId` in a scheduled job, similar to `SyncProjectionJob`.
7. **Materialize inherited edges** in `ReferralRelationship` if the genealogy projection must show deep inherited relationships (e.g. Pedro → Carlinhos). Currently the projection may only show direct invite relationships unless the backfill has populated them.
8. **Stabilize the 4 failing tests** before building frontend dashboards that depend on onboarding, settlement, and ownership flows.

---

# 7. Summary Verdict

| Capability | Status |
|---|---|
| Hierarchical tree | ✅ READY |
| Sponsor chain (uplines) | ✅ READY |
| Descendants list with levels | ✅ READY |
| Network summary / KPIs | ⚠️ PARTIALLY READY (fix `activeCount` semantics) |
| Existing API surface | ✅ Comprehensive |
| Org chart | ⚠️ PARTIALLY READY (structure ready, needs frontend styling) |
| Network graph | ✅ READY (nodes + edges) |
| GodNetwork compliance | ✅ COMPLIANT (with governance risks noted) |

The backend already provides the core data structures needed for React/React Native network dashboards. The most important next step is to align the `activeCount` metric and to decide whether the frontend will use the recursive `descendants` from `/network/context` or the flat `nodes`/`edges` from the genealogy endpoint.
