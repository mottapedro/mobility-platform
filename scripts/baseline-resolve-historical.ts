/**
 * Resolve the certified historical migration catalog after the baseline SQL
 * has been applied. The resolver is fail-closed: it refuses to run unless the
 * caller points Prisma at the materialized 51-entry authorized catalog.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  AUTHORIZED_CATALOG_COUNT,
  BASELINE_MIGRATION,
  HISTORICAL_MIGRATIONS,
  validateAuthorizedCatalogPath,
} from "./materialize-authorized-migration-catalog";

const EXPECTED_HISTORICAL_COUNT = 43;

function requiredMigrationCatalogPath(): string {
  const value = process.env.PRISMA_MIGRATIONS_PATH?.trim();
  if (!value) {
    throw new Error("PRISMA_MIGRATIONS_PATH is required; run materialize-authorized-migration-catalog first");
  }

  const resolved = path.resolve(value);
  validateAuthorizedCatalogPath(resolved);
  return resolved;
}

function bootstrapConfigPath(): string {
  return path.resolve(
    process.env.PRISMA_BOOTSTRAP_CONFIG?.trim() || path.join(__dirname, "prisma.bootstrap.ts")
  );
}

async function main(): Promise<void> {
  const migrationsPath = requiredMigrationCatalogPath();
  const configPath = bootstrapConfigPath();

  if (HISTORICAL_MIGRATIONS.length !== EXPECTED_HISTORICAL_COUNT) {
    throw new Error(
      `Historical migration catalog must contain ${EXPECTED_HISTORICAL_COUNT} entries, got ${HISTORICAL_MIGRATIONS.length}`
    );
  }

  console.log(`AUTHORIZED_CATALOG_PATH=${migrationsPath}`);
  console.log(`AUTHORIZED_CATALOG_COUNT=${AUTHORIZED_CATALOG_COUNT}`);
  console.log(`BASELINE_MIGRATION=${BASELINE_MIGRATION}`);
  console.log(`HISTORICAL_RESOLVED_COUNT=${HISTORICAL_MIGRATIONS.length}`);
  console.log("EXCLUDED_SQL_EXECUTED=0");

  const prismaCli = path.join(__dirname, "..", "node_modules", "prisma", "build", "index.js");
  let success = 0;
  let failed = 0;

  for (const migration of HISTORICAL_MIGRATIONS) {
    try {
      execFileSync(
        process.execPath,
        [
          prismaCli,
          "migrate",
          "resolve",
          "--config",
          configPath,
          "--applied",
          migration,
        ],
        {
          stdio: "pipe",
          encoding: "utf-8",
          env: {
            ...process.env,
            PRISMA_MIGRATIONS_PATH: migrationsPath,
          },
        }
      );
      success++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("P3008") && message.includes("already recorded as applied")) {
        console.log(`ALREADY_APPLIED: ${migration}`);
        success++;
        continue;
      }
      console.error(`FAILED: ${migration} — ${message}`);
      failed++;
    }
  }

  console.log("\n=== RESULT ===");
  console.log(`Applied: ${success}/${HISTORICAL_MIGRATIONS.length}`);
  console.log(`Failed:  ${failed}/${HISTORICAL_MIGRATIONS.length}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
