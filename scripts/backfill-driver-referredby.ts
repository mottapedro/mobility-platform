/**
 * backfill-driver-referredby.ts
 *
 * Fixes the gap where DriverReferral closure was populated during seeding but
 * Driver.referredByDriverId was never written.
 *
 * What this script does (all idempotent):
 *
 *  Step 1 – Set Driver.referredByDriverId for every direct DriverReferral
 *            (isDirect=true). Direct = the ACTUAL parent in the tree.
 *            Skips rows where referredByDriverId is already set.
 *
 *  Step 2 – Re-run D2D ReferralRelationship backfill.
 *            Now that referredByDriverId is set, recordRelationship() can
 *            resolve rootDriverId correctly and create the missing D2D rows.
 *
 *  Step 3 – Set Passenger.rootDriverId for orphaned passengers
 *            (referredByDriverId set but rootDriverId null). Resolves via
 *            the driver's root.
 *
 * Run with:
 *   npx ts-node scripts/backfill-driver-referredby.ts
 */
import { ActorType } from "@prisma/client";
import { prisma } from "../src/infra/prisma/client";
import { recordRelationship } from "../src/domain/referral-network/ReferralRelationshipService";
import { resolveDriverRoot } from "../src/domain/referral-network/DriverRootResolverService";

async function step1SetReferredByDriverId(): Promise<{
  updated: number;
  skipped: number;
  errors: string[];
}> {
  console.log("\n=== Step 1: Set Driver.referredByDriverId from DriverReferral ===");

  // Only direct referrals (isDirect=true) represent the DIRECT parent edge.
  const directReferrals = await prisma.driverReferral.findMany({
    where: { isDirect: true },
    select: { referrerDriverId: true, referredDriverId: true },
  });
  console.log(`  Found ${directReferrals.length} direct DriverReferral rows`);

  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of directReferrals) {
    try {
      const driver = await prisma.driver.findUnique({
        where: { id: row.referredDriverId },
        select: { id: true, referredByDriverId: true },
      });
      if (!driver) {
        errors.push(`Driver ${row.referredDriverId} not found`);
        continue;
      }
      if (driver.referredByDriverId !== null) {
        skipped++;
        console.log(`  SKIP ${driver.id} – referredByDriverId already set to ${driver.referredByDriverId}`);
        continue;
      }
      await prisma.driver.update({
        where: { id: row.referredDriverId },
        data: { referredByDriverId: row.referrerDriverId },
      });
      updated++;
      console.log(`  SET  ${row.referredDriverId} → referredByDriverId = ${row.referrerDriverId}`);
    } catch (e: any) {
      errors.push(`${row.referredDriverId}: ${e?.message ?? String(e)}`);
    }
  }

  console.log(`  Result: updated=${updated}, skipped=${skipped}, errors=${errors.length}`);
  return { updated, skipped, errors };
}

async function step2BackfillD2DRelationships(): Promise<{
  created: number;
  skipped: number;
  errors: string[];
}> {
  console.log("\n=== Step 2: Backfill D2D ReferralRelationship rows ===");

  const drivers = await prisma.driver.findMany({
    where: { referredByDriverId: { not: null } },
    select: { id: true, referredByDriverId: true },
  });
  console.log(`  Drivers with referredByDriverId set: ${drivers.length}`);

  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const d of drivers) {
    try {
      const existing = await prisma.referralRelationship.findUnique({
        where: {
          invitedActorType_invitedId: {
            invitedActorType: ActorType.DRIVER,
            invitedId: d.id,
          },
        },
      });
      if (existing) {
        skipped++;
        continue;
      }
      await recordRelationship({
        inviterActorType: ActorType.DRIVER,
        inviterId: d.referredByDriverId!,
        invitedActorType: ActorType.DRIVER,
        invitedId: d.id,
      });
      created++;
      console.log(`  CREATED D2D rel: ${d.referredByDriverId} → ${d.id}`);
    } catch (e: any) {
      errors.push(`${d.id}: ${e?.message ?? String(e)}`);
      console.error(`  ERROR  ${d.id}: ${e?.message ?? String(e)}`);
    }
  }

  console.log(`  Result: created=${created}, skipped=${skipped}, errors=${errors.length}`);
  return { created, skipped, errors };
}

async function step3FixOrphanedPassengerRoots(): Promise<{
  updated: number;
  skipped: number;
  errors: string[];
}> {
  console.log("\n=== Step 3: Fix orphaned Passenger.rootDriverId ===");

  const orphaned = await prisma.passenger.findMany({
    where: {
      referredByDriverId: { not: null },
      rootDriverId: null,
    },
    select: { id: true, referredByDriverId: true },
  });
  console.log(`  Orphaned passengers (referredByDriverId set, rootDriverId null): ${orphaned.length}`);

  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const p of orphaned) {
    try {
      const rootDriverId = await resolveDriverRoot(
        ActorType.DRIVER as any,
        p.referredByDriverId!
      );
      if (!rootDriverId) {
        console.log(`  SKIP ${p.id} – could not resolve root for driver ${p.referredByDriverId}`);
        skipped++;
        continue;
      }
      await prisma.passenger.update({
        where: { id: p.id },
        data: { rootDriverId },
      });
      updated++;
      console.log(`  SET  passenger ${p.id} → rootDriverId = ${rootDriverId}`);
    } catch (e: any) {
      errors.push(`${p.id}: ${e?.message ?? String(e)}`);
      console.error(`  ERROR ${p.id}: ${e?.message ?? String(e)}`);
    }
  }

  console.log(`  Result: updated=${updated}, skipped=${skipped}, errors=${errors.length}`);
  return { updated, skipped, errors };
}

async function verifyProjection(rootDriverId: string): Promise<void> {
  console.log("\n=== Verification: BuildGenealogyProjection after backfill ===");
  const { buildGenealogyProjection } = await import(
    "../src/domain/genealogy/BuildGenealogyProjectionService"
  );
  const proj = await buildGenealogyProjection(rootDriverId, { maxDepth: 5 });
  const driverNodes = proj.nodes.filter((n) => n.actorType === "DRIVER");
  const passengerNodes = proj.nodes.filter((n) => n.actorType === "PASSENGER");
  const d2dEdges = proj.edges.filter((e) => e.flowType === "DRIVER_TO_DRIVER");

  console.log(`  Total nodes:      ${proj.nodes.length}`);
  console.log(`  Driver nodes:     ${driverNodes.length}`);
  console.log(`  Passenger nodes:  ${passengerNodes.length}`);
  console.log(`  D2D edges:        ${d2dEdges.length}`);
  console.log(`  Max depth:        ${proj.stats.maxDepth}`);
  console.log(`  Stats:            ${JSON.stringify(proj.stats)}`);
  console.log(`  Driver names:     ${driverNodes.map((n) => n.name).join(", ")}`);
}

async function main() {
  console.log("Starting Driver referredByDriverId + D2D backfill...\n");

  const r1 = await step1SetReferredByDriverId();
  const r2 = await step2BackfillD2DRelationships();
  const r3 = await step3FixOrphanedPassengerRoots();

  console.log("\n=== SUMMARY ===");
  console.log("Step 1 (referredByDriverId):", r1);
  console.log("Step 2 (D2D rels):", r2);
  console.log("Step 3 (passenger rootDriverId):", r3);

  const allErrors = [...r1.errors, ...r2.errors, ...r3.errors];
  if (allErrors.length > 0) {
    console.error("\nERRORS:", allErrors);
  }

  await verifyProjection("1e6e8e76-9477-4517-9390-d71245b9a141");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
