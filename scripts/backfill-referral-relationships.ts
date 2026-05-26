/**
 * Backfill — V2 Aliado Network: ReferralRelationship rows from legacy
 * DriverReferral (closure) + Passenger.referredByDriver/Passenger edges.
 *
 * Idempotent: each call upserts via @@unique(invitedActorType, invitedId).
 *
 * Usage: npm run backfill:referral-v2
 */
import { ActorType, ReferralFlowType } from "@prisma/client";
import { prisma } from "../src/infra/prisma/client";
import { recordRelationship } from "../src/domain/referral-network/ReferralRelationshipService";

interface BackfillSummary {
  driverToDriver: { processed: number; created: number; skipped: number };
  driverToPassenger: { processed: number; created: number; skipped: number };
  passengerToPassenger: { processed: number; created: number; skipped: number };
  errors: Array<{ kind: string; id: string; message: string }>;
}

async function backfillDriverToDriver(summary: BackfillSummary) {
  // For each driver that has referredByDriverId set, record DRIVER→DRIVER
  const drivers = await prisma.driver.findMany({
    where: { referredByDriverId: { not: null } },
    select: { id: true, referredByDriverId: true },
  });
  for (const d of drivers) {
    summary.driverToDriver.processed++;
    try {
      const before = await prisma.referralRelationship.findUnique({
        where: {
          invitedActorType_invitedId: {
            invitedActorType: ActorType.DRIVER,
            invitedId: d.id,
          },
        },
      });
      await recordRelationship({
        inviterActorType: ActorType.DRIVER,
        inviterId: d.referredByDriverId!,
        invitedActorType: ActorType.DRIVER,
        invitedId: d.id,
      });
      if (before) summary.driverToDriver.skipped++;
      else summary.driverToDriver.created++;
    } catch (e: any) {
      summary.errors.push({ kind: "D->D", id: d.id, message: e?.message ?? String(e) });
    }
  }
}

async function backfillDriverToPassenger(summary: BackfillSummary) {
  const passengers = await prisma.passenger.findMany({
    where: { referredByDriverId: { not: null } },
    select: { id: true, referredByDriverId: true },
  });
  for (const p of passengers) {
    summary.driverToPassenger.processed++;
    try {
      const before = await prisma.referralRelationship.findUnique({
        where: {
          invitedActorType_invitedId: {
            invitedActorType: ActorType.PASSENGER,
            invitedId: p.id,
          },
        },
      });
      await recordRelationship({
        inviterActorType: ActorType.DRIVER,
        inviterId: p.referredByDriverId!,
        invitedActorType: ActorType.PASSENGER,
        invitedId: p.id,
      });
      if (before) summary.driverToPassenger.skipped++;
      else summary.driverToPassenger.created++;
    } catch (e: any) {
      summary.errors.push({ kind: "D->P", id: p.id, message: e?.message ?? String(e) });
    }
  }
}

async function backfillPassengerToPassenger(summary: BackfillSummary) {
  const passengers = await prisma.passenger.findMany({
    where: { referredByPassengerId: { not: null }, referredByDriverId: null },
    select: { id: true, referredByPassengerId: true },
  });
  for (const p of passengers) {
    summary.passengerToPassenger.processed++;
    try {
      const before = await prisma.referralRelationship.findUnique({
        where: {
          invitedActorType_invitedId: {
            invitedActorType: ActorType.PASSENGER,
            invitedId: p.id,
          },
        },
      });
      await recordRelationship({
        inviterActorType: ActorType.PASSENGER,
        inviterId: p.referredByPassengerId!,
        invitedActorType: ActorType.PASSENGER,
        invitedId: p.id,
      });
      if (before) summary.passengerToPassenger.skipped++;
      else summary.passengerToPassenger.created++;
    } catch (e: any) {
      summary.errors.push({ kind: "P->P", id: p.id, message: e?.message ?? String(e) });
    }
  }
}

async function main() {
  const summary: BackfillSummary = {
    driverToDriver: { processed: 0, created: 0, skipped: 0 },
    driverToPassenger: { processed: 0, created: 0, skipped: 0 },
    passengerToPassenger: { processed: 0, created: 0, skipped: 0 },
    errors: [],
  };

  console.log("[backfill-referral-v2] start");
  await backfillDriverToDriver(summary);
  await backfillDriverToPassenger(summary);
  await backfillPassengerToPassenger(summary);

  console.log("[backfill-referral-v2] summary:", JSON.stringify(summary, null, 2));
  console.log(`[backfill-referral-v2] used flow types: ${Object.values(ReferralFlowType).join(", ")}`);
  await prisma.$disconnect();
  process.exit(summary.errors.length > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("[backfill-referral-v2] fatal:", e);
  await prisma.$disconnect();
  process.exit(1);
});
