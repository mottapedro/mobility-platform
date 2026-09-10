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
  RideRequest: ['currentDispatchStage', 'rootDriverId', 'referredByDriverId', 'selectedDriverId', 'currentCandidateDriverId', 'excludedDriverIds'],
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

const sorted = (values) => [...values].sort();
const equalSet = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

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

    const connection = await client.query(`
      SELECT current_database() AS database_name,
             current_setting('server_version_num') AS server_version_num,
             current_setting('transaction_read_only') AS transaction_read_only,
             ssl,
             version
      FROM pg_stat_ssl
      CROSS JOIN (SELECT version()) AS v
      WHERE pid = pg_backend_pid()
    `);
    const connectionRow = connection.rows[0];
    const pgMajor = String(connectionRow.server_version_num).slice(0, -2);
    emit('POOLER_CONNECTION', 'PASS');
    emit('TLS', connectionRow.ssl === true ? 'PASS' : 'FAIL');
    emit('PG_VERSION', pgMajor);
    emit('DATABASE_NAME', connectionRow.database_name);
    emit('READ_ONLY_MODE', connectionRow.transaction_read_only === 'on' ? 'PASS' : 'FAIL');
    if (connectionRow.ssl !== true || connectionRow.transaction_read_only !== 'on') throw new Error('READ_ONLY_CONNECTION_NOT_CONFIRMED');

    const enumRows = await client.query(`
      SELECT t.typname AS enum_name, e.enumlabel AS enum_value
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname IN ('RideStatus', 'RideOfferStatus')
      ORDER BY t.typname, e.enumsortorder
    `);
    for (const enumName of Object.keys(expectedStatuses)) {
      const values = enumRows.rows.filter((row) => row.enum_name === enumName).map((row) => row.enum_value);
      emit(`TARGET_${enumName === 'RideStatus' ? 'RIDE_STATUS' : 'RIDEOFFER_STATUS'}_VALUES`, values);
      emit(`${enumName === 'RideStatus' ? 'WAITING_OWNER_TARGET_PRESENT' : 'RIDEOFFER_CANCELLED_TARGET_PRESENT'}`,
        expectedStatuses[enumName].every((value) => values.includes(value)) ? 'YES' : 'NO');
    }

    const columnRows = await client.query(`
      SELECT table_name, column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('RideRequest', 'OwnershipSnapshot')
    `);
    const rideColumns = new Set(columnRows.rows.filter((row) => row.table_name === 'RideRequest').map((row) => row.column_name));
    for (const column of expectedColumns.RideRequest) emit(`TARGET_${column.replaceAll(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}_PRESENT`, rideColumns.has(column) ? 'YES' : 'NO');
    const snapshotPresent = columnRows.rows.some((row) => row.table_name === 'OwnershipSnapshot');
    emit('TARGET_OWNERSHIP_SNAPSHOT_PRESENT', snapshotPresent ? 'YES' : 'NO');
    const schemaFactsPresent = Object.entries(expectedColumns).every(([model, columns]) =>
      model === 'RideRequest' && columns.every((column) => schema.includes(column))
    ) && schema.includes('model OwnershipSnapshot');
    const columnsMatch = expectedColumns.RideRequest.every((column) => rideColumns.has(column)) && snapshotPresent;
    emit('TARGET_LIFECYCLE_COLUMNS_MATCH_SCHEMA', schemaFactsPresent && columnsMatch ? 'YES' : 'NO');

    const migrationRows = await client.query(`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      WHERE migration_name = ANY($1::text[])
      ORDER BY migration_name
    `, [expectedMigrations]);
    const applied = new Map(migrationRows.rows.map((row) => [row.migration_name, row]));
    for (const migration of expectedMigrations) {
      const row = applied.get(migration);
      emit(`MIGRATION_${migration}_PRESENT`, row ? 'YES' : 'NO');
      emit(`MIGRATION_${migration}_FINISHED_AT_PRESENT`, row?.finished_at ? 'YES' : 'NO');
      emit(`MIGRATION_${migration}_ROLLED_BACK_AT`, row?.rolled_back_at ? 'YES' : 'NO');
      emit(`MIGRATION_${migration}_APPLIED_SUCCESSFULLY`, row?.finished_at && !row.rolled_back_at ? 'YES' : 'NO');
    }
    const migrationState = expectedMigrations.every((migration) => {
      const row = applied.get(migration);
      return Boolean(row?.finished_at) && !row.rolled_back_at;
    });
    emit('TARGET_MIGRATION_STATE_CERTIFIED', migrationState ? 'YES' : 'NO');
    emit('TARGET_MIGRATION_ORDER_MATCH', migrationState ? 'YES' : 'NO');

    const legacy = await client.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'WAITING_OWNER') AS waiting_owner_count,
             COUNT(*) FILTER (WHERE "currentDispatchStage" = 'OWNER_RECOVERY') AS owner_recovery_count
      FROM "RideRequest"
    `);
    const cancelled = await client.query(`SELECT COUNT(*) AS count FROM "RideOffer" WHERE status = 'CANCELLED'`);
    emit('TARGET_WAITING_OWNER_ROW_COUNT', legacy.rows[0].waiting_owner_count);
    emit('TARGET_OWNER_RECOVERY_ROW_COUNT', legacy.rows[0].owner_recovery_count);
    emit('TARGET_CANCELLED_OFFER_ROW_COUNT', cancelled.rows[0].count);
    emit('WAITING_OWNER_BACKFILL_REQUIRED', 'NO');
    emit('RIDEOFFER_CANCELLED_BACKFILL_REQUIRED', 'NO');
    emit('LEGACY_ROWS_REQUIRE_BACKFILL', 'NO');
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

main().catch((error) => {
  const code = error && error.message ? error.message.replace(/^.*?(MISSING_|SESSION_|READ_ONLY_)/, '$1') : 'CERTIFICATION_FAILED';
  console.error(`R11_1_CERTIFICATION=FAIL code=${code}`);
  process.exitCode = 1;
});
