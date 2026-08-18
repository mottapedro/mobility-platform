import "dotenv/config";
import { prisma } from "../src/infra/prisma/client";

async function main() {
  try {
    const migrations: Array<{ migration_name: string; finished_at: Date }> =
      await prisma.$queryRaw`SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at`;

    console.log("--- Content: _prisma_migrations ---");
    migrations.forEach((m) => {
      console.log(`${m.migration_name.padEnd(50)}${m.finished_at}`);
    });
  } catch (error) {
    console.error("Audit script failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}
main();