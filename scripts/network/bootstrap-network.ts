import "dotenv/config";
import { prisma } from "../../src/infra/prisma/client";
import { runBootstrapNetwork } from "../../prisma/seeds/bootstrap-network";

async function main() {
  const dryRun = !process.argv.includes("--write");
  if (dryRun) {
    console.log("[DRY-RUN] Pass --write to persist changes.");
  }
  const result = await runBootstrapNetwork(prisma, { dryRun });
  console.log(JSON.stringify({ dryRun, ...result }, null, 2));
}

main()
  .catch((error) => {
    console.error("Bootstrap network failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
