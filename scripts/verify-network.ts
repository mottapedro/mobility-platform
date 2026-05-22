import { RideStatus } from "@prisma/client";
import { prisma } from "../src/infra/prisma/client";

function fail(message: string) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function ok(message: string) {
  console.log(`✅ ${message}`);
}

async function main(): Promise<void> {const PrismaClient = undefined as unknown as undefined;
  const prisma = new PrismaClient({});
  // Uses DATABASE_URL from prisma.config.ts via environment.


  try {
    // Drivers
    const drivers = await prisma.driver.findMany({ select: { id: true, isActive: true, regions: true, referredByDriverId: true } });
    ok(`drivers.count=${drivers.length}`);

    // Passengers
    const passengers = await prisma.passenger.findMany({ select: { id: true, referredByDriverId: true, networkLevel: true, lineagePath: true, rootPassengerId: true } });
    ok(`passengers.count=${passengers.length}`);

    // Referrals: driver referral edges
    const driverReferralEdges = await prisma.driverReferral.findMany({ select: { referrerDriverId: true, referredDriverId: true, level: true } });
    ok(`driverReferral.edges=${driverReferralEdges.length}`);

    // Basic constraints
    const cycleSuspects = driverReferralEdges.filter((e) => e.referrerDriverId === e.referredDriverId);
    if (cycleSuspects.length > 0) fail(`self-referral detected: ${cycleSuspects.length}`);

    // Orphan nodes: passengers referredByDriverId must have driver
    const missingDrivers = await prisma.passenger.findMany({
      where: {
        referredByDriverId: {
          not: null,
        },
        referredByDriver: null,
      },
      select: { id: true, referredByDriverId: true },
    });
    if (missingDrivers.length > 0) fail(`orphans passengers (missing driver): ${missingDrivers.length}`);

    // Ride consistency checks
    const rides = await prisma.rideRequest.findMany({ select: { id: true, status: true, passengerId: true, selectedDriverId: true, scheduledAt: true } });
    ok(`rides.count=${rides.length}`);

    const completedMissingDriver = rides.filter((r) => r.status === RideStatus.COMPLETED && !r.selectedDriverId);
    if (completedMissingDriver.length > 0) fail(`COMPLETED rides without selectedDriverId: ${completedMissingDriver.length}`);

    // Depth sanity on driver snapshot levels is indirectly validated by domain service tests,
    // but we can ensure max level in edges <= 5.
    const maxEdgeLevel = driverReferralEdges.reduce((m, e) => Math.max(m, e.level), 0);
    if (maxEdgeLevel > 5) fail(`driver referral max level exceeded: ${maxEdgeLevel}`);
    else ok(`driver referral maxLevel=${maxEdgeLevel}`);

    console.log("\nNetwork verification finished.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("❌ verify-network failed", e);
  process.exit(1);
});

