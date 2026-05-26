# Safe Driver Network Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` agent (recommended) or `executing-plans` agent to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely evolve the live Prisma schema and seed/bootstrap flow so drivers have persisted referral metadata, referral hierarchy remains intact, and bootstrap/backfill scripts are idempotent and non-destructive.

**Architecture:** Keep the existing `DriverRegion` join table as the safe equivalent of `regions: String[]` instead of rewriting live data to a PostgreSQL array column. Roll out the driver metadata in two phases: first add nullable/additive columns and backfill them without touching existing users or links, then add uniqueness constraints only after the data is verified clean. Keep seed/bootstrap logic out of `prisma/seed.ts` for live environments by moving reusable logic into dedicated seed modules and thin CLI entrypoints.

**Tech Stack:** TypeScript, Prisma 7, PostgreSQL, Jest, ts-node

---

## File Map

**Database and Prisma**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260512153000_add_driver_network_columns/migration.sql`
- Create: `prisma/migrations/20260512170000_add_driver_identifier_uniques/migration.sql`

**Runtime services**
- Create: `src/domain/services/DriverIdentityService.ts`
- Create: `src/domain/services/DriverNetworkBackfillService.ts`
- Modify: `src/domain/services/DriverReferralService.ts`
- Modify: `src/domain/services/ReferralCodeService.ts`

**HTTP write path**
- Modify: `src/presentation/controllers/auth.controller.ts`
- Modify: `src/presentation/controllers/driver.controller.ts`

**Bootstrap and seeds**
- Create: `scripts/network/backfill-driver-network.ts`
- Create: `scripts/network/bootstrap-network.ts`
- Create: `prisma/seeds/base-seed.ts`
- Create: `prisma/seeds/bootstrap-network.ts`
- Create: `prisma/seeds/dev-fixtures.ts`
- Modify: `prisma/seed.ts`
- Modify: `package.json`

**Tests**
- Create: `tests/driver-identity.spec.ts`
- Create: `tests/driver-network-backfill.spec.ts`
- Create: `tests/bootstrap-network.spec.ts`
- Modify: `tests/driver-referral.spec.ts`
- Modify: `tests/auth-register.spec.ts`
- Modify: `tests/e2e/referral-flow.spec.ts`

**Docs**
- Create: `docs/bootstrap-network.md`

## Design Notes

- Do **not** replace `Driver.regions` with a PostgreSQL `String[]` column in this repo. The existing `DriverRegion[]` relation is the safe equivalent and already matches the codebase.
- Do **not** drop or recreate `DriverReferral`. The table already exists and already stores the hierarchy. If the code should expose `driverId` instead of `referrerDriverId`, use Prisma `@map("referrerDriverId")` first so the API can change without rewriting production data.
- Do **not** overwrite existing `referralCode`, `publicSlug`, `referredByDriverId`, `networkLevel`, passengers, or passwords during bootstrap/backfill. Only fill missing data.
- Do **not** add the unique constraints on `Driver.referralCode` and `Driver.publicSlug` until after the backfill has completed and collisions are handled.

### Task 1: Freeze Behavior With Focused Tests

**Files:**
- Create: `tests/driver-identity.spec.ts`
- Create: `tests/driver-network-backfill.spec.ts`
- Create: `tests/bootstrap-network.spec.ts`
- Modify: `tests/auth-register.spec.ts`
- Modify: `tests/driver-referral.spec.ts`

- [ ] **Step 1: Write the failing slug/referral identity tests**

```ts
import { Region } from "@prisma/client";
import {
  buildDriverPublicSlug,
  buildDriverReferralCode,
} from "../src/domain/services/DriverIdentityService";

describe("DriverIdentityService", () => {
  it("builds a stable public slug from the driver name", () => {
    expect(buildDriverPublicSlug("João Luiz Correa de Brito")).toBe("joao-luiz-correa-de-brito");
  });

  it("builds a stable referral code using slug plus primary region", () => {
    expect(buildDriverReferralCode("joao-luiz-correa-de-brito", [Region.ZN])).toBe(
      "joao-luiz-correa-de-brito-zn"
    );
  });
});
```

- [ ] **Step 2: Run the new identity test and confirm it fails before implementation**

Run: `npx jest tests/driver-identity.spec.ts --runInBand`

Expected: FAIL with `Cannot find module '../src/domain/services/DriverIdentityService'` or missing exports.

- [ ] **Step 3: Write the failing backfill test for null-only updates**

```ts
import bcrypt from "bcrypt";
import { prisma } from "./setup";
import { backfillDriverNetworkFields } from "../src/domain/services/DriverNetworkBackfillService";

describe("backfillDriverNetworkFields", () => {
  it("fills only missing driver metadata and preserves existing values", async () => {
    const passwordHash = await bcrypt.hash("123456", 10);

    const rootUser = await prisma.user.create({
      data: { name: "Carlos Silva", email: "carlos@backfill.test", phone: "21900000001", role: "DRIVER", passwordHash },
    });
    const rootDriver = await prisma.driver.create({
      data: { userId: rootUser.id, isActive: true, experienceLevel: "PROFISSIONAL", publicSlug: "carlos-silva" },
    });
    await prisma.driverRegion.create({ data: { driverId: rootDriver.id, region: "ZN" } });

    const childUser = await prisma.user.create({
      data: { name: "Marcos Lima", email: "marcos@backfill.test", phone: "21900000002", role: "DRIVER", passwordHash },
    });
    const childDriver = await prisma.driver.create({
      data: { userId: childUser.id, isActive: true, experienceLevel: "INTERMEDIARIO", networkLevel: 0 },
    });
    await prisma.driverRegion.create({ data: { driverId: childDriver.id, region: "ZS" } });
    await prisma.driverReferral.create({
      data: { driverId: rootDriver.id, referredDriverId: childDriver.id, level: 1 },
    });

    const result = await backfillDriverNetworkFields(prisma, { dryRun: false });

    const reloaded = await prisma.driver.findUniqueOrThrow({ where: { id: childDriver.id } });
    expect(result.updatedDrivers).toBe(1);
    expect(reloaded.referredByDriverId).toBe(rootDriver.id);
    expect(reloaded.networkLevel).toBe(1);
    expect(reloaded.publicSlug).toBe("marcos-lima");
    expect(reloaded.referralCode).toBe("marcos-lima-zs");
  });
});
```

- [ ] **Step 4: Run the backfill test and confirm it fails on missing schema/service support**

Run: `npx jest tests/driver-network-backfill.spec.ts --runInBand`

Expected: FAIL because the new driver fields and service do not exist yet.

- [ ] **Step 5: Extend the registration test to lock the new driver write-path behavior**

```ts
it("creates a referred driver with direct parent, network level, slug, and referral code", async () => {
  const referrer = await createDriverWithRegion({
    name: "Carlos Silva",
    email: "carlos.driver@ref.com",
    region: Region.ZN,
  });

  const response = await request(app)
    .post("/auth/register")
    .send({
      name: "Marcos Lima",
      email: "marcos.driver@ref.com",
      password: "123456",
      role: "driver",
      phone: "21988887777",
      referralCode: "carlos-silva-zn",
    });

  expect(response.status).toBe(201);

  const driver = await prisma.driver.findUniqueOrThrow({ where: { id: response.body.driverId } });
  expect(driver.referredByDriverId).toBe(referrer.id);
  expect(driver.networkLevel).toBe(1);
  expect(driver.publicSlug).toBe("marcos-lima");
  expect(driver.referralCode).toBe("marcos-lima");
});
```

- [ ] **Step 6: Run the targeted registration/referral tests and confirm they fail before the implementation**

Run: `npx jest tests/auth-register.spec.ts tests/driver-referral.spec.ts --runInBand`

Expected: FAIL on missing fields or old `referrerDriverId` usages.

- [ ] **Step 7: Commit the red tests**

```bash
git add tests/driver-identity.spec.ts tests/driver-network-backfill.spec.ts tests/bootstrap-network.spec.ts tests/auth-register.spec.ts tests/driver-referral.spec.ts
git commit -m "test: lock safe driver network migration behavior"
```

### Task 2: Add the Additive Schema Migration First

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260512153000_add_driver_network_columns/migration.sql`

- [ ] **Step 1: Update the Prisma schema with additive driver fields and a mapped referral API**

```prisma
model Driver {
  id                 String   @id @default(uuid())
  userId             String   @unique
  experienceLevel    ExperienceLevel
  isActive           Boolean  @default(true)
  networkLevel       Int      @default(0)
  referredByDriverId String?
  referralCode       String?
  publicSlug         String?
  createdAt          DateTime @default(now())

  user User @relation(fields: [userId], references: [id])

  referredByDriver Driver?  @relation("DriverDirectReferral", fields: [referredByDriverId], references: [id])
  referredDrivers  Driver[] @relation("DriverDirectReferral")

  regions DriverRegion[]

  referralsMade     DriverReferral[] @relation("Referrer")
  referralsReceived DriverReferral[] @relation("Referred")
}

model DriverReferral {
  id               String   @id @default(uuid())
  driverId         String   @map("referrerDriverId")
  referredDriverId String
  level            Int
  createdAt        DateTime @default(now())

  driver   Driver @relation("Referrer", fields: [driverId], references: [id])
  referred Driver @relation("Referred", fields: [referredDriverId], references: [id])

  @@unique([driverId, referredDriverId], map: "DriverReferral_referrerDriverId_referredDriverId_key")
  @@index([referredDriverId])
}
```

- [ ] **Step 2: Write the first migration as additive SQL only**

```sql
ALTER TABLE "Driver"
  ADD COLUMN "networkLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "referredByDriverId" TEXT,
  ADD COLUMN "referralCode" TEXT,
  ADD COLUMN "publicSlug" TEXT;

ALTER TABLE "Driver"
  ADD CONSTRAINT "Driver_referredByDriverId_fkey"
  FOREIGN KEY ("referredByDriverId") REFERENCES "Driver"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Driver_referredByDriverId_idx" ON "Driver"("referredByDriverId");
CREATE INDEX "Driver_networkLevel_idx" ON "Driver"("networkLevel");
```

- [ ] **Step 3: Generate the client and verify the schema compiles before any backfill logic is written**

Run: `npx prisma generate`

Expected: PASS with a regenerated Prisma client.

- [ ] **Step 4: Apply the migration locally and verify the database shape**

Run: `npx prisma migrate dev --name add_driver_network_columns`

Expected: PASS with a new migration folder and updated local database.

- [ ] **Step 5: Commit the additive migration**

```bash
git add prisma/schema.prisma prisma/migrations/20260512153000_add_driver_network_columns/migration.sql
git commit -m "feat: add additive driver network columns"
```

### Task 3: Implement Deterministic Identity and Incremental Backfill

**Files:**
- Create: `src/domain/services/DriverIdentityService.ts`
- Create: `src/domain/services/DriverNetworkBackfillService.ts`
- Create: `scripts/network/backfill-driver-network.ts`
- Modify: `tests/driver-identity.spec.ts`
- Modify: `tests/driver-network-backfill.spec.ts`

- [ ] **Step 1: Implement deterministic slug and referral code helpers**

```ts
import { Region } from "@prisma/client";

const REGION_SUFFIX: Record<Region, string> = {
  ZN: "zn",
  ZS: "zs",
  ZO: "zo",
  BAIXADA: "baixada",
  INTER: "inter",
  CENTRO: "centro",
  NITEROI: "niteroi",
  SAO_GONCALO: "sao-goncalo",
  REGIAO_DOS_LAGOS: "regiao-dos-lagos",
};

export function buildDriverPublicSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildDriverReferralCode(publicSlug: string, regions: Region[]): string {
  const primaryRegion = regions[0];
  return primaryRegion ? `${publicSlug}-${REGION_SUFFIX[primaryRegion]}` : publicSlug;
}
```

- [ ] **Step 2: Implement the backfill service to update only missing fields**

```ts
import { PrismaClient } from "@prisma/client";
import { buildDriverPublicSlug, buildDriverReferralCode } from "./DriverIdentityService";

export async function backfillDriverNetworkFields(prisma: PrismaClient, options: { dryRun: boolean }) {
  const drivers = await prisma.driver.findMany({
    include: {
      user: { select: { name: true } },
      regions: { select: { region: true }, orderBy: { region: "asc" } },
      referralsReceived: { where: { level: 1 }, select: { driverId: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const parentByDriverId = new Map<string, string | null>();
  for (const driver of drivers) {
    const directParents = driver.referralsReceived.map((edge) => edge.driverId);
    if (directParents.length > 1) {
      throw new Error(`Driver ${driver.id} has multiple direct referrers`);
    }
    parentByDriverId.set(driver.id, driver.referredByDriverId ?? directParents[0] ?? null);
  }

  const depthMemo = new Map<string, number>();
  const getNetworkLevel = (driverId: string): number => {
    if (depthMemo.has(driverId)) return depthMemo.get(driverId)!;

    const parentId = parentByDriverId.get(driverId) ?? null;
    if (!parentId) {
      depthMemo.set(driverId, 0);
      return 0;
    }

    const level = getNetworkLevel(parentId) + 1;
    depthMemo.set(driverId, level);
    return level;
  };

  let updatedDrivers = 0;

  for (const driver of drivers) {
    const publicSlug = driver.publicSlug ?? buildDriverPublicSlug(driver.user.name);
    const referralCode = driver.referralCode ?? buildDriverReferralCode(publicSlug, driver.regions.map((r) => r.region));
    const referredByDriverId = parentByDriverId.get(driver.id) ?? null;
    const networkLevel = getNetworkLevel(driver.id);

    const shouldUpdate =
      driver.publicSlug == null ||
      driver.referralCode == null ||
      driver.referredByDriverId == null ||
      driver.networkLevel === 0;

    if (!shouldUpdate) continue;
    updatedDrivers += 1;

    if (!options.dryRun) {
      await prisma.driver.update({
        where: { id: driver.id },
        data: {
          ...(driver.publicSlug == null ? { publicSlug } : {}),
          ...(driver.referralCode == null ? { referralCode } : {}),
          ...(driver.referredByDriverId == null && referredByDriverId ? { referredByDriverId } : {}),
          ...(driver.networkLevel === 0 && networkLevel > 0 ? { networkLevel } : {}),
        },
      });
    }
  }

  return { updatedDrivers };
}
```

- [ ] **Step 3: Add a CLI wrapper with `--dry-run` as the default safety check**

```ts
import "dotenv/config";
import { prisma } from "../../src/infra/prisma/client";
import { backfillDriverNetworkFields } from "../../src/domain/services/DriverNetworkBackfillService";

async function main() {
  const dryRun = !process.argv.includes("--write");
  const result = await backfillDriverNetworkFields(prisma, { dryRun });
  console.log(JSON.stringify({ dryRun, ...result }, null, 2));
}

main()
  .catch((error) => {
    console.error("Backfill failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

- [ ] **Step 4: Run the focused tests and a dry-run backfill**

Run: `npx jest tests/driver-identity.spec.ts tests/driver-network-backfill.spec.ts --runInBand`

Expected: PASS

Run: `npx ts-node -r tsconfig-paths/register scripts/network/backfill-driver-network.ts`

Expected: PASS with JSON output and `dryRun: true`, without modifying records.

- [ ] **Step 5: Commit the backfill implementation**

```bash
git add src/domain/services/DriverIdentityService.ts src/domain/services/DriverNetworkBackfillService.ts scripts/network/backfill-driver-network.ts tests/driver-identity.spec.ts tests/driver-network-backfill.spec.ts
git commit -m "feat: add deterministic driver identity backfill"
```

### Task 4: Update Runtime Registration and Referral Resolution

**Files:**
- Modify: `src/presentation/controllers/auth.controller.ts`
- Modify: `src/domain/services/DriverReferralService.ts`
- Modify: `src/domain/services/ReferralCodeService.ts`
- Modify: `tests/auth-register.spec.ts`
- Modify: `tests/driver-referral.spec.ts`
- Modify: `tests/e2e/referral-flow.spec.ts`

- [ ] **Step 1: Change referral code resolution to prefer the stored field and only fall back during rollout**

```ts
export async function resolveReferralCodeToDriverId(referralCode: string): Promise<string | null> {
  const normalizedCode = normalizeSlugPart(referralCode);
  if (!normalizedCode) return null;

  const stored = await prisma.driver.findFirst({
    where: { isActive: true, referralCode: normalizedCode },
    select: { id: true },
  });

  if (stored) return stored.id;

  // Temporary rollout fallback for pre-backfill drivers.
  const { baseCode, region } = parseReferralCode(normalizedCode);
  const drivers = await prisma.driver.findMany({
    where: { isActive: true },
    include: {
      user: { select: { name: true } },
      regions: { select: { region: true } },
    },
  });

  const match = drivers.find((driver) => {
    const variants = buildDriverNameVariants(driver.user.name);
    if (!variants.has(baseCode)) return false;
    return region ? driver.regions.some((entry) => entry.region === region) : true;
  });

  return match?.id ?? null;
}
```

- [ ] **Step 2: Create drivers in a transaction and persist the new direct-parent metadata on registration**

```ts
const result = await prisma.$transaction(async (tx) => {
  const user = await tx.user.create({
    data: { name, email, phone, role: prismaRole, passwordHash },
  });

  const publicSlug = buildDriverPublicSlug(name);
  const referralCodeValue = publicSlug;

  const driver = await tx.driver.create({
    data: {
      userId: user.id,
      isActive: true,
      experienceLevel: "INICIANTE",
      referredByDriverId: resolvedReferralDriverId,
      networkLevel: resolvedReferralDriverId ? 1 : 0,
      publicSlug,
      referralCode: referralCodeValue,
    },
  });

  if (resolvedReferralDriverId) {
    await createDriverReferralChain(driver.id, resolvedReferralDriverId, tx);
  }

  return { user, driver };
});
```

- [ ] **Step 3: Make the referral hierarchy writer idempotent with upsert instead of `create` plus duplicate handling**

```ts
await prisma.driverReferral.upsert({
  where: {
    driverId_referredDriverId: {
      driverId: edge.driverId,
      referredDriverId: edge.referredDriverId,
    },
  },
  update: { level: edge.level },
  create: edge,
});
```

- [ ] **Step 4: Run the targeted runtime tests**

Run: `npx jest tests/auth-register.spec.ts tests/driver-referral.spec.ts tests/e2e/referral-flow.spec.ts --runInBand`

Expected: PASS

- [ ] **Step 5: Commit the runtime write-path changes**

```bash
git add src/presentation/controllers/auth.controller.ts src/domain/services/DriverReferralService.ts src/domain/services/ReferralCodeService.ts tests/auth-register.spec.ts tests/driver-referral.spec.ts tests/e2e/referral-flow.spec.ts
git commit -m "feat: persist direct driver referral metadata"
```

### Task 5: Split Seeds and Add a Non-Destructive Network Bootstrap CLI

**Files:**
- Create: `prisma/seeds/base-seed.ts`
- Create: `prisma/seeds/bootstrap-network.ts`
- Create: `prisma/seeds/dev-fixtures.ts`
- Create: `scripts/network/bootstrap-network.ts`
- Modify: `prisma/seed.ts`
- Modify: `package.json`
- Create: `tests/bootstrap-network.spec.ts`

- [ ] **Step 1: Move shared base records into a dedicated base seed with upsert-only writes**

```ts
export async function runBaseSeed(prisma: PrismaClient) {
  const user = await prisma.user.upsert({
    where: { email: "ana.beatriz@mobility.com" },
    update: {},
    create: {
      name: "Ana Beatriz Santos",
      email: "ana.beatriz@mobility.com",
      phone: "21999990009",
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("123456", 10),
    },
  });

  await prisma.passenger.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id },
  });
}
```

- [ ] **Step 2: Add a reusable bootstrap module that never deletes and always upserts by stable keys**

```ts
export async function runBootstrapNetwork(prisma: PrismaClient) {
  for (const seedDriver of driversData) {
    const user = await prisma.user.upsert({
      where: { email: seedDriver.email },
      update: {},
      create: {
        name: seedDriver.name,
        email: seedDriver.email,
        phone: seedDriver.phone,
        role: "DRIVER",
        passwordHash: seedDriver.passwordHash,
      },
    });

    const driver = await prisma.driver.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        isActive: true,
        experienceLevel: seedDriver.experienceLevel,
        referredByDriverId: seedDriver.referredByDriverId ?? null,
        networkLevel: seedDriver.referredByDriverId ? 1 : 0,
        publicSlug: seedDriver.publicSlug,
        referralCode: seedDriver.referralCode,
      },
    });

    await prisma.driverRegion.upsert({
      where: { driverId_region: { driverId: driver.id, region: seedDriver.region } },
      update: {},
      create: { driverId: driver.id, region: seedDriver.region },
    });

    await prisma.vehicle.upsert({
      where: { plate: seedDriver.vehicle.plate },
      update: {},
      create: { driverId: driver.id, ...seedDriver.vehicle },
    });

    if (seedDriver.referredByDriverId) {
      await createDriverReferralChain(driver.id, seedDriver.referredByDriverId, prisma);
    }
  }
}
```

- [ ] **Step 3: Add the live CLI entrypoint and keep `prisma/seed.ts` development-only**

```ts
// scripts/network/bootstrap-network.ts
import "dotenv/config";
import { prisma } from "../../src/infra/prisma/client";
import { runBootstrapNetwork } from "../../prisma/seeds/bootstrap-network";

runBootstrapNetwork(prisma)
  .catch((error) => {
    console.error("Bootstrap network failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

```ts
// prisma/seed.ts
import "dotenv/config";
import { runDevFixtures } from "./seeds/dev-fixtures";

if (process.env.NODE_ENV === "production") {
  throw new Error("Use scripts/network/bootstrap-network.ts and scripts/network/backfill-driver-network.ts in live environments.");
}

runDevFixtures();
```

- [ ] **Step 4: Update package scripts so the safe entrypoints are obvious**

```json
{
  "scripts": {
    "seed": "ts-node -r tsconfig-paths/register prisma/seed.ts",
    "seed:base": "ts-node -r tsconfig-paths/register prisma/seeds/base-seed.ts",
    "seed:dev": "ts-node -r tsconfig-paths/register prisma/seeds/dev-fixtures.ts",
    "bootstrap:network": "ts-node -r tsconfig-paths/register scripts/network/bootstrap-network.ts",
    "backfill:driver-network": "ts-node -r tsconfig-paths/register scripts/network/backfill-driver-network.ts"
  }
}
```

- [ ] **Step 5: Prove bootstrap idempotency with a focused test and two consecutive local runs**

```ts
it("does not create duplicate users, drivers, regions, vehicles, or referral edges when run twice", async () => {
  await runBootstrapNetwork(prisma);
  await runBootstrapNetwork(prisma);

  expect(await prisma.user.count({ where: { role: "DRIVER" } })).toBe(5);
  expect(await prisma.driverReferral.count()).toBe(3);
  expect(await prisma.vehicle.count()).toBe(5);
});
```

Run: `npx jest tests/bootstrap-network.spec.ts --runInBand`

Expected: PASS

Run: `npx ts-node -r tsconfig-paths/register scripts/network/bootstrap-network.ts`

Expected: PASS without deletes, truncates, or duplicate-key failures.

- [ ] **Step 6: Commit the seed/bootstrap split**

```bash
git add prisma/seeds/base-seed.ts prisma/seeds/bootstrap-network.ts prisma/seeds/dev-fixtures.ts scripts/network/bootstrap-network.ts prisma/seed.ts package.json tests/bootstrap-network.spec.ts
git commit -m "feat: split seeds and add non-destructive network bootstrap"
```

### Task 6: Add Unique Constraints After Backfill Validation

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260512170000_add_driver_identifier_uniques/migration.sql`
- Create: `docs/bootstrap-network.md`

- [ ] **Step 1: Add unique markers to the Prisma schema only after the backfill is clean**

```prisma
model Driver {
  referralCode String? @unique
  publicSlug   String? @unique
}
```

- [ ] **Step 2: Write the second migration that adds the unique indexes**

```sql
CREATE UNIQUE INDEX "Driver_referralCode_key" ON "Driver"("referralCode");
CREATE UNIQUE INDEX "Driver_publicSlug_key" ON "Driver"("publicSlug");
```

- [ ] **Step 3: Document the rollout order and the commands operators should actually use**

```md
# Driver Network Bootstrap Runbook

1. Deploy code containing the additive migration and null-tolerant runtime logic.
2. Run `npx prisma migrate deploy`.
3. Run `npm run backfill:driver-network` first without `--write` and inspect the JSON summary.
4. Run `npm run backfill:driver-network -- --write` once the dry-run is clean.
5. Run `npm run bootstrap:network` to add the canonical network records without touching existing users.
6. Verify there are no duplicate non-null `referralCode` or `publicSlug` values.
7. Deploy the unique-index migration with `npx prisma migrate deploy`.
```

- [ ] **Step 4: Run the final validation suite**

Run: `npx prisma generate`

Expected: PASS

Run: `npx jest tests/driver-identity.spec.ts tests/driver-network-backfill.spec.ts tests/bootstrap-network.spec.ts tests/driver-referral.spec.ts tests/auth-register.spec.ts --runInBand`

Expected: PASS

Run: `npm run build`

Expected: PASS

- [ ] **Step 5: Commit the rollout docs and uniqueness migration**

```bash
git add prisma/schema.prisma prisma/migrations/20260512170000_add_driver_identifier_uniques/migration.sql docs/bootstrap-network.md
git commit -m "docs: add safe rollout for driver network bootstrap"
```

## Critical Concerns

- If any driver currently has more than one level-1 incoming `DriverReferral` edge, stop the rollout and resolve that data manually before writing `referredByDriverId`.
- `networkLevel` must be derived from the direct-parent chain, not from arbitrary `DriverReferral.level` rows. Treat `level = 1` incoming edges as the source of truth for direct parentage.
- `referralCode` and `publicSlug` collisions are the main live-data risk. The backfill must report collisions explicitly and skip those rows instead of guessing silently.
- Keep the current `DriverRegion` table. Converting to `String[]` in PostgreSQL would create a broader migration surface with no benefit for this repo.
- Remove the current `prisma/seed.ts` behavior that force-resets password hashes for existing users. That is acceptable for dev fixtures, but unsafe for live environments.
- Do not use `deleteMany`, `TRUNCATE`, `db push --force-reset`, or a fresh seed to achieve this rollout. The bootstrap and backfill scripts must be repeatable on top of real production data.

## Release Order

1. Ship Task 2 and Task 4 together so runtime code tolerates null legacy fields.
2. Run Task 3 backfill in dry-run mode, then write mode.
3. Run Task 5 bootstrap to add any canonical missing network records.
4. Verify uniqueness manually with SQL or Prisma queries.
5. Ship Task 6 unique indexes only after the verification passes.