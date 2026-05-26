/**
 * Backfill script: generates referralCode + publicSlug for every Passenger
 * that currently has either field NULL.
 *
 * Safe rules:
 *  - Only touches rows WHERE referralCode IS NULL OR publicSlug IS NULL
 *  - Never deletes or truncates
 *  - Idempotent: re-running is safe (assignPassengerIdentity skips already-set rows)
 *
 * Run:
 *   npx ts-node --project tsconfig.json scripts/passenger/backfill-passenger-identity.ts
 */

import { prisma } from "../../src/infra/prisma/client";
import { assignPassengerIdentity } from "../../src/domain/services/PassengerReferralService";

async function backfill() {
  const passengers = await prisma.passenger.findMany({
    where: {
      OR: [{ referralCode: null }, { publicSlug: null }],
    },
    include: { user: { select: { name: true } } },
  });

  console.log(`\n🔍 Found ${passengers.length} passengers without identity codes.\n`);

  if (passengers.length === 0) {
    console.log("✅ Nothing to backfill.");
    return;
  }

  let success = 0;
  let failed = 0;

  for (const p of passengers) {
    try {
      const { referralCode, publicSlug } = await assignPassengerIdentity(
        p.id,
        p.user.name
      );
      console.log(`  ✓ ${p.id}  →  slug: ${publicSlug}  |  code: ${referralCode}`);
      success++;
    } catch (err) {
      console.error(`  ✗ ${p.id}  →  ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log(`\n📊 Backfill complete: ${success} updated, ${failed} failed.\n`);
}

backfill()
  .catch((err) => {
    console.error("Fatal error during backfill:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
