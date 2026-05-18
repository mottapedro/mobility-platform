/**
 * Passenger Network Backfill
 *
 * Incrementally bootstraps relational identity for every Passenger that was
 * created before the passenger-network feature was live.
 *
 * What it does (never overwrites existing values):
 *   1. Assigns referralCode + publicSlug for passengers with either field NULL
 *      (delegates to assignPassengerIdentity — idempotent).
 *   2. Sets rootPassengerId = passenger.id for every root passenger
 *      (referredByPassengerId IS NULL AND rootPassengerId IS NULL).
 *      This is required so that createPassengerReferral can build the correct
 *      lineage for new passengers who use this passenger's referral code.
 *
 * Safe rules:
 *   - Never deletes or truncates.
 *   - Skips any field that is already set.
 *   - Idempotent: re-running produces zero changes the second time.
 *
 * Dry-run mode (default):
 *   Pass --write to persist changes.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/passenger/backfill-passenger-network.ts
 *   npx ts-node -r tsconfig-paths/register scripts/passenger/backfill-passenger-network.ts --write
 */

import { prisma } from "../../src/infra/prisma/client";
import { assignPassengerIdentity } from "../../src/domain/services/PassengerReferralService";

const dryRun = !process.argv.includes("--write");

if (dryRun) {
  console.log("[DRY-RUN] Pass --write to persist changes.\n");
}

async function backfill() {
  // ── Step 1: identity (referralCode + publicSlug) ────────────────────────────

  const needsIdentity = await prisma.passenger.findMany({
    where: { OR: [{ referralCode: null }, { publicSlug: null }] },
    include: { user: { select: { name: true } } },
  });

  console.log(`📋 Passengers needing identity: ${needsIdentity.length}`);

  let identityUpdated = 0;
  let identitySkipped = 0;
  let identityFailed = 0;

  for (const p of needsIdentity) {
    if (dryRun) {
      console.log(`  [DRY-RUN] Would assign identity to: ${p.id} (${p.user.name})`);
      identityUpdated++;
      continue;
    }
    try {
      const { referralCode, publicSlug } = await assignPassengerIdentity(
        p.id,
        p.user.name
      );
      console.log(`  ✓ identity  ${p.id}  →  slug: ${publicSlug}  code: ${referralCode}`);
      identityUpdated++;
    } catch (err) {
      console.error(`  ✗ identity  ${p.id}  →  ${err instanceof Error ? err.message : err}`);
      identityFailed++;
    }
  }

  // ── Step 2: rootPassengerId self-reference for root passengers ──────────────
  //
  // A "root passenger" has no referredByPassengerId (not referred by anyone).
  // Their rootPassengerId should point to themselves so that when they later
  // share their code and createPassengerReferral runs, the chain is seeded.

  const needsRoot = await prisma.passenger.findMany({
    where: { referredByPassengerId: null, rootPassengerId: null },
    select: { id: true },
  });

  console.log(`\n📋 Root passengers needing rootPassengerId: ${needsRoot.length}`);

  let rootUpdated = 0;
  let rootFailed = 0;

  for (const p of needsRoot) {
    if (dryRun) {
      console.log(`  [DRY-RUN] Would set rootPassengerId = self for: ${p.id}`);
      rootUpdated++;
      continue;
    }
    try {
      await prisma.passenger.update({
        where: { id: p.id },
        data: { rootPassengerId: p.id },
      });
      console.log(`  ✓ root      ${p.id}  →  rootPassengerId = ${p.id}`);
      rootUpdated++;
    } catch (err) {
      console.error(`  ✗ root      ${p.id}  →  ${err instanceof Error ? err.message : err}`);
      rootFailed++;
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  const summary = {
    dryRun,
    identityUpdated,
    identitySkipped,
    identityFailed,
    rootUpdated,
    rootFailed,
  };

  console.log("\n" + JSON.stringify(summary, null, 2));
}

backfill()
  .catch((err) => {
    console.error("Fatal error during passenger network backfill:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
