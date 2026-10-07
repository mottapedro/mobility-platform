import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MATERIALIZER_DIAGNOSTIC_COMPONENT = "authorizedMigrationCatalogMaterializer";
export const MATERIALIZER_BOUNDARIES = [
  "MATERIALIZER_MODULE_ENTERED",
  "MATERIALIZER_MODULE_INITIALIZATION_COMPLETED",
  "MATERIALIZER_CLI_ENTERED",
  "SOURCE_CATALOG_VALIDATION_ENTERED",
  "SOURCE_CATALOG_VALIDATED",
  "CATALOG_COPY_COMPLETED",
  "OUTPUT_STRUCTURE_VALIDATED",
  "FINGERPRINT_AUTHORITY_READ",
  "FINGERPRINT_VERIFIED",
  "MANIFEST_WRITTEN",
] as const;
export const MATERIALIZER_FAILURE_CATEGORIES = [
  "MATERIALIZER_SOURCE_CATALOG_UNAVAILABLE",
  "MATERIALIZER_SOURCE_CATALOG_INVALID",
  "MATERIALIZER_SOURCE_MEMBERSHIP_MISMATCH",
  "MATERIALIZER_OUTPUT_CATALOG_CREATION_FAILED",
  "MATERIALIZER_MIGRATION_COPY_FAILED",
  "MATERIALIZER_LOCKFILE_COPY_FAILED",
  "MATERIALIZER_OUTPUT_STRUCTURE_INVALID",
  "MATERIALIZER_FINGERPRINT_AUTHORITY_UNAVAILABLE",
  "MATERIALIZER_FINGERPRINT_AUTHORITY_INVALID",
  "MATERIALIZER_FINGERPRINT_MISMATCH",
  "MATERIALIZER_MANIFEST_WRITE_FAILED",
] as const;

type MaterializerBoundary = typeof MATERIALIZER_BOUNDARIES[number];
type MaterializerFailureCategory = typeof MATERIALIZER_FAILURE_CATEGORIES[number];
type DiagnosticWrite = (fd: number, bytes: Uint8Array) => unknown;

export function createMaterializerDiagnostics(write: DiagnosticWrite = writeSync) {
  let lastBoundary: MaterializerBoundary | null = null;
  let diagnosticEmitted = false;
  const emit = (record: object): boolean => {
    try {
      write(3, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
      return true;
    } catch {
      return false;
    }
  };
  return Object.freeze({
    boundary(boundary: MaterializerBoundary): boolean {
      if (!MATERIALIZER_BOUNDARIES.includes(boundary)) return false;
      if (!emit({ type: "BOUNDARY", boundary })) return false;
      lastBoundary = boundary;
      return true;
    },
    diagnostic(category: MaterializerFailureCategory): boolean {
      if (diagnosticEmitted || !lastBoundary || !MATERIALIZER_FAILURE_CATEGORIES.includes(category)) return false;
      if (!emit({
        type: "DIAGNOSTIC",
        component: MATERIALIZER_DIAGNOSTIC_COMPONENT,
        category,
        boundary: lastBoundary,
      })) return false;
      diagnosticEmitted = true;
      return true;
    },
    get lastBoundary() { return lastBoundary; },
  });
}

const childDiagnostics = createMaterializerDiagnostics();
childDiagnostics.boundary("MATERIALIZER_MODULE_ENTERED");

function classified<T>(category: MaterializerFailureCategory, action: () => T): T {
  try {
    return action();
  } catch (error) {
    childDiagnostics.diagnostic(category);
    throw error;
  }
}

export const BASELINE_MIGRATION = "20260101000000_init_baseline";

export const HISTORICAL_MIGRATIONS = [
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
] as const;

export const POST_CUTOFF_MIGRATIONS = [
  "20260813000000_add_auth_sessions",
  "20260813010000_seed_skill_catalog_reference_data",
  "20260817000000_ride_scheduled_at_nullable",
  "20260817000001_add_ride_place_ids",
  "20260817000002_add_ride_quote_contract",
  "20260817000003_add_driver_base_current_location_offer_snapshot",
  "20260824000000_add_ride_offer_history_index",
  "20260909000000_add_ride_creation_correlation",
  "20260909000001_add_ride_creation_intent_fingerprint",
  "20260910000000_add_waiting_owner_ride_status",
  "20260910000001_add_cancelled_ride_offer_status",
  "20260911000000_restore_one_pending_offer_per_ride",
  "20260920000000_dispatch_round_schema_materialization",
] as const;

export const EXCLUDED_SUPERSEDED_MIGRATIONS = [
  "20260518000000_passenger_codes_not_null_future",
  "20260706000000_trip_execution_boundary",
  "20260720000000_gps_tracking",
] as const;

export const AUTHORIZED_MIGRATIONS = [
  BASELINE_MIGRATION,
  ...HISTORICAL_MIGRATIONS,
  ...POST_CUTOFF_MIGRATIONS,
] as const;

export const AUTHORIZED_CATALOG_COUNT = AUTHORIZED_MIGRATIONS.length;
const EXPECTED_FINGERPRINT_PATH = path.resolve("governance/authorized-migration-catalog.sha256");
const MIGRATION_DIRECTORY_PATTERN = /^\d{8,}_/;

function migrationDirectories(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Migration catalog directory does not exist: ${root}`);
  }

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && MIGRATION_DIRECTORY_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function assertCatalogDefinition(): void {
  const expected = unique(AUTHORIZED_MIGRATIONS);
  if (expected.length !== AUTHORIZED_CATALOG_COUNT || AUTHORIZED_CATALOG_COUNT !== 57) {
    throw new Error(`Authorized migration catalog must contain 57 unique entries, got ${expected.length}`);
  }
  if (HISTORICAL_MIGRATIONS.length !== 43) {
    throw new Error(`Historical migration definition must contain 43 entries, got ${HISTORICAL_MIGRATIONS.length}`);
  }
  if (POST_CUTOFF_MIGRATIONS.length !== 13) {
    throw new Error(`Post-cutoff migration definition must contain 13 entries, got ${POST_CUTOFF_MIGRATIONS.length}`);
  }
}

export function validateAuthorizedCatalogPath(catalogPath: string): void {
  assertCatalogDefinition();
  const actual = migrationDirectories(catalogPath);
  const expected = unique(AUTHORIZED_MIGRATIONS);
  const excluded = new Set(EXCLUDED_SUPERSEDED_MIGRATIONS);
  const unknown = difference(actual, expected);
  const missing = difference(expected, actual);
  const excludedPresent = actual.filter((name) => excluded.has(name));

  if (unknown.length > 0 || missing.length > 0 || excludedPresent.length > 0 || actual.length !== AUTHORIZED_CATALOG_COUNT) {
    throw new Error(
      [
        "Authorized migration catalog validation failed.",
        `actual=${actual.length}`,
        `expected=${AUTHORIZED_CATALOG_COUNT}`,
        `unknown=${unknown.join(",") || "none"}`,
        `missing=${missing.join(",") || "none"}`,
        `excludedPresent=${excludedPresent.join(",") || "none"}`,
      ].join(" ")
    );
  }

  const missingSql = expected.filter((name) => !existsSync(path.join(catalogPath, name, "migration.sql")));
  if (missingSql.length > 0) {
    throw new Error(`Authorized migrations missing migration.sql: ${missingSql.join(",")}`);
  }
  if (!existsSync(path.join(catalogPath, "migration_lock.toml"))) {
    throw new Error("Authorized migration catalog is missing migration_lock.toml");
  }
}

export function calculateAuthorizedCatalogFingerprint(catalogPath: string): string {
  validateAuthorizedCatalogPath(catalogPath);
  const entries = [...AUTHORIZED_MIGRATIONS].sort().map((migration) => {
    const sql = canonicalizeMigrationSql(readFileSync(path.join(catalogPath, migration, "migration.sql")));
    const digest = crypto.createHash("sha256").update(sql).digest("hex");
    return `${migration}\t${digest}`;
  }).join("\n");
  return crypto.createHash("sha256").update(`${entries}\n`).digest("hex");
}

export function canonicalizeMigrationSql(input: Buffer): Buffer {
  return Buffer.from(input.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function writeCatalogOutputs(catalogPath: string, outputDir: string, fingerprint: string): void {
  mkdirSync(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, "manifest");
  writeFileSync(manifestPath, [
    `commit_sha=${process.env.GITHUB_SHA ?? "UNSET"}`,
    `catalog_count=${AUTHORIZED_CATALOG_COUNT}`,
    `fingerprint=${fingerprint}`,
    "",
  ].join("\n"));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `catalog_dir=${catalogPath}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `manifest=${manifestPath}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `fingerprint=${fingerprint}\n`);
  }
  childDiagnostics.boundary("MANIFEST_WRITTEN");
}

export interface MaterializedCatalog {
  path: string;
  sourceMigrationCount: number;
  authorizedMigrationCount: number;
  unknownMigrationCount: number;
  excludedMigrationCount: number;
}

export function materializeAuthorizedMigrationCatalog(options: {
  sourcePath?: string;
  targetPath?: string;
} = {}): MaterializedCatalog {
  assertCatalogDefinition();
  const sourcePath = options.sourcePath ?? path.resolve(__dirname, "..", "prisma", "migrations");
  const targetPath = options.targetPath ?? mkdtempSync(path.join(os.tmpdir(), "mobility-authorized-migrations-"));
  childDiagnostics.boundary("SOURCE_CATALOG_VALIDATION_ENTERED");
  classified("MATERIALIZER_SOURCE_CATALOG_UNAVAILABLE", () => {
    if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
      throw new Error(`Migration catalog directory does not exist: ${sourcePath}`);
    }
  });
  const sourceEntries = classified("MATERIALIZER_SOURCE_CATALOG_INVALID", () => migrationDirectories(sourcePath));
  const expected = unique(AUTHORIZED_MIGRATIONS);
  const allowedSource = new Set([...expected, ...EXCLUDED_SUPERSEDED_MIGRATIONS]);
  const unknown = sourceEntries.filter((name) => !allowedSource.has(name));
  const missing = difference(expected, sourceEntries);

  if (unknown.length > 0 || missing.length > 0) {
    childDiagnostics.diagnostic("MATERIALIZER_SOURCE_MEMBERSHIP_MISMATCH");
    throw new Error(
      [
        "Source migration catalog validation failed.",
        `source=${sourcePath}`,
        `unknown=${unknown.join(",") || "none"}`,
        `missing=${missing.join(",") || "none"}`,
      ].join(" ")
    );
  }
  childDiagnostics.boundary("SOURCE_CATALOG_VALIDATED");

  classified("MATERIALIZER_OUTPUT_CATALOG_CREATION_FAILED", () => {
    mkdirSync(targetPath, { recursive: true });
    if (migrationDirectories(targetPath).length > 0) {
      throw new Error(`Target migration catalog must be empty: ${targetPath}`);
    }
  });

  for (const migration of expected) {
    classified("MATERIALIZER_MIGRATION_COPY_FAILED", () => {
      cpSync(path.join(sourcePath, migration), path.join(targetPath, migration), {
        recursive: true,
        errorOnExist: true,
      });
    });
  }

  const lockFile = path.join(sourcePath, "migration_lock.toml");
  if (!existsSync(lockFile)) {
    childDiagnostics.diagnostic("MATERIALIZER_LOCKFILE_COPY_FAILED");
    throw new Error(`Source migration catalog is missing migration_lock.toml: ${sourcePath}`);
  }
  classified("MATERIALIZER_LOCKFILE_COPY_FAILED", () => {
    cpSync(lockFile, path.join(targetPath, "migration_lock.toml"), { errorOnExist: true });
  });
  childDiagnostics.boundary("CATALOG_COPY_COMPLETED");
  classified("MATERIALIZER_OUTPUT_STRUCTURE_INVALID", () => validateAuthorizedCatalogPath(targetPath));
  childDiagnostics.boundary("OUTPUT_STRUCTURE_VALIDATED");

  return {
    path: targetPath,
    sourceMigrationCount: sourceEntries.length,
    authorizedMigrationCount: expected.length,
    unknownMigrationCount: unknown.length,
    excludedMigrationCount: sourceEntries.filter((name) => new Set(EXCLUDED_SUPERSEDED_MIGRATIONS).has(name)).length,
  };
}

childDiagnostics.boundary("MATERIALIZER_MODULE_INITIALIZATION_COMPLETED");

if (require.main === module) {
  childDiagnostics.boundary("MATERIALIZER_CLI_ENTERED");
  try {
    const outputDir = argumentValue("--output-dir");
    const result = materializeAuthorizedMigrationCatalog({
      targetPath: outputDir ? path.join(outputDir, "catalog") : undefined,
    });
    console.log(`AUTHORIZED_CATALOG_PATH=${result.path}`);
    console.log(`AUTHORIZED_CATALOG_COUNT=${result.authorizedMigrationCount}`);
    console.log(`SOURCE_MIGRATION_COUNT=${result.sourceMigrationCount}`);
    console.log(`UNKNOWN_MIGRATION_COUNT=${result.unknownMigrationCount}`);
    console.log(`EXCLUDED_MIGRATION_COUNT=${result.excludedMigrationCount}`);
    console.log("EXCLUDED_SQL_EXECUTED=0");
    if (process.argv.includes("--verify-fingerprint")) {
      const actual = calculateAuthorizedCatalogFingerprint(result.path);
      const expected = classified("MATERIALIZER_FINGERPRINT_AUTHORITY_UNAVAILABLE", () => (
        readFileSync(EXPECTED_FINGERPRINT_PATH, "utf8").trim()
      ));
      if (!/^[a-f0-9]{64}$/.test(expected)) {
        childDiagnostics.diagnostic("MATERIALIZER_FINGERPRINT_AUTHORITY_INVALID");
        throw new Error("FINGERPRINT_AUTHORITY_NOT_ESTABLISHED");
      }
      childDiagnostics.boundary("FINGERPRINT_AUTHORITY_READ");
      if (actual !== expected) {
        childDiagnostics.diagnostic("MATERIALIZER_FINGERPRINT_MISMATCH");
        throw new Error(`AUTHORIZED_CATALOG_FINGERPRINT_MISMATCH expected=${expected} actual=${actual}`);
      }
      childDiagnostics.boundary("FINGERPRINT_VERIFIED");
      console.log(`AUTHORIZED_CATALOG_FINGERPRINT=${actual}`);
      console.log("AUTHORIZED_CATALOG_FINGERPRINT_STATUS=PASS");
      if (outputDir) classified("MATERIALIZER_MANIFEST_WRITE_FAILED", () => writeCatalogOutputs(result.path, outputDir, actual));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
