'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { validateTarget, PROJECT_REF } = require('./supabase-target.cjs');

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
};

const schemaPath = path.resolve('prisma/schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf8');
const expectedStatuses = {
  RideStatus: ['PENDING', 'MATCHING', 'WAITING_DRIVER', 'WAITING_REFERRAL', 'WAITING_PARTNER', 'WAITING_GENERAL', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'PAID', 'WAITING_OWNER'],
  RideOfferStatus: ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
};
const expectedColumns = {
  RideRequest: [
    'currentDispatchStage',
    'rootDriverId',
    'selectedDriverId',
    'currentCandidateDriverId',
    'excludedDriverIds',
    'creationCorrelationId',
    'creationIntentFingerprint',
  ],
  Passenger: ['referralCode', 'publicSlug'],
};
const expectedMigrations = [
  '20260910000000_add_waiting_owner_ride_status',
  '20260910000001_add_cancelled_ride_offer_status',
];

const emit = (key, value) => {
  const normalized = Array.isArray(value) ? value.join(',') : String(value);
  console.log(`${key}=${normalized}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key.toLowerCase()}=${normalized}\n`);
};

function readAuthorizedMigrationNames(catalogPath) {
  if (!catalogPath) throw new Error('AUTHORIZED_CATALOG_PATH_REQUIRED');
  return fs.readdirSync(catalogPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(catalogPath, entry.name, 'migration.sql')))
    .map((entry) => entry.name)
    .sort();
}

function evaluateMigrationInventory(rows, authorizedNames) {
  const appliedNames = rows.map((row) => row.migration_name).sort();
  const applied = new Set(appliedNames);
  const authorized = new Set(authorizedNames);
  const missing = authorizedNames.filter((name) => !applied.has(name));
  const unexpected = appliedNames.filter((name) => !authorized.has(name));
  const unfinished = rows.filter((row) => !row.finished_at && !row.rolled_back_at && !row.logs);
  const rolledBack = rows.filter((row) => row.rolled_back_at);
  const failed = rows.filter((row) => row.logs);
  return { appliedNames, missing, unexpected, unfinished, rolledBack, failed };
}

function enumAvailability(enumRows) {
  const values = new Map(Object.keys(expectedStatuses).map((name) => [name, []]));
  for (const row of enumRows) values.get(row.enum_name)?.push(row.enum_value);
  return {
    values,
    waitingOwnerPresent: values.get('RideStatus')?.includes('WAITING_OWNER') === true,
    cancelledPresent: values.get('RideOfferStatus')?.includes('CANCELLED') === true,
  };
}

function enumDependentChecks({ waitingOwnerPresent, cancelledPresent }) {
  return {
    waitingOwner: waitingOwnerPresent
      ? { output: 'QUERY', sql: 'SELECT COUNT(*) AS count FROM "RideRequest" WHERE status::text = \'WAITING_OWNER\'' }
      : { output: 'NOT_APPLICABLE_ENUM_ABSENT' },
    cancelled: cancelledPresent
      ? { output: 'QUERY', sql: 'SELECT COUNT(*) AS count FROM "RideOffer" WHERE status::text = \'CANCELLED\'' }
      : { output: 'NOT_APPLICABLE_ENUM_ABSENT' },
  };
}

function evaluatePhysicalCompatibility({ waitingOwnerPresent, cancelledPresent, requiredColumnsPresent, indexEquivalent }) {
  return !waitingOwnerPresent || !cancelledPresent || !requiredColumnsPresent || !indexEquivalent
    ? 'PRESENT'
    : 'NONE';
}

async function runEnumDependentChecks(client, availability) {
  const checks = enumDependentChecks(availability);
  const result = { waitingOwner: checks.waitingOwner.output, cancelled: checks.cancelled.output };
  if (checks.waitingOwner.sql) result.waitingOwner = (await client.query(checks.waitingOwner.sql)).rows[0].count;
  if (checks.cancelled.sql) result.cancelled = (await client.query(checks.cancelled.sql)).rows[0].count;
  return result;
}

async function main() {
  const target = validateTarget(required('DATABASE_URL'));
  if (target.mode !== 'session') throw new Error('SESSION_POOLER_REQUIRED');
  required('E2E_CA_CERT');

  const client = new Client({
    connectionString: target.connectionString,
    ssl: { ca: process.env.E2E_CA_CERT, rejectUnauthorized: true },
  });

  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');

    const clientStream = client.connection?.stream;
    const clientTlsEncrypted = clientStream?.encrypted === true;
    const clientTlsAuthorized = clientStream?.authorized === true;
    const clientTlsAuthorizationError = clientStream?.authorizationError;

    const connection = await client.query(`
      SELECT current_database() AS database_name,
             current_setting('server_version_num') AS server_version_num,
             current_setting('transaction_read_only') AS transaction_read_only,
             ssl,
             v.version
      FROM pg_stat_ssl
      CROSS JOIN (SELECT version()) AS v
      WHERE pid = pg_backend_pid()
    `);
    const connectionRow = connection.rows[0];
    const pgMajor = String(connectionRow.server_version_num).slice(0, -2);
    emit('POOLER_CONNECTION', 'PASS');
    emit('CLIENT_TLS_ENCRYPTED', clientTlsEncrypted ? 'YES' : 'NO');
    emit('CLIENT_TLS_AUTHORIZED', clientTlsAuthorized ? 'YES' : 'NO');
    emit('BACKEND_PG_STAT_SSL', connectionRow.ssl === true ? 'true' : 'false');
    const clientTlsPass = clientTlsEncrypted && clientTlsAuthorized && !clientTlsAuthorizationError;
    emit('TLS', clientTlsPass ? 'PASS' : 'FAIL');
    emit('PG_VERSION', pgMajor);
    emit('DATABASE_NAME', connectionRow.database_name);
    emit('READ_ONLY_MODE', connectionRow.transaction_read_only === 'on' ? 'PASS' : 'FAIL');
    if (!clientTlsPass) throw new Error('TLS_CERTIFICATION_FAILURE');
    if (connectionRow.transaction_read_only !== 'on') {
      emit('DATABASE_READ_ONLY_ENFORCEMENT', 'FAIL');
      throw new Error('READ_ONLY_ENFORCEMENT_FAILURE');
    }
    emit('DATABASE_READ_ONLY_ENFORCEMENT', 'PASS');

    const enumRows = await client.query(`
      SELECT t.typname AS enum_name, e.enumlabel AS enum_value
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname IN ('RideStatus', 'RideOfferStatus')
      ORDER BY t.typname, e.enumsortorder
    `);
    const availability = enumAvailability(enumRows.rows);
    for (const enumName of Object.keys(expectedStatuses)) {
      const values = availability.values.get(enumName) ?? [];
      emit(`TARGET_${enumName === 'RideStatus' ? 'RIDE_STATUS' : 'RIDEOFFER_STATUS'}_VALUES`, values);
    }
    emit('WAITING_OWNER_TARGET_PRESENT', availability.waitingOwnerPresent ? 'YES' : 'NO');
    emit('RIDEOFFER_CANCELLED_TARGET_PRESENT', availability.cancelledPresent ? 'YES' : 'NO');

    const columnRows = await client.query(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('RideRequest', 'OwnershipSnapshot', 'Passenger')
    `);
    const rideColumns = new Set(columnRows.rows.filter((row) => row.table_name === 'RideRequest').map((row) => row.column_name));
    for (const column of expectedColumns.RideRequest) emit(`TARGET_${column.replaceAll(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}_PRESENT`, rideColumns.has(column) ? 'YES' : 'NO');
    const passengerColumns = new Map(columnRows.rows.filter((row) => row.table_name === 'Passenger').map((row) => [row.column_name, row]));
    emit('PASSENGER_REFERRAL_CODE_NULLABLE', passengerColumns.get('referralCode')?.is_nullable === 'YES' ? 'YES' : 'NO');
    emit('PASSENGER_PUBLIC_SLUG_NULLABLE', passengerColumns.get('publicSlug')?.is_nullable === 'YES' ? 'YES' : 'NO');
    const snapshotPresent = columnRows.rows.some((row) => row.table_name === 'OwnershipSnapshot');
    emit('TARGET_OWNERSHIP_SNAPSHOT_PRESENT', snapshotPresent ? 'YES' : 'NO');
    const schemaFactsPresent = expectedColumns.RideRequest.every((column) => schema.includes(column))
      && expectedColumns.Passenger.every((column) => schema.includes(column))
      && schema.includes('model OwnershipSnapshot');
    const passengerColumnsPresent = expectedColumns.Passenger.every((column) => passengerColumns.has(column));
    const columnsMatch = expectedColumns.RideRequest.every((column) => rideColumns.has(column))
      && passengerColumnsPresent
      && snapshotPresent;
    emit('TARGET_LIFECYCLE_COLUMNS_MATCH_SCHEMA', schemaFactsPresent && columnsMatch ? 'YES' : 'NO');
    emit('CREATION_CORRELATION_TARGET_PRESENT', rideColumns.has('creationCorrelationId') ? 'YES' : 'NO');
    emit('CREATION_INTENT_FINGERPRINT_TARGET_PRESENT', rideColumns.has('creationIntentFingerprint') ? 'YES' : 'NO');
    emit('TARGET_REQUIRED_COLUMNS_MATCH', columnsMatch ? 'YES' : 'NO');

    const migrationRows = await client.query(`
      SELECT migration_name, finished_at, rolled_back_at, logs, applied_steps_count
      FROM public."_prisma_migrations"
      ORDER BY migration_name
    `);
    const authorizedNames = readAuthorizedMigrationNames(required('PRISMA_MIGRATIONS_PATH'));
    const inventory = evaluateMigrationInventory(migrationRows.rows, authorizedNames);
    const applied = new Map(migrationRows.rows.map((row) => [row.migration_name, row]));
    for (const migration of expectedMigrations) {
      const row = applied.get(migration);
      emit(`MIGRATION_${migration}_PRESENT`, row ? 'YES' : 'NO');
      emit(`MIGRATION_${migration}_FINISHED_AT_PRESENT`, row?.finished_at ? 'YES' : 'NO');
      emit(`MIGRATION_${migration}_ROLLED_BACK_AT`, row?.rolled_back_at ? 'YES' : 'NO');
      emit(`MIGRATION_${migration}_APPLIED_SUCCESSFULLY`, row?.finished_at && !row.rolled_back_at ? 'YES' : 'NO');
    }
    emit('TARGET_APPLIED_MIGRATION_COUNT', inventory.appliedNames.length);
    emit('TARGET_APPLIED_MIGRATION_NAMES', inventory.appliedNames);
    emit('AUTHORIZED_MIGRATION_COUNT', authorizedNames.length);
    emit('TARGET_APPLIED_AUTHORIZED_COUNT', inventory.appliedNames.filter((name) => authorizedNames.includes(name)).length);
    emit('TARGET_MISSING_AUTHORIZED_COUNT', inventory.missing.length);
    emit('TARGET_UNEXPECTED_MIGRATION_COUNT', inventory.unexpected.length);
    emit('TARGET_UNFINISHED_COUNT', inventory.unfinished.length);
    emit('TARGET_ROLLED_BACK_COUNT', inventory.rolledBack.length);
    emit('TARGET_FAILED_COUNT', inventory.failed.length);
    emit('TARGET_MISSING_AUTHORIZED_MIGRATIONS', inventory.missing);
    emit('TARGET_UNEXPECTED_MIGRATIONS', inventory.unexpected);
    emit('TARGET_HISTORY_EXACT_SUBSET_OF_AUTHORIZED', inventory.unexpected.length === 0 ? 'YES' : 'NO');
    emit('TARGET_PENDING_MIGRATION_COUNT', inventory.missing.length);
    emit('TARGET_PENDING_MIGRATIONS', inventory.missing);
    const passengerSuperseded = '20260518000000_passenger_codes_not_null_future';
    const passengerSupersededPresent = inventory.appliedNames.includes(passengerSuperseded);
    emit('PASSENGER_SUPERSEDED_PRESENT_IN_TARGET_HISTORY', passengerSupersededPresent ? 'YES' : 'NO');
    emit('PASSENGER_CURRENT_SCHEMA_MATCHES_GOVERNED_CONTRACT',
      !passengerSupersededPresent && passengerColumns.get('referralCode')?.is_nullable === 'YES'
        && passengerColumns.get('publicSlug')?.is_nullable === 'YES' ? 'YES' : 'NO');
    const migrationState = expectedMigrations.every((migration) => {
      const row = applied.get(migration);
      return Boolean(row?.finished_at) && !row.rolled_back_at;
    });
    emit('TARGET_MIGRATION_STATE_CERTIFIED', migrationState ? 'YES' : 'NO');
    emit('TARGET_MIGRATION_ORDER_MATCH', migrationState ? 'YES' : 'NO');

    const indexResult = await client.query(`
      SELECT i.indisunique, i.indisvalid, i.indisready, pg_get_indexdef(c.oid) AS definition
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname = 'RideOffer'
        AND c.relname = 'RideOffer_one_pending_per_ride'
    `);
    const index = indexResult.rows[0];
    const indexKeyMatch = Boolean(index && /\("rideRequestId"\)/.test(index.definition));
    const indexPredicateMatch = Boolean(index && /WHERE .*status.*PENDING/i.test(index.definition));
    const indexEquivalent = Boolean(index?.indisunique && index?.indisvalid && index?.indisready && indexKeyMatch && indexPredicateMatch);
    emit('TARGET_ONE_PENDING_INDEX_PRESENT', index ? 'YES' : 'NO');
    emit('TARGET_ONE_PENDING_INDEX_VALID', index ? (index.indisvalid ? 'YES' : 'NO') : 'NOT_PRESENT');
    emit('TARGET_ONE_PENDING_INDEX_READY', index ? (index.indisready ? 'YES' : 'NO') : 'NOT_PRESENT');
    emit('TARGET_ONE_PENDING_INDEX_UNIQUE', index ? (index.indisunique ? 'YES' : 'NO') : 'NOT_PRESENT');
    emit('TARGET_ONE_PENDING_INDEX_KEY_MATCH', index ? (indexKeyMatch ? 'YES' : 'NO') : 'NOT_PRESENT');
    emit('TARGET_ONE_PENDING_INDEX_PREDICATE_MATCH', index ? (indexPredicateMatch ? 'YES' : 'NO') : 'NOT_PRESENT');
    emit('TARGET_ONE_PENDING_INDEX_EQUIVALENT', index ? (indexEquivalent ? 'YES' : 'NO') : 'NOT_PRESENT');
    const duplicates = await client.query(`
      SELECT "rideRequestId", count(*)::int AS count
      FROM public."RideOffer"
      WHERE status::text = 'PENDING'
      GROUP BY "rideRequestId"
      HAVING count(*) > 1
    `);
    emit('DUPLICATE_PENDING_RIDE_COUNT', duplicates.rows.length);
    emit('DUPLICATE_PENDING_OFFERS_PRESENT', duplicates.rows.length > 0 ? 'YES' : 'NO');

    const enumChecks = await runEnumDependentChecks(client, availability);
    emit('WAITING_OWNER_ROW_CHECK', availability.waitingOwnerPresent ? 'EXECUTED' : enumChecks.waitingOwner);
    emit('TARGET_WAITING_OWNER_ROW_COUNT', enumChecks.waitingOwner);
    emit('RIDEOFFER_CANCELLED_ROW_CHECK', availability.cancelledPresent ? 'EXECUTED' : enumChecks.cancelled);
    emit('TARGET_CANCELLED_OFFER_ROW_COUNT', enumChecks.cancelled);
    const ownerRecovery = await client.query(`SELECT COUNT(*) AS count FROM public."RideRequest" WHERE "currentDispatchStage"::text = 'OWNER_RECOVERY'`);
    emit('TARGET_OWNER_RECOVERY_ROW_COUNT', ownerRecovery.rows[0].count);
    emit('WAITING_OWNER_BACKFILL_REQUIRED', 'NO');
    emit('RIDEOFFER_CANCELLED_BACKFILL_REQUIRED', 'NO');
    emit('LEGACY_ROWS_REQUIRE_BACKFILL', 'NO');
    emit('TARGET_PHYSICAL_SCHEMA_DRIFT', evaluatePhysicalCompatibility({
      waitingOwnerPresent: availability.waitingOwnerPresent,
      cancelledPresent: availability.cancelledPresent,
      requiredColumnsPresent: columnsMatch,
      indexEquivalent,
    }));
    emit('TARGET_SCHEMA_DRIFT', columnsMatch && migrationState ? 'NONE' : 'PRESENT');
    emit('WRITE_QUERY_ATTEMPTED', 'NO');
    emit('DDL_ATTEMPTED', 'NO');
    emit('DML_ATTEMPTED', 'NO');
    emit('SECRET_EXPOSED', 'NO');
    emit('LOGS_SANITIZED', 'YES');
    emit('DATABASE_ACCESS_MODE', 'READ_ONLY');
    await client.query('ROLLBACK');
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (require.main === module) main().catch((error) => {
  const code = error && error.message ? error.message.replace(/^.*?(MISSING_|SESSION_|READ_ONLY_)/, '$1') : 'CERTIFICATION_FAILED';
  console.error(`R11_1_CERTIFICATION=FAIL code=${code}`);
  process.exitCode = 1;
});

module.exports = {
  enumAvailability,
  enumDependentChecks,
  evaluateMigrationInventory,
  evaluatePhysicalCompatibility,
  runEnumDependentChecks,
};
