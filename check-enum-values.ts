import { prisma } from "./src/infra/prisma/client";

async function main() {
  console.log("\n=== RideRequest Status Distribution ===");
  const rideStatuses = await prisma.$queryRaw<Array<{ status: string; count: bigint }>>`
    SELECT status, COUNT(*) as count
    FROM "RideRequest"
    GROUP BY status
    ORDER BY count DESC
  `;
  rideStatuses.forEach(r => console.log(`  ${r.status}: ${r.count}`));

  console.log("\n=== RideOffer Status Distribution ===");
  const offerStatuses = await prisma.$queryRaw<Array<{ status: string; count: bigint }>>`
    SELECT status, COUNT(*) as count
    FROM "RideOffer"
    GROUP BY status
    ORDER BY count DESC
  `;
  offerStatuses.forEach(r => console.log(`  ${r.status}: ${r.count}`));

  console.log("\n=== RideRequest with Dispatch Stages ===");
  const dispatchStages = await prisma.$queryRaw<Array<{ dispatchStage: string | null; count: bigint }>>`
    SELECT "dispatchStage", COUNT(*) as count
    FROM "RideRequest"
    GROUP BY "dispatchStage"
    ORDER BY count DESC
  `;
  dispatchStages.forEach(r => console.log(`  ${r.dispatchStage ?? "NULL"}: ${r.count}`));

  await prisma.$disconnect();
}

main().catch(console.error);
