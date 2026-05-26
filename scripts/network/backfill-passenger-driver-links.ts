/**
 * Backfill: Passenger → Driver referral linkage
 *
 * For every Passenger with referredByDriverId = NULL, sets the field to the
 * driver resolved from --driver-referral-code=<code> or --driver-id=<uuid>.
 *
 * Why a mandatory driver argument is required:
 *   The unlinked passengers were created before the referral-linkage feature
 *   was active. No record of which driver referred them was stored at the time,
 *   so the operator must supply the intended driver explicitly.
 *
 * Safe rules:
 *   - Skips passengers that already have referredByDriverId set.
 *   - Never deletes or overwrites existing data.
 *   - Idempotent: re-running after a successful --write is a no-op.
 *   - Dry-run by default. Pass --write to persist.
 *
 * Usage:
 *   # Dry-run (default):
 *   npx ts-node -r tsconfig-paths/register scripts/network/backfill-passenger-driver-links.ts \
 *     --driver-referral-code=pedro-paulo-motta-zn
 *
 *   # Live write:
 *   npx ts-node -r tsconfig-paths/register scripts/network/backfill-passenger-driver-links.ts \
 *     --driver-referral-code=pedro-paulo-motta-zn --write
 *
 *   # Using driver UUID directly:
 *   npx ts-node -r tsconfig-paths/register scripts/network/backfill-passenger-driver-links.ts \
 *     --driver-id=<uuid> --write
 */

import { prisma } from "../../src/infra/prisma/client";
import { resolveReferralCodeToDriverId } from "../../src/domain/services/ReferralCodeService";

// ── CLI arg parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = !args.includes("--write");

function getArg(prefix: string): string | null {
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const driverReferralCodeArg = getArg("--driver-referral-code=");
const driverIdArg = getArg("--driver-id=");

if (!driverReferralCodeArg && !driverIdArg) {
  console.error(
    "Error: supply --driver-referral-code=<code> or --driver-id=<uuid>\n" +
      "Example:\n" +
      "  npx ts-node -r tsconfig-paths/register scripts/network/backfill-passenger-driver-links.ts \\\n" +
      "    --driver-referral-code=pedro-paulo-motta-zn"
  );
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (dryRun) console.log("[DRY-RUN] Pass --write to persist changes.\n");

  // Resolve target driver ID
  let driverId: string | null = driverIdArg ?? null;

  if (!driverId && driverReferralCodeArg) {
    driverId = await resolveReferralCodeToDriverId(driverReferralCodeArg);
    if (!driverId) {
      console.error(`Error: no active driver found for referral code "${driverReferralCodeArg}"`);
      process.exit(1);
    }
  }

  const driver = await prisma.driver.findUnique({
    where: { id: driverId! },
    include: { user: { select: { name: true } } },
  });

  if (!driver || !driver.isActive) {
    console.error(`Error: driver ${driverId} not found or inactive`);
    process.exit(1);
  }

  console.log(`🎯 Target driver: ${driver.user.name} (${driver.id})\n`);

  // Test-domain suffixes used by the test suite — these are never real users.
  // See tests/setup.ts cleanTestData() for the canonical list.
  const TEST_EMAIL_DOMAINS = [
    "@test.com",
    "@ref.com",
    "@backfill.test",
    "@auth.com",
    "@matching.com",
    "@partner.com",
    "@vip.com",
    "@ptest.com",
  ];

  // Find all passengers with no driver link (real users only)
  const allUnlinked = await prisma.passenger.findMany({
    where: { referredByDriverId: null },
    include: { user: { select: { name: true, email: true } } },
  });

  const unlinked = allUnlinked.filter(
    (p) => !TEST_EMAIL_DOMAINS.some((domain) => p.user.email.endsWith(domain))
  );

  const skippedTestUsers = allUnlinked.length - unlinked.length;
  if (skippedTestUsers > 0) {
    console.log(`   (skipped ${skippedTestUsers} test-email passenger(s) — not real users)`);
  }

  console.log(`📋 Passengers with referredByDriverId = NULL: ${unlinked.length}`);

  if (unlinked.length === 0) {
    console.log("✅ Nothing to backfill.");
    console.log(JSON.stringify({ dryRun, updated: 0, skipped: 0, failed: 0 }, null, 2));
    return;
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const failedIds: string[] = [];

  for (const passenger of unlinked) {
    const label = `${passenger.id} (${passenger.user.name} <${passenger.user.email}>)`;

    if (dryRun) {
      console.log(`  [DRY-RUN] Would link: ${label} → driverId ${driverId}`);
      updated++;
      continue;
    }

    try {
      await prisma.passenger.update({
        where: { id: passenger.id },
        data: { referredByDriverId: driverId },
      });
      console.log(`  ✓ linked   ${label} → ${driverId}`);
      updated++;
    } catch (err) {
      console.error(`  ✗ failed   ${label} → ${err instanceof Error ? err.message : err}`);
      failed++;
      failedIds.push(passenger.id);
    }
  }

  const summary = {
    dryRun,
    driverLinked: driver.user.name,
    updated,
    skipped,
    skippedTestUsers,
    failed,
    ...(failedIds.length > 0 ? { failedIds } : {}),
  };

  console.log("\n" + JSON.stringify(summary, null, 2));
}

main()
  .catch((err) => {
    console.error("Fatal error during passenger-driver-links backfill:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
