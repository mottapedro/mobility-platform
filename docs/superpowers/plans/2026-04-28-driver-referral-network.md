# Driver Referral Network (Multi-Level) Implementation Plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` agent (recommended) or `executing-plans` agent to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the matching engine to support a 3-level driver referral network (Driver → Driver → Driver) that determines matching priority before the general pool.

**Architecture:** Add a `DriverReferral` join table that stores every directed edge in the network with its computed level (1–3). On driver registration, traverse the referrer's existing referrals to create inherited edges up to level 3. Update `MatchRideUseCase` to query this table per ride, dispatch offers to network levels first, then fall back to GENERAL.

**Tech Stack:** TypeScript · Prisma ORM v7 · PostgreSQL · Express · Jest + Supertest (integration tests on real DB)

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `prisma/migrations/<timestamp>_add_driver_referral/migration.sql` | SQL for `DriverReferral` table |
| Modify | `prisma/schema.prisma` | Add `DriverReferral` model + Driver relations |
| Create | `src/domain/services/DriverReferralService.ts` | `createChain()` + `getNetwork()` |
| Modify | `src/presentation/controllers/auth.controller.ts` | Call `createChain` after driver creation |
| Modify | `src/application/use-cases/MatchRideUseCase.ts` | Replace REFERRED→PARTNER→GENERAL with 5-tier flow |
| Create | `tests/driver-referral.spec.ts` | Integration tests for referral chain + matching |

---

### Task 1: Add `DriverReferral` to Prisma Schema and Migrate

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_driver_referral/migration.sql`

- [ ] **Step 1: Add model and relations to schema**

Open `prisma/schema.prisma`. Add this block **after** the `Passenger` model:

```prisma
model DriverReferral {
  id               String   @id @default(uuid())

  referrerDriverId String
  referrer         Driver   @relation("Referrer", fields: [referrerDriverId], references: [id])

  referredDriverId String
  referred         Driver   @relation("Referred", fields: [referredDriverId], references: [id])

  level            Int

  createdAt        DateTime @default(now())

  @@unique([referrerDriverId, referredDriverId])
}
```

Update the `Driver` model — **replace** the existing `referredDrivers` / `referredByDriver` block (DriverNetwork self-relation) with the new explicit relations:

```prisma
model Driver {
  id              String          @id @default(uuid())
  userId          String          @unique
  experienceLevel ExperienceLevel
  isActive        Boolean         @default(true)
  createdAt       DateTime        @default(now())
  selectedRides   RideRequest[]

  user         User                 @relation(fields: [userId], references: [id])
  vehicles     Vehicle[]
  regions      DriverRegion[]
  offers       RideOffer[]
  availability DriverAvailability[]

  referredPassengers Passenger[] @relation("DriverReferral")

  // Explicit multi-level referral network
  referralsMade     DriverReferral[] @relation("Referrer")
  referralsReceived DriverReferral[] @relation("Referred")
}
```

> **Note:** Remove the old `referredByDriverId`, `referredByDriver`, and `referredDrivers` fields from `Driver`. They are replaced by the join table.

- [ ] **Step 2: Run migration**

```bash
npx prisma migrate dev --name add_driver_referral
```

Expected: migration file created, `DriverReferral` table in DB, Prisma client regenerated.

- [ ] **Step 3: Verify generated client**

```bash
npx prisma generate
```

Expected: no errors. Verify `prisma.driverReferral` is accessible in TypeScript autocomplete.

- [ ] **Step 4: Run existing tests to confirm nothing broke**

```bash
npm test
```

Expected: `34 passed` — existing tests must still pass before continuing.

- [ ] **Step 5: Commit**

```bash
git add prisma/
git commit -m "feat(prisma): add DriverReferral model for multi-level driver network"
```

---

### Task 2: Create `DriverReferralService`

**Files:**
- Create: `src/domain/services/DriverReferralService.ts`

- [ ] **Step 1: Write the failing test first**

In `tests/driver-referral.spec.ts` (new file — create it):

```typescript
import { prisma } from "./setup";
import {
  createDriverReferralChain,
  getDriverNetwork,
} from "../src/domain/services/DriverReferralService";

jest.setTimeout(15000);

async function createDriver(email: string) {
  const user = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: "11999990000",
      role: "DRIVER",
      driver: { create: { experienceLevel: "PROFISSIONAL", isActive: true } },
    },
    include: { driver: true },
  });
  return user.driver!;
}

describe("createDriverReferralChain", () => {
  it("cria vínculo level 1 entre referrer e novo driver", async () => {
    const driverA = await createDriver("a@ref.com");
    const driverB = await createDriver("b@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);

    const chain = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverA.id, referredDriverId: driverB.id },
    });
    expect(chain).not.toBeNull();
    expect(chain!.level).toBe(1);
  });

  it("herda nível 2 quando referrer já tem um nível 1", async () => {
    const driverA = await createDriver("a2@ref.com");
    const driverB = await createDriver("b2@ref.com");
    const driverC = await createDriver("c2@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id); // A→B level 1
    await createDriverReferralChain(driverC.id, driverB.id); // B→C, herda A→C level 2

    const level2 = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverA.id, referredDriverId: driverC.id },
    });
    expect(level2).not.toBeNull();
    expect(level2!.level).toBe(2);
  });

  it("herda nível 3 e NÃO cria nível 4", async () => {
    const driverA = await createDriver("a3@ref.com");
    const driverB = await createDriver("b3@ref.com");
    const driverC = await createDriver("c3@ref.com");
    const driverD = await createDriver("d3@ref.com");
    const driverE = await createDriver("e3@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);
    await createDriverReferralChain(driverC.id, driverB.id);
    await createDriverReferralChain(driverD.id, driverC.id); // A→D level 3

    const level3 = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverA.id, referredDriverId: driverD.id },
    });
    expect(level3!.level).toBe(3);

    await createDriverReferralChain(driverE.id, driverD.id); // A→E would be level 4 — must NOT exist

    const level4 = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverA.id, referredDriverId: driverE.id },
    });
    expect(level4).toBeNull();
  });

  it("não cria duplicidade quando chamado duas vezes", async () => {
    const driverA = await createDriver("a4@ref.com");
    const driverB = await createDriver("b4@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);
    await createDriverReferralChain(driverB.id, driverA.id); // duplicata — deve ser ignorada

    const count = await prisma.driverReferral.count({
      where: { referrerDriverId: driverA.id, referredDriverId: driverB.id },
    });
    expect(count).toBe(1);
  });

  it("não cria self-referral", async () => {
    const driverA = await createDriver("self@ref.com");

    await createDriverReferralChain(driverA.id, driverA.id);

    const self = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverA.id, referredDriverId: driverA.id },
    });
    expect(self).toBeNull();
  });
});

describe("getDriverNetwork", () => {
  it("retorna drivers agrupados por level 1, 2 e 3", async () => {
    const driverA = await createDriver("net_a@ref.com");
    const driverB = await createDriver("net_b@ref.com");
    const driverC = await createDriver("net_c@ref.com");
    const driverD = await createDriver("net_d@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);
    await createDriverReferralChain(driverC.id, driverB.id);
    await createDriverReferralChain(driverD.id, driverC.id);

    const network = await getDriverNetwork(driverA.id);

    expect(network.level1).toContain(driverB.id);
    expect(network.level2).toContain(driverC.id);
    expect(network.level3).toContain(driverD.id);
    expect(network.level1).not.toContain(driverC.id);
    expect(network.level2).not.toContain(driverD.id);
  });

  it("retorna arrays vazios quando driver não tem rede", async () => {
    const driverA = await createDriver("lonely@ref.com");

    const network = await getDriverNetwork(driverA.id);

    expect(network.level1).toHaveLength(0);
    expect(network.level2).toHaveLength(0);
    expect(network.level3).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
npm test -- driver-referral.spec --no-coverage
```

Expected: FAIL — "Cannot find module `DriverReferralService`"

- [ ] **Step 3: Implement `DriverReferralService.ts`**

Create `src/domain/services/DriverReferralService.ts`:

```typescript
import { prisma } from "../../infra/prisma/client";

export interface DriverNetwork {
  level1: string[];
  level2: string[];
  level3: string[];
}

/**
 * Creates the full referral chain when a new driver registers with a referrer.
 * - Creates level-1 edge: referrer → newDriver
 * - Inherits edges from referrer's own referrers (level+1), capped at level 3
 * - Skips self-referrals and duplicate edges (@@unique in DB)
 */
export async function createDriverReferralChain(
  newDriverId: string,
  referrerDriverId: string
): Promise<void> {
  if (newDriverId === referrerDriverId) return;

  const edgesToCreate: { referrerDriverId: string; referredDriverId: string; level: number }[] = [];

  // Level 1: direct referrer → newDriver
  edgesToCreate.push({ referrerDriverId, referredDriverId: newDriverId, level: 1 });

  // Inherited levels: find all referrals where referrer is the referred party
  const parentReferrals = await prisma.driverReferral.findMany({
    where: { referredDriverId: referrerDriverId },
  });

  for (const parent of parentReferrals) {
    const inheritedLevel = parent.level + 1;
    if (inheritedLevel > 3) continue;
    if (parent.referrerDriverId === newDriverId) continue; // prevent cycles

    edgesToCreate.push({
      referrerDriverId: parent.referrerDriverId,
      referredDriverId: newDriverId,
      level: inheritedLevel,
    });
  }

  // Insert all edges, skip duplicates via @@unique constraint
  for (const edge of edgesToCreate) {
    try {
      await prisma.driverReferral.create({ data: edge });
    } catch {
      // P2002 unique constraint — duplicate edge, ignore
    }
  }
}

/**
 * Returns the IDs of all drivers in the network of a given driver, grouped by level.
 */
export async function getDriverNetwork(driverId: string): Promise<DriverNetwork> {
  const referrals = await prisma.driverReferral.findMany({
    where: { referrerDriverId: driverId },
    select: { referredDriverId: true, level: true },
  });

  const network: DriverNetwork = { level1: [], level2: [], level3: [] };

  for (const r of referrals) {
    if (r.level === 1) network.level1.push(r.referredDriverId);
    else if (r.level === 2) network.level2.push(r.referredDriverId);
    else if (r.level === 3) network.level3.push(r.referredDriverId);
  }

  console.log(`[Referral] Level 1 drivers: ${network.level1.length}`);
  console.log(`[Referral] Level 2 drivers: ${network.level2.length}`);
  console.log(`[Referral] Level 3 drivers: ${network.level3.length}`);

  return network;
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- driver-referral.spec --no-coverage
```

Expected: all `createDriverReferralChain` and `getDriverNetwork` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/ tests/driver-referral.spec.ts
git commit -m "feat(referral): add DriverReferralService with createChain and getNetwork"
```

---

### Task 3: Call `createDriverReferralChain` on Driver Registration

**Files:**
- Modify: `src/presentation/controllers/auth.controller.ts`

- [ ] **Step 1: Write the failing test**

Add this describe block to `tests/auth.spec.ts`, inside the existing `POST /auth/register — motorista` suite:

```typescript
it("deve criar cadeia de referral quando motorista se registra com referredByDriverId", async () => {
  // Registrar Driver A (referrer)
  const driverARes = await request(app).post("/auth/register").send({
    name: "Driver A Chain",
    email: "driverA_chain@auth.com",
    password: "senha123",
    role: "driver",
    phone: "",
    experienceLevel: "PROFISSIONAL",
    vehicle: { model: "Corolla", brand: "Toyota", plate: "CHA-0001", category: "EXECUTIVO" },
    region: ["ZN"],
  });
  expect(driverARes.status).toBe(201);

  // Registrar Driver B referenciando Driver A
  const driverBRes = await request(app).post("/auth/register").send({
    name: "Driver B Chain",
    email: "driverB_chain@auth.com",
    password: "senha123",
    role: "driver",
    phone: "",
    experienceLevel: "INTERMEDIARIO",
    vehicle: { model: "HB20", brand: "Hyundai", plate: "CHA-0002", category: "CONFORTO" },
    region: ["ZS"],
    referredByDriverId: driverARes.body.driverId,
  });
  expect(driverBRes.status).toBe(201);

  const chain = await prisma.driverReferral.findFirst({
    where: {
      referrerDriverId: driverARes.body.driverId,
      referredDriverId: driverBRes.body.driverId,
    },
  });
  expect(chain).not.toBeNull();
  expect(chain!.level).toBe(1);
});
```

- [ ] **Step 2: Run failing test**

```bash
npm test -- auth.spec --no-coverage
```

Expected: new test FAILs — chain not created.

- [ ] **Step 3: Update `auth.controller.ts`**

Add import at top:

```typescript
import { createDriverReferralChain } from "../../domain/services/DriverReferralService";
```

Inside the `role === "driver"` block, **after** `prisma.driverRegion.createMany(...)` and **before** `return res.status(201)...`:

```typescript
// Create referral chain if driver was referred
if (referredByDriverId) {
  await createDriverReferralChain(driver.id, referredByDriverId);
}
```

The `referredByDriverId` is already validated and already exists in scope from the destructuring at the top of `register()`.

- [ ] **Step 4: Run tests**

```bash
npm test -- auth.spec --no-coverage
```

Expected: all 15 auth tests pass (14 original + 1 new).

- [ ] **Step 5: Commit**

```bash
git add src/presentation/controllers/auth.controller.ts
git commit -m "feat(auth): call createDriverReferralChain on driver registration"
```

---

### Task 4: Update `MatchRideUseCase` — 5-Tier Network Matching

**Files:**
- Modify: `src/application/use-cases/MatchRideUseCase.ts`

- [ ] **Step 1: Write the failing tests**

Add this describe block to `tests/driver-referral.spec.ts`:

```typescript
import request from "supertest";
import { app } from "../src/app";
// (keep existing imports)

// Helper already defined above: createDriver()
// Add helper: waitForOffers — same as matching.spec.ts
async function waitForOffers(
  rideId: string,
  minCount = 1,
  maxWaitMs = 5000,
  intervalMs = 150
): Promise<Array<{ id: string; driverId: string; createdAt: Date }>> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const offers = await prisma.rideOffer.findMany({
      where: { rideRequestId: rideId },
      orderBy: { createdAt: "asc" },
      select: { id: true, driverId: true, createdAt: true },
    });
    if (offers.length >= minCount) return offers;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return prisma.rideOffer.findMany({
    where: { rideRequestId: rideId },
    orderBy: { createdAt: "asc" },
    select: { id: true, driverId: true, createdAt: true },
  });
}

describe("Matching — Driver Network (multi-level)", () => {
  it("Level 1 da rede recebe offer antes dos drivers gerais", async () => {
    const driverA = await createDriver("match_a@ref.com");
    const driverB = await createDriver("match_b@ref.com");   // level 1 de A
    const driverC = await createDriver("match_c@ref.com");   // geral

    await createDriverReferralChain(driverB.id, driverA.id);

    // Passageiro indicado por Driver A
    const passengerUser = await prisma.user.create({
      data: {
        name: "Pax Network",
        email: "pax_network@ref.com",
        phone: "99000000010",
        role: "PASSENGER",
      },
    });
    const passenger = await prisma.passenger.create({
      data: {
        userId: passengerUser.id,
        referredByDriver: { connect: { id: driverA.id } },
      },
    });

    const rideRes = await request(app).post("/rides").send({
      passengerId: passenger.id,
      origin: "Barra",
      destination: "Centro",
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(rideRes.status).toBe(201);
    const rideId = rideRes.body.ride.id;

    // Aguardar a offer exclusiva do Driver A (REFERRED)
    const offers = await waitForOffers(rideId, 1);
    const driverAOffer = offers.find(o => o.driverId === driverA.id);
    expect(driverAOffer).toBeDefined();

    // Driver A rejeita → rede nível 1 (Driver B) deve receber offer
    const rejectRes = await request(app)
      .patch(`/offers/${driverAOffer!.id}/respond`)
      .send({ accept: false });
    expect(rejectRes.status).toBe(200);

    const allOffers = await waitForOffers(rideId, 2);
    const driverBOffer = allOffers.find(o => o.driverId === driverB.id);
    expect(driverBOffer).toBeDefined();

    // Driver C (geral) NÃO deve ter recebido offer ainda
    const driverCOffer = allOffers.find(o => o.driverId === driverC.id);
    expect(driverCOffer).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
npm test -- driver-referral.spec --no-coverage
```

Expected: the network matching test FAILS — Driver B doesn't get offer before Driver C.

- [ ] **Step 3: Update `MatchLevel` type**

In `MatchRideUseCase.ts`, replace:

```typescript
export type MatchLevel = "REFERRED" | "PARTNER" | "GENERAL";
```

with:

```typescript
export type MatchLevel = "REFERRED" | "NETWORK_L1" | "NETWORK_L2" | "NETWORK_L3" | "GENERAL";
```

- [ ] **Step 4: Add `getDriverNetwork` import**

At the top of `MatchRideUseCase.ts`, add:

```typescript
import { getDriverNetwork } from "../../domain/services/DriverReferralService";
```

- [ ] **Step 5: Replace the PARTNER tier with NETWORK tiers**

In `MatchRideUseCase.ts`, replace the entire `deriveLevel` method with:

```typescript
private async deriveLevel(
  rideId: string,
  referredDriverId: string | null
): Promise<MatchLevel> {
  if (!referredDriverId) return "GENERAL";

  const referredOffer = await prisma.rideOffer.findFirst({
    where: { rideRequestId: rideId, driverId: referredDriverId },
  });

  if (!referredOffer) return "REFERRED";

  // Referred driver already tried — check network levels
  const network = await getDriverNetwork(referredDriverId);

  const triedOffers = await prisma.rideOffer.findMany({
    where: { rideRequestId: rideId },
    select: { driverId: true },
  });
  const triedSet = new Set(triedOffers.map((o) => o.driverId));

  if (network.level1.some((id) => !triedSet.has(id))) return "NETWORK_L1";
  if (network.level2.some((id) => !triedSet.has(id))) return "NETWORK_L2";
  if (network.level3.some((id) => !triedSet.has(id))) return "NETWORK_L3";

  return "GENERAL";
}
```

- [ ] **Step 6: Replace the PARTNER tier execution block**

In `MatchRideUseCase.ts`, replace the block:

```typescript
// ── Tier 2: PARTNER ───────────────────────────────────────────────────────
if (level === "PARTNER") {
  // ...existing partner code...
}
```

with:

```typescript
// ── Tier 2-4: NETWORK LEVELS ─────────────────────────────────────────────
if (level === "NETWORK_L1" || level === "NETWORK_L2" || level === "NETWORK_L3") {
  if (!referredDriverId) {
    return this.execute({ rideId, level: "GENERAL", excludedDriverIds });
  }

  await prisma.rideRequest.update({
    where: { id: rideId },
    data: { status: "MATCHING" },
  });

  const network = await getDriverNetwork(referredDriverId);
  const networkMap: Record<string, string[]> = {
    NETWORK_L1: network.level1,
    NETWORK_L2: network.level2,
    NETWORK_L3: network.level3,
  };
  const candidates = networkMap[level].filter((id) => !alreadyOfferedIds.has(id));

  // Fetch active drivers with vehicle info for context filtering
  const candidateDrivers = await prisma.driver.findMany({
    where: { id: { in: candidates }, isActive: true },
    select: { id: true, experienceLevel: true, vehicles: { select: { category: true } } },
  });

  const filtered = applyContextFilters(candidateDrivers, rideContext);

  console.log(`🌐 Network ${level}: ${filtered.length} drivers disponíveis`);

  if (filtered.length === 0) {
    // Escalate to next level
    const nextLevel: Record<string, MatchLevel> = {
      NETWORK_L1: "NETWORK_L2",
      NETWORK_L2: "NETWORK_L3",
      NETWORK_L3: "GENERAL",
    };
    return this.execute({ rideId, level: nextLevel[level], excludedDriverIds });
  }

  for (const driver of filtered) {
    await this.createOffer(rideId, driver.id, expiresAt);
  }
  return { matched: true, level };
}
```

- [ ] **Step 7: Update fallback in REFERRED tier**

In the `REFERRED` tier timeout, replace `level: "GENERAL"` fallback with `level: "NETWORK_L1"` so it cascades through the network before going to general:

```typescript
await this.execute({
  rideId,
  level: "NETWORK_L1",
  excludedDriverIds: [...excludedDriverIds, referredDriverId],
});
```

Also in `RespondToRideOfferUseCase.ts`, when `isWaitingReferral && isReferredDriver`, change the fallback:

```typescript
const { matched } = await matchRide.execute({
  rideId: offer.rideRequestId,
  level: "NETWORK_L1",
  excludedDriverIds: [offer.driverId],
});
```

And in `ride.controller.ts` `patch()` method for `reject_referral`, change:

```typescript
const { matched } = await matchRideUseCase.execute({
  rideId: id,
  level: "NETWORK_L1",
  excludedDriverIds: referredDriverId ? [referredDriverId] : [],
});
```

- [ ] **Step 8: Run all tests**

```bash
npm test
```

Expected: all tests pass including the new network matching test.

- [ ] **Step 9: Commit**

```bash
git add src/application/use-cases/MatchRideUseCase.ts src/application/use-cases/RespondToRideOfferUseCase.ts src/presentation/controllers/ride.controller.ts
git commit -m "feat(matching): replace PARTNER tier with 3-level driver network matching"
```

---

### Task 5: Final test run and cleanup

- [ ] **Step 1: Run full suite**

```bash
npm test
```

Expected output:
```
Test Suites: 5 passed, 5 total
Tests:       XX passed
```

- [ ] **Step 2: Verify matching logs look correct**

Start the server and create a ride manually (or use an existing integration test log). Verify you see:

```
[Referral] Level 1 drivers: X
[Referral] Level 2 drivers: X
[Referral] Level 3 drivers: X
🌐 Network NETWORK_L1: X drivers disponíveis
```

- [ ] **Step 3: Final commit**

```bash
git add .
git commit -m "test(referral): integration tests for driver network chain and matching"
```

---

## Self-Review

**Spec coverage:**
- ✅ `DriverReferral` model with level, @@unique — Task 1
- ✅ `createChain` (level 1 + inheritance up to 3, no self-referral, no duplicates) — Task 2
- ✅ `getDriverNetwork` returning grouped IDs — Task 2
- ✅ Chain created on driver registration via auth — Task 3
- ✅ Matching: REFERRED → NETWORK_L1 → NETWORK_L2 → NETWORK_L3 → GENERAL — Task 4
- ✅ Fallback paths updated (timeout, reject_referral, respond) — Task 4
- ✅ Logs `[Referral] Level X drivers: N` — Task 2 (in `getDriverNetwork`)
- ✅ Tests: chain levels 1/2/3, no level 4, no duplicates, no self-referral, network matching — Tasks 2 & 4

**Breaking change check:**
- Old `referredByDriverId` self-relation on `Driver` is **removed** — this is a schema change. The column existed but was only used in `MatchRideUseCase` PARTNER tier (which is replaced) and in `seed.ts`. Update `seed.ts` to use `createDriverReferralChain` after creating drivers. Check `setup.ts` `beforeEach` — it deletes `driverRegion` but not `driverReferral`. Add `await prisma.driverReferral.deleteMany()` before `await prisma.driver.deleteMany()` in `setup.ts`.

**Type consistency:**
- `MatchLevel` changes from `"PARTNER"` to `"NETWORK_L1" | "NETWORK_L2" | "NETWORK_L3"` — all callers that pass `level: "PARTNER"` must be updated (only `RespondToRideOfferUseCase` and `ride.controller.ts`; both handled in Task 4 Step 7).
