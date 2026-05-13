# MatchingPriorityEngine V1.1 + Bootstrap Driver Network V1 Implementation Plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` agent (recommended) or `executing-plans` agent to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic V1.1 matching priority pipeline that sends offers in referral-direct, referral-network, region, then global order without duplicate drivers, while safely bootstrapping a real driver hierarchy keyed by stable `referralCode` without resetting or overwriting live data.

**Architecture:** Keep `MatchRideUseCase` as the orchestration point for ride status transitions and offer creation, but extract candidate ordering into a dedicated `MatchingPriorityEngine` so referral/network/region/global selection is testable in isolation. For the bootstrap work, move the network source of truth to `prisma/drivers-seed.json` keyed by `referralCode`, make bootstrap/backfill null-safe and additive only, and preserve existing user, driver, passenger, region, and referral rows.

**Tech Stack:** TypeScript, Prisma, PostgreSQL, Jest, Supertest, Playwright

---

## File Map

**Matching priority engine**
- Create: `src/domain/services/MatchingPriorityEngine.ts` — builds the ordered, deduplicated candidate queue for `NETWORK_L1`, `NETWORK_L2`, `NETWORK_L3`, and `GENERAL` entrypoints.
- Create: `src/shared/logging/matchingLog.ts` — emits structured JSON logs for candidate collection, offer preparation, stage transitions, and fallback reasons.
- Modify: `src/application/use-cases/MatchRideUseCase.ts` — keep referral exclusivity and timeouts, but delegate post-referral queue construction and structured logging to the new engine.
- Modify: `src/application/use-cases/RespondToRideOfferUseCase.ts` — preserve rejection/rematch semantics when post-referral matching is flattened into one ordered queue.
- Modify: `src/application/use-cases/ExpireOffersService.ts` — keep automatic rematch behavior aligned with the new queue semantics.
- Modify: `src/domain/services/DriverReferralService.ts` — reuse existing network lookup, but expose helpers or stable ordering as needed by the engine.

**Bootstrap driver network**
- Modify: `prisma/drivers-seed.json` — replace unstable `driverId`-centric records with `referralCode` and `parentReferralCode` records.
- Modify: `prisma/seeds/bootstrap-network.ts` — read JSON source data, upsert only missing data, add missing regions/vehicles/edges, and never clobber live fields.
- Modify: `scripts/network/bootstrap-network.ts` — support dry-run-first execution and emit a machine-readable summary.
- Modify: `src/domain/services/DriverNetworkBackfillService.ts` — preserve existing `referralCode` values, fill only null/missing hierarchy fields, and surface conflicts explicitly.
- Modify: `src/domain/services/DriverIdentityService.ts` — keep stable slug/referral-code builders as the canonical write path.
- Modify: `src/domain/services/ReferralCodeService.ts` — continue resolving legacy codes, but prefer exact stored `referralCode` for bootstrap/runtime linking.
- Modify: `src/presentation/controllers/auth.controller.ts` — generate new driver `referralCode` values with `buildDriverReferralCode(...)` instead of raw slug reuse.
- Modify: `src/presentation/controllers/driver.controller.ts` — align manual driver creation with the same stable referral-code builder.
- Modify: `docs/bootstrap-network.md` — update the runbook for dry-run bootstrap, non-destructive guarantees, and validation steps.
- Modify: `package.json` — add or rename scripts so bootstrap has an explicit dry-run and write mode.

**Tests**
- Create: `tests/matching-priority-engine.spec.ts`
- Modify: `tests/matching.spec.ts`
- Modify: `tests/match-ride-region.spec.ts`
- Modify: `tests/offers.spec.ts`
- Modify: `tests/auth-register.spec.ts`
- Modify: `tests/bootstrap-network.spec.ts`
- Modify: `tests/driver-network-backfill.spec.ts`
- Modify: `tests/e2e/referral-flow.spec.ts`

## Critical Concerns

- The only exclusive stage must remain the direct referred driver. `WAITING_REFERRAL` cannot leak into region/global behavior.
- Duplicate drivers must be filtered across all tiers and re-match attempts, not just inside a single Prisma query.
- Existing `rideOffer` uniqueness is a safety net, not the primary dedupe mechanism. The queue must be deduped before offer preparation.
- Bootstrap must never call destructive seed/reset flows, overwrite real passwords, replace real phone numbers, or remove existing regions/referral links.
- Stored `referralCode` is now a stable identifier. Existing live codes must be preserved; only missing codes should be generated.
- The bootstrap source data must stop depending on old `driverId` values from a local database dump.

### Task 1: Freeze MatchingPriorityEngine V1.1 Behavior With Red Tests

**Files:**
- Create: `tests/matching-priority-engine.spec.ts`
- Modify: `tests/matching.spec.ts`
- Modify: `tests/match-ride-region.spec.ts`
- Modify: `tests/offers.spec.ts`

- [ ] **Step 1: Write the new engine-level test for ordered, deduplicated candidates**

```ts
import { MatchingPriorityEngine } from "../src/domain/services/MatchingPriorityEngine";

describe("MatchingPriorityEngine", () => {
  it("builds referral-network, region, then global candidates without duplicates", async () => {
    const engine = new MatchingPriorityEngine(
      { resolve: jest.fn().mockReturnValue("Zona Sul") } as never,
      { execute: jest.fn().mockResolvedValue([{ driverId: "driver-region", matchedRegion: "ZS" }]) } as never,
      { getNetwork: jest.fn().mockResolvedValue({ level1: ["driver-l1", "driver-dup"], level2: ["driver-l2"], level3: ["driver-dup", "driver-l3"] }) } as never
    );

    const queue = await engine.buildQueue({
      rideId: "ride-1",
      origin: "Copacabana",
      referredDriverId: "driver-direct",
      startLevel: "NETWORK_L1",
      alreadyOfferedIds: new Set(["driver-direct"]),
      excludedDriverIds: ["driver-global-excluded"],
      rideContext: null,
    });

    expect(queue.map((candidate) => [candidate.driverId, candidate.stage])).toEqual([
      ["driver-l1", "REFERRAL_NETWORK"],
      ["driver-dup", "REFERRAL_NETWORK"],
      ["driver-l2", "REFERRAL_NETWORK"],
      ["driver-l3", "REFERRAL_NETWORK"],
      ["driver-region", "REGION"],
      ["driver-global", "GLOBAL"],
    ]);
  });
});
```

- [ ] **Step 2: Run the new engine test and confirm it fails before the implementation exists**

Run: `npx jest tests/matching-priority-engine.spec.ts --runInBand`

Expected: FAIL with `Cannot find module '../src/domain/services/MatchingPriorityEngine'`.

- [ ] **Step 3: Extend the integration test to prove region only runs after the referral network is exhausted**

```ts
it("falls back to region matches only after all referral-network candidates were already offered", async () => {
  rideOfferFindManyMock.mockResolvedValue([
    { driverId: "driver-direct" },
    { driverId: "driver-l1" },
    { driverId: "driver-l2" },
    { driverId: "driver-l3" },
  ] as never);

  const useCase = new MatchRideUseCase(
    { resolve: jest.fn().mockReturnValue("Zona Sul") } as never,
    { execute: jest.fn().mockResolvedValue([{ driverId: "driver-region", matchedRegion: "ZS" }]) } as never
  );

  const result = await useCase.execute({ rideId: "ride-1", level: "NETWORK_L1" });

  expect(rideOfferCreateMock.mock.calls.map((call) => call[0].data.driverId)).toEqual(["driver-region"]);
  expect(result).toEqual({ matched: true, level: "GENERAL" });
});
```

- [ ] **Step 4: Run the matching integration tests and confirm they fail on the current stage-by-stage recursion**

Run: `npx jest tests/matching.spec.ts tests/match-ride-region.spec.ts --runInBand`

Expected: FAIL because the current implementation escalates recursively and does not flatten network, region, and global candidates into one ordered queue.

- [ ] **Step 5: Add the offer-response regression test so rejection still rematches into the new queue**

```ts
it("re-matches into the next queued candidate after a rejection with no duplicate offer rows", async () => {
  const firstOffer = await prisma.rideOffer.create({
    data: {
      rideRequestId: ride.id,
      driverId: firstDriver.driver!.id,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 100000),
    },
  });

  await request(app).patch(`/offers/${firstOffer.id}/respond`).send({ accept: false }).expect(200);

  const offers = await prisma.rideOffer.findMany({
    where: { rideRequestId: ride.id },
    orderBy: { createdAt: "asc" },
  });

  expect(new Set(offers.map((offer) => offer.driverId)).size).toBe(offers.length);
  expect(offers.some((offer) => offer.driverId === secondDriver.driver!.id)).toBe(true);
});
```

- [ ] **Step 6: Run the offer-flow test and confirm the current implementation still needs wiring changes**

Run: `npx jest tests/offers.spec.ts --runInBand`

Expected: FAIL because rejection/rematch currently assumes the old stage recursion.

- [ ] **Step 7: Commit the red matching tests**

```bash
git add tests/matching-priority-engine.spec.ts tests/matching.spec.ts tests/match-ride-region.spec.ts tests/offers.spec.ts
git commit -m "test: lock matching priority engine behavior"
```

### Task 2: Implement the MatchingPriorityEngine and Structured Logs

**Files:**
- Create: `src/domain/services/MatchingPriorityEngine.ts`
- Create: `src/shared/logging/matchingLog.ts`
- Modify: `src/domain/services/DriverReferralService.ts`

- [ ] **Step 1: Add the structured log helper first so every stage emits the same payload shape**

```ts
export type MatchingLogEvent = {
  rideId: string;
  event:
    | "matching_started"
    | "candidate_stage_built"
    | "offers_prepared"
    | "fallback_scheduled"
    | "fallback_triggered"
    | "matching_finished";
  stage?: "REFERRAL_DIRECT" | "REFERRAL_NETWORK" | "REGION" | "GLOBAL";
  candidateDriverIds?: string[];
  excludedDriverIds?: string[];
  resolvedRegion?: string | null;
  metadata?: Record<string, unknown>;
};

export function logMatchingEvent(event: MatchingLogEvent) {
  console.log(JSON.stringify({ scope: "matching", at: new Date().toISOString(), ...event }));
}
```

- [ ] **Step 2: Implement the new engine with a single deduped queue builder**

```ts
import { prisma } from "../../infra/prisma/client";
import { DriverRegionMatcher } from "./DriverRegionMatcher";
import { getDriverNetwork } from "./DriverReferralService";
import { RegionResolver } from "./RegionResolver";

export type MatchingStage = "REFERRAL_NETWORK" | "REGION" | "GLOBAL";

export type MatchingCandidate = {
  driverId: string;
  stage: MatchingStage;
  networkLevel?: 1 | 2 | 3;
  matchedRegion?: string;
};

export class MatchingPriorityEngine {
  constructor(
    private readonly regionResolver = new RegionResolver(),
    private readonly driverRegionMatcher = new DriverRegionMatcher()
  ) {}

  async buildQueue(input: {
    rideId: string;
    origin: string;
    referredDriverId: string | null;
    startLevel: "NETWORK_L1" | "NETWORK_L2" | "NETWORK_L3" | "GENERAL";
    alreadyOfferedIds: Set<string>;
    excludedDriverIds: string[];
    rideContext: unknown;
  }): Promise<MatchingCandidate[]> {
    const seen = new Set([...input.alreadyOfferedIds, ...input.excludedDriverIds]);
    const queue: MatchingCandidate[] = [];

    const network = input.referredDriverId ? await getDriverNetwork(input.referredDriverId) : { level1: [], level2: [], level3: [] };
    const networkSlices = {
      NETWORK_L1: [[1, network.level1], [2, network.level2], [3, network.level3]],
      NETWORK_L2: [[2, network.level2], [3, network.level3]],
      NETWORK_L3: [[3, network.level3]],
      GENERAL: [],
    } as const;

    for (const [level, ids] of networkSlices[input.startLevel]) {
      for (const driverId of ids) {
        if (seen.has(driverId)) continue;
        seen.add(driverId);
        queue.push({ driverId, stage: "REFERRAL_NETWORK", networkLevel: level as 1 | 2 | 3 });
      }
    }

    const resolvedRegion = this.regionResolver.resolve(input.origin);
    const regionalMatches = await this.driverRegionMatcher.execute({ region: resolvedRegion });
    for (const match of regionalMatches) {
      if (seen.has(match.driverId)) continue;
      seen.add(match.driverId);
      queue.push({ driverId: match.driverId, stage: "REGION", matchedRegion: match.matchedRegion });
    }

    const generalDrivers = await prisma.driver.findMany({
      where: { isActive: true, id: { notIn: [...seen] } },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    for (const driver of generalDrivers) {
      queue.push({ driverId: driver.id, stage: "GLOBAL" });
    }

    return queue;
  }
}
```

- [ ] **Step 3: Keep the referral service stable, but add one helper if the engine needs a typed accessor**

```ts
export async function getOrderedDriverNetworkLevels(driverId: string): Promise<Array<{ level: 1 | 2 | 3; driverIds: string[] }>> {
  const network = await getDriverNetwork(driverId);

  return [
    { level: 1, driverIds: network.level1 },
    { level: 2, driverIds: network.level2 },
    { level: 3, driverIds: network.level3 },
  ];
}
```

- [ ] **Step 4: Run the engine unit test and make it pass before wiring the use case**

Run: `npx jest tests/matching-priority-engine.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit the isolated engine implementation**

```bash
git add src/domain/services/MatchingPriorityEngine.ts src/shared/logging/matchingLog.ts src/domain/services/DriverReferralService.ts tests/matching-priority-engine.spec.ts
git commit -m "feat: add matching priority engine"
```

### Task 3: Wire MatchRideUseCase to the New Queue Without Breaking Offer Flow

**Files:**
- Modify: `src/application/use-cases/MatchRideUseCase.ts`
- Modify: `src/application/use-cases/RespondToRideOfferUseCase.ts`
- Modify: `src/application/use-cases/ExpireOffersService.ts`
- Modify: `tests/matching.spec.ts`
- Modify: `tests/match-ride-region.spec.ts`
- Modify: `tests/offers.spec.ts`
- Modify: `tests/e2e/referral-flow.spec.ts`

- [ ] **Step 1: Replace the post-referral recursion in `MatchRideUseCase` with queue preparation**

```ts
const queue = await this.matchingPriorityEngine.buildQueue({
  rideId,
  origin: ride.origin,
  referredDriverId,
  startLevel: level === "REFERRED" ? "NETWORK_L1" : level,
  alreadyOfferedIds,
  excludedDriverIds,
  rideContext,
});

if (queue.length === 0) {
  logMatchingEvent({ rideId, event: "matching_finished", metadata: { matched: false, level } });
  return { matched: false, level: "GENERAL" };
}

for (const candidate of queue) {
  await this.createOffer(rideId, candidate.driverId, expiresAt);
}

logMatchingEvent({
  rideId,
  event: "offers_prepared",
  candidateDriverIds: queue.map((candidate) => candidate.driverId),
  metadata: { level, totalOffers: queue.length },
});

return { matched: true, level: "GENERAL" };
```

- [ ] **Step 2: Keep the direct referred driver exclusive and logged separately**

```ts
if (level === "REFERRED" && referredDriverId && !alreadyOfferedIds.has(referredDriverId)) {
  await prisma.rideRequest.update({ where: { id: rideId }, data: { status: "WAITING_REFERRAL" } });
  await this.createOffer(rideId, referredDriverId, expiresAt);

  logMatchingEvent({
    rideId,
    event: "offers_prepared",
    stage: "REFERRAL_DIRECT",
    candidateDriverIds: [referredDriverId],
  });

  setTimeout(async () => {
    const updated = await prisma.rideRequest.updateMany({
      where: { id: rideId, status: "WAITING_REFERRAL" },
      data: { status: "MATCHING" },
    });
    if (updated.count === 0) return;

    logMatchingEvent({ rideId, event: "fallback_triggered", stage: "REFERRAL_DIRECT" });
    await this.execute({ rideId, level: "NETWORK_L1", excludedDriverIds: [...excludedDriverIds, referredDriverId] });
  }, REFERRAL_TIMEOUT_MS);

  return { matched: true, level: "REFERRED" };
}
```

- [ ] **Step 3: Keep the rejection and expiration paths on the same contract**

```ts
const matchRide = new MatchRideUseCase();
const { matched } = await matchRide.execute({
  rideId: offer.rideRequestId,
  level: isWaitingReferral && isReferredDriver ? "NETWORK_L1" : undefined,
  excludedDriverIds: [offer.driverId],
});

if (!matched) {
  await prisma.rideRequest.update({
    where: { id: offer.rideRequestId, status: { in: ["PENDING", "MATCHING", "WAITING_REFERRAL"] } },
    data: { status: "EXPIRED" },
  });
}
```

- [ ] **Step 4: Run the narrow matching/offer test slice before touching bootstrap code**

Run: `npx jest tests/matching-priority-engine.spec.ts tests/matching.spec.ts tests/match-ride-region.spec.ts tests/offers.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Run the referral E2E flow to verify the current HTTP behavior still holds**

Run: `npm run test:e2e -- referral-flow.spec.ts`

Expected: PASS with Scenario 1 still creating an exclusive direct-referral offer before the fallback driver offer appears.

- [ ] **Step 6: Commit the matching use-case wiring**

```bash
git add src/application/use-cases/MatchRideUseCase.ts src/application/use-cases/RespondToRideOfferUseCase.ts src/application/use-cases/ExpireOffersService.ts tests/matching.spec.ts tests/match-ride-region.spec.ts tests/offers.spec.ts tests/e2e/referral-flow.spec.ts
git commit -m "feat: wire matching priority engine into offer flow"
```

### Task 4: Freeze Safe Bootstrap Driver Network V1 With Red Tests and Stable Seed Data

**Files:**
- Modify: `prisma/drivers-seed.json`
- Modify: `tests/bootstrap-network.spec.ts`
- Modify: `tests/driver-network-backfill.spec.ts`
- Modify: `tests/auth-register.spec.ts`

- [ ] **Step 1: Replace the seed source with stable referral-code identifiers**

```json
[
  {
    "referralCode": "pedro-paulo-motta-zn",
    "parentReferralCode": null,
    "name": "Pedro Paulo Motta",
    "email": "mottapedro01@gmail.com",
    "phone": "21981722517",
    "experienceLevel": "PROFISSIONAL",
    "regions": ["ZN"],
    "vehicle": {
      "model": "Onix Plus Turbo",
      "brand": "Chevrolet",
      "plate": "RJS1234",
      "category": "EXECUTIVO"
    }
  },
  {
    "referralCode": "joao-luiz-correa-de-brito-zn",
    "parentReferralCode": "pedro-paulo-motta-zn",
    "name": "João Luiz Correa de Brito",
    "email": "jlcbrito@driver.com",
    "phone": "11999990004",
    "experienceLevel": "PROFISSIONAL",
    "regions": ["ZN"],
    "vehicle": {
      "model": "Logan",
      "brand": "Renault",
      "plate": "UABC1234",
      "category": "CONFORTO"
    }
  }
]
```

- [ ] **Step 2: Add the bootstrap regression that proves existing live fields are preserved**

```ts
it("preserves existing live driver data and only adds missing hierarchy/region rows", async () => {
  const existingUser = await prisma.user.create({
    data: {
      name: "Pedro Real",
      email: "mottapedro01@gmail.com",
      phone: "21900009999",
      role: "DRIVER",
      passwordHash: "live-hash",
    },
  });

  const existingDriver = await prisma.driver.create({
    data: {
      userId: existingUser.id,
      isActive: true,
      experienceLevel: "ELITE",
      referralCode: "pedro-paulo-motta-zn",
      publicSlug: "pedro-real",
    },
  });

  await runBootstrapNetwork(prisma, { dryRun: false });

  const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: existingUser.id } });
  const reloadedDriver = await prisma.driver.findUniqueOrThrow({ where: { id: existingDriver.id }, include: { regions: true } });

  expect(reloadedUser.phone).toBe("21900009999");
  expect(reloadedUser.passwordHash).toBe("live-hash");
  expect(reloadedDriver.experienceLevel).toBe("ELITE");
  expect(reloadedDriver.publicSlug).toBe("pedro-real");
  expect(reloadedDriver.regions.some((region) => region.region === "ZN")).toBe(true);
});
```

- [ ] **Step 3: Extend the backfill test to prove existing referral codes are never replaced**

```ts
expect(reloaded.referralCode).toBe(originalReferralCode);
expect(reloaded.publicSlug).toBe("marcos-lima");
expect(reloaded.referredByDriverId).toBe(rootDriver.id);
expect(reloaded.networkLevel).toBe(1);
```

- [ ] **Step 4: Update the registration test to lock the new stable referral-code builder for new drivers**

```ts
expect(driver.publicSlug).toBe("marcos-lima");
expect(driver.referralCode).toBe("marcos-lima-zs");
```

- [ ] **Step 5: Run the bootstrap/runtime tests and confirm they fail before the implementation change**

Run: `npx jest tests/bootstrap-network.spec.ts tests/driver-network-backfill.spec.ts tests/auth-register.spec.ts --runInBand`

Expected: FAIL because bootstrap still updates live rows too aggressively and driver registration still writes `referralCode: publicSlug`.

- [ ] **Step 6: Commit the red bootstrap tests and seed-shape change**

```bash
git add prisma/drivers-seed.json tests/bootstrap-network.spec.ts tests/driver-network-backfill.spec.ts tests/auth-register.spec.ts
git commit -m "test: lock safe bootstrap network behavior"
```

### Task 5: Implement Safe Bootstrap, Backfill, and Stable Driver Identifier Writes

**Files:**
- Modify: `prisma/seeds/bootstrap-network.ts`
- Modify: `scripts/network/bootstrap-network.ts`
- Modify: `src/domain/services/DriverNetworkBackfillService.ts`
- Modify: `src/domain/services/ReferralCodeService.ts`
- Modify: `src/presentation/controllers/auth.controller.ts`
- Modify: `src/presentation/controllers/driver.controller.ts`
- Modify: `package.json`

- [ ] **Step 1: Make bootstrap read from `prisma/drivers-seed.json` and preserve live values by default**

```ts
const seedDrivers = driverSeedSchema.parse(JSON.parse(readFileSync(seedPath, "utf8")));

for (const seedDriver of seedDrivers) {
  const existingDriver = await prisma.driver.findFirst({
    where: { referralCode: seedDriver.referralCode },
    include: { user: true, regions: true },
  });

  const user = existingDriver?.user ?? await prisma.user.upsert({
    where: { email: seedDriver.email },
    update: {},
    create: {
      name: seedDriver.name,
      email: seedDriver.email,
      phone: seedDriver.phone,
      role: "DRIVER",
      passwordHash,
    },
  });

  const driver = existingDriver ?? await prisma.driver.create({
    data: {
      userId: user.id,
      isActive: true,
      experienceLevel: seedDriver.experienceLevel,
      publicSlug: buildDriverPublicSlug(seedDriver.name),
      referralCode: seedDriver.referralCode,
    },
  });
}
```

- [ ] **Step 2: Persist only missing regions, vehicles, and referral edges**

```ts
for (const region of seedDriver.regions) {
  await prisma.driverRegion.upsert({
    where: { driverId_region: { driverId: driver.id, region } },
    update: {},
    create: { driverId: driver.id, region },
  });
}

if (!(await prisma.vehicle.findUnique({ where: { plate: seedDriver.vehicle.plate } }))) {
  await prisma.vehicle.create({
    data: { driverId: driver.id, ...seedDriver.vehicle },
  });
}

if (seedDriver.parentReferralCode) {
  const parent = await prisma.driver.findFirst({ where: { referralCode: seedDriver.parentReferralCode } });
  if (!parent) throw new Error(`Missing parent referralCode: ${seedDriver.parentReferralCode}`);
  await createDriverReferralChain(driver.id, parent.id, prisma as never);
}
```

- [ ] **Step 3: Add dry-run mode to bootstrap before any live execution**

```ts
async function main() {
  const dryRun = !process.argv.includes("--write");
  const result = await runBootstrapNetwork(prisma, { dryRun });
  console.log(JSON.stringify({ dryRun, ...result }, null, 2));
}
```

- [ ] **Step 4: Preserve existing referral codes in backfill, but fill null `publicSlug`, `referredByDriverId`, and `networkLevel` safely**

```ts
const updateData = {
  ...(driver.publicSlug == null ? { publicSlug } : {}),
  ...(driver.referralCode == null ? { referralCode } : {}),
  ...(driver.referredByDriverId == null && referredByDriverId ? { referredByDriverId } : {}),
  ...(driver.networkLevel === 0 && networkLevel > 0 ? { networkLevel } : {}),
};
```

- [ ] **Step 5: Fix new driver write paths so future rows use the stable code builder**

```ts
const publicSlug = buildDriverPublicSlug(name);
const referralCode = buildDriverReferralCode(publicSlug, regions);

const driver = await tx.driver.create({
  data: {
    userId: user.id,
    isActive: true,
    experienceLevel: "INICIANTE",
    referredByDriverId: resolvedReferralDriverId,
    networkLevel: referrer ? referrer.networkLevel + 1 : 0,
    publicSlug,
    referralCode,
  },
});
```

- [ ] **Step 6: Keep referral-code resolution backward-compatible but exact-match first**

```ts
const stored = await prisma.driver.findFirst({
  where: { isActive: true, referralCode: normalizedCode },
  select: { id: true },
});

if (stored) {
  return stored.id;
}

// legacy fallback remains below for older distributed codes
```

- [ ] **Step 7: Run the narrow bootstrap/runtime slice immediately after the code change**

Run: `npx jest tests/bootstrap-network.spec.ts tests/driver-network-backfill.spec.ts tests/auth-register.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 8: Commit the safe bootstrap implementation**

```bash
git add prisma/seeds/bootstrap-network.ts scripts/network/bootstrap-network.ts src/domain/services/DriverNetworkBackfillService.ts src/domain/services/ReferralCodeService.ts src/presentation/controllers/auth.controller.ts src/presentation/controllers/driver.controller.ts package.json
git commit -m "feat: bootstrap driver network safely by referral code"
```

### Task 6: Update Runbooks and Perform End-to-End Validation

**Files:**
- Modify: `docs/bootstrap-network.md`
- Modify: `tests/e2e/referral-flow.spec.ts`

- [ ] **Step 1: Update the runbook to require dry-run-first bootstrap and explicit live checks**

```md
1. Deploy the code containing `MatchingPriorityEngine` and the safe bootstrap changes.
2. Run `npm run backfill:driver-network` and inspect the JSON summary.
3. Run `npm run backfill:driver-network -- --write` only after confirming the dry-run output.
4. Run `npm run bootstrap:network` and confirm the dry-run summary shows only additive changes.
5. Run `npm run bootstrap:network -- --write` to persist missing users, regions, vehicles, and referral edges.
6. Verify that no existing user fields, referral codes, or passenger rows were overwritten.
```

- [ ] **Step 2: Extend the E2E referral flow to assert the direct-referral offer is exclusive before fallback**

```ts
await test.step("1.3 — João has NO offer before Pedro rejects", async () => {
  const offers = await getDriverOffers(joaoCtx, joaoDriverId);
  const related = offers.filter((offer) => offer.rideRequestId === rideId && offer.status === "PENDING");
  expect(related).toHaveLength(0);
});
```

- [ ] **Step 3: Run the build and the focused Jest suite before any manual bootstrap command**

Run: `npm run build`

Expected: PASS.

Run: `npx jest tests/matching-priority-engine.spec.ts tests/matching.spec.ts tests/match-ride-region.spec.ts tests/offers.spec.ts tests/bootstrap-network.spec.ts tests/driver-network-backfill.spec.ts tests/auth-register.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 4: Run the dry-run operational commands and inspect the summaries**

Run: `npm run backfill:driver-network`

Expected: JSON summary with `dryRun: true` and a bounded `updatedDrivers` count.

Run: `npm run bootstrap:network`

Expected: JSON summary with `dryRun: true`, additive counts only, and no destructive actions.

- [ ] **Step 5: Commit docs and validation-only changes**

```bash
git add docs/bootstrap-network.md tests/e2e/referral-flow.spec.ts
git commit -m "docs: document safe bootstrap and matching validation"
```

## Coverage Check

- Matching priority order is covered by Tasks 1 through 3: direct referral remains exclusive, then the new engine builds referral-network, region, and global candidates in deterministic order.
- Duplicate-driver prevention is covered by Task 1 engine tests and Task 3 integration wiring.
- Offer preparation and current offer flow preservation are covered by Task 3 and the E2E referral-flow validation.
- Structured logs are introduced in Task 2 and exercised in Task 3.
- Safe bootstrap keyed by `referralCode`, non-destructive hierarchy persistence, and live-data preservation are covered by Tasks 4 through 6.

Plan complete and saved to `docs/superpowers/plans/2026-05-12-matching-priority-engine-bootstrap-driver-network.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using the `executing-plans` agent, batch execution with checkpoints

**Which approach?**