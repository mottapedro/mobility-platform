import "dotenv/config";
import { closeDevFixturesResources, runDevFixtures } from "./seeds/dev-fixtures";

if (process.env.NODE_ENV === "production") {
  throw new Error("Use scripts/network/bootstrap-network.ts and scripts/network/backfill-driver-network.ts in live environments.");
}

runDevFixtures()
  .catch((error) => {
    console.error("🔥 Erro no seed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await closeDevFixturesResources();
  });

