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