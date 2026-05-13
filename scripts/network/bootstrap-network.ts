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
