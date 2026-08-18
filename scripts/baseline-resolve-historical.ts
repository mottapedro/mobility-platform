/**
 * Baseline Historical Migration Resolver
 * 
 * Marca todas as migrations históricas anteriores ao baseline como "applied"
 * em bancos novos que já receberam o baseline SQL.
 * 
 * Uso:
 *   $env:DATABASE_URL="<url>"
 *   npx tsx scripts/baseline-resolve-historical.ts
 */

const BASELINE_MIGRATION = "20260101000000_init_baseline";
const EXPECTED_HISTORICAL_COUNT = 44;

const HISTORICAL_MIGRATIONS = [
  "20260421003315_init",
  "20260422015353_add_ride_metrics",
  "20260423140951_add_driver_network",
  "20260425105032_add_ride_context",
  "20260427135402_add_waiting_referral_status",
  "20260429000000_add_driver_referral",
  "20260429020039_add_driver_referral",
  "20260429020248_add_driver_referral",
  "20260429021936_add_referral_index",
  "20260505134022_add_password_hash",
  "20260509000000_add_driver_referral_code",
  "20260512153000_add_driver_network_columns",
  "20260512170000_add_driver_identifier_uniques",
  "20260517000000_add_passenger_referral_network",
  "20260518000000_passenger_codes_not_null_future",
  "20260520140500_add_referral_network_indexes",
  "20260521160959_sync_driver_referral_schema",
  "20260524000000_add_is_direct_to_driver_referral",
  "20260524000001_add_operational_cutoff",
  "20260525000000_add_driver_metadata",
  "20260526000000_aliado_v2_referral_skills",
  "20260526190329_add_driver_referred_event",
  "20260527000000_aliado_v2_payment_domain",
  "20260528000000_aliado_v2_invites",
  "20260530000000_aliado_v2_ownership_enums",
  "20260531000000_restore_driver_regions_default",
  "20260601000000_add_ride_dispatch_queue_state",
  "20260601010000_add_dispatch_lifecycle_statuses",
  "20260601020000_rename_match_level_to_dispatch_stage",
  "20260612180000_expand_lifecycle_enums",
  "20260612190000_contract_lifecycle_enums",
  "20260612200000_readd_pending_to_offer_status",
  "20260612210000_add_dispatch_stage_values",
  "20260612220000_add_operational_zones",
  "20260622200000_add_settlement_root_driver_id",
  "20260701000000_add_peso_esforco_to_operational_zone",
  "20260703000000_add_pricing_fields_to_ride_request",
  "20260705000000_add_trip_execution_timestamps",
  "20260705000001_settlement_root_driver_id_nullable",
  "20260720000001_pricing_snapshot",
  "20260720000002_revenue_policy",
  "20260720000003_revenue_policy_fix_code_unique",
  "20260720000004_ownership_snapshot",
  "20260720000005_ownership_policy",
];

/**
 * Governance guard — the absorbed-migration catalog must stay frozen and exact.
 *
 * The catalog is validated against the COMMITTED migration set (git ls-tree
 * HEAD), never against the working tree: uncommitted in-progress migrations
 * (e.g. a local GPS/trip migration still under review) must not affect the
 * frozen contract. This keeps local proofs and CI consistent.
 *
 * Rules enforced:
 *  1. The baseline migration must NOT be in the absorbed list (it is applied
 *     physically, then marked applied via `migrate resolve`).
 *  2. The list must contain exactly EXPECTED_HISTORICAL_COUNT migrations.
 *  3. Every committed migration whose timestamp is <= the newest absorbed
 *     migration MUST be cataloged. A committed migration that is missing
 *     from the list means a new historical migration was added without being
 *     absorbed by the baseline — this must fail, never silently resolve.
 *  4. No migration older than the baseline may be resolved (timestamp < baseline).
 *  5. No migration newer than the newest absorbed migration may be resolved —
 *     anything past the historical cutoff must be executed by `migrate deploy`,
 *     never pre-marked applied.
 */
function listCommittedMigrations(): string[] {
  const { execFileSync } = require("child_process") as typeof import("child_process");

  try {
    const out = execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", "HEAD", "--", "prisma/migrations"],
      { encoding: "utf-8", stdio: "pipe" }
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("prisma/migrations/"))
      .map((l) => l.replace(/^prisma\/migrations\//, "").split("/")[0])
      .filter((l) => /^\d{8,}_/.test(l));
  } catch {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const dir = path.resolve(__dirname, "..", "prisma", "migrations");
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => /^\d{8,}_/.test(name));
  }
}

function validateCatalog(): void {
  const entries = listCommittedMigrations();

  const sorted = [...HISTORICAL_MIGRATIONS].sort();
  const cutoff = sorted[sorted.length - 1];

  const errors: string[] = [];

  if (HISTORICAL_MIGRATIONS.includes(BASELINE_MIGRATION)) {
    errors.push(`catalog must NOT include the baseline migration (${BASELINE_MIGRATION})`);
  }

  if (HISTORICAL_MIGRATIONS.length !== EXPECTED_HISTORICAL_COUNT) {
    errors.push(
      `catalog has ${HISTORICAL_MIGRATIONS.length} entries; expected exactly ${EXPECTED_HISTORICAL_COUNT}`
    );
  }

  for (const name of entries) {
    if (name === BASELINE_MIGRATION) continue;

    const isAbsorbed = HISTORICAL_MIGRATIONS.includes(name);

    if (!isAbsorbed && name <= cutoff) {
      errors.push(
        `migration "${name}" exists at/below the historical cutoff (${cutoff}) but is NOT cataloged as absorbed — the baseline likely predates it`
      );
    }

    if (isAbsorbed && name < BASELINE_MIGRATION) {
      errors.push(`catalog resolves "${name}" which is older than the baseline — invalid`);
    }

    if (isAbsorbed && name > cutoff) {
      errors.push(`catalog resolves "${name}" which is newer than the historical cutoff (${cutoff}) — must run via migrate deploy, not be pre-applied`);
    }
  }

  for (const name of HISTORICAL_MIGRATIONS) {
    if (!entries.includes(name)) {
      errors.push(`catalog references "${name}" but the migrations directory is missing it`);
    }
  }

  if (errors.length > 0) {
    console.error("\n❌ Baseline historical catalog validation FAILED:");
    for (const err of errors) console.error(`   - ${err}`);
    console.error(
      "   The absorbed-migration catalog must match the frozen historical set.\n"
    );
    process.exit(1);
  }

  console.log(
    `✅ Catalog OK: ${EXPECTED_HISTORICAL_COUNT} absorbed migrations, baseline excluded, cutoff="${cutoff}"`
  );
}

async function main() {
  const { execFileSync } = await import("child_process");
  const path = await import("path");
  const configPath = "scripts/prisma.bootstrap.ts";

  // Resolve the Prisma CLI entry so the script works on any OS without
  // depending on `npx` being on PATH (paths with spaces break `npx` on
  // Windows). `node node_modules/prisma/build/index.js` is the CLI entry.
  const prismaCli = path.join(
    __dirname,
    "..",
    "node_modules",
    "prisma",
    "build",
    "index.js"
  );

  validateCatalog();

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
        { stdio: "pipe", encoding: "utf-8" }
      );
      success++;
    } catch (e: any) {
      console.error(`FAILED: ${migration} — ${e.message}`);
      failed++;
    }
  }
  
  console.log(`\n=== RESULT ===`);
  console.log(`Applied: ${success}/${HISTORICAL_MIGRATIONS.length}`);
  console.log(`Failed:  ${failed}/${HISTORICAL_MIGRATIONS.length}`);
  
  if (failed > 0) process.exit(1);
}

main();
