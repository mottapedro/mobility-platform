'use strict';

const { Client } = require('pg');

const PASSENGER_SUPERSEDED = '20260518000000_passenger_codes_not_null_future';

function output(name, value) {
  console.log(`${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, `${name.toLowerCase()}=${value}\n`);
  }
}

function fail(message) {
  console.error(`EPHEMERAL_MIGRATION_AUDIT=FAIL`);
  console.error(`FAILURE=${message}`);
  output('ephemeral_migration_audit', 'FAIL');
  process.exitCode = 1;
}

function expectedTarget() {
  return {
    protocol: 'postgresql:',
    host: process.env.EPHEMERAL_PG_HOST || 'postgres',
    port: Number(process.env.EPHEMERAL_PG_PORT || 5432),
    database: process.env.EPHEMERAL_PG_DATABASE || 'mobility_replay',
  };
}

function validateTarget(rawUrl) {
  if (!rawUrl || process.env.DIRECT_URL) throw new Error('EXTERNAL_DATASOURCE_OR_DIRECT_URL_PRESENT');
  const url = new URL(rawUrl);
  const expected = expectedTarget();
  if (url.protocol !== expected.protocol || url.hostname !== expected.host
    || Number(url.port || 5432) !== expected.port || url.pathname !== `/${expected.database}`) {
    throw new Error('DATABASE_URL_IS_NOT_THE_EXPECTED_EPHEMERAL_TARGET');
  }
  if (url.hostname !== 'postgres' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('NON_LOCAL_DATABASE_HOST');
  }
  return url;
}

function catalogNames(catalog) {
  const fs = require('node:fs');
  if (!catalog || !fs.existsSync(catalog)) throw new Error('AUTHORIZED_CATALOG_PATH_REQUIRED');
  const names = fs.readdirSync(catalog, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(`${catalog}/${entry.name}/migration.sql`))
    .map((entry) => entry.name).sort();
  if (!names.length) throw new Error('AUTHORIZED_CATALOG_EMPTY');
  return names;
}

function expectedNames() {
  if (process.env.PRISMA_MIGRATIONS_PATH) return catalogNames(process.env.PRISMA_MIGRATIONS_PATH);
  const value = process.env.EXPECTED_MIGRATION_NAMES;
  if (!value) throw new Error('EXPECTED_MIGRATION_NAMES_REQUIRED');
  return value.split(',').map((name) => name.trim()).filter(Boolean).sort();
}

function evaluateMigrationHistory(rows, names) {
  const applied = rows.map((row) => row.migration_name).sort();
  const expected = new Set(names);
  const appliedSet = new Set(applied);
  const missing = names.filter((name) => !appliedSet.has(name));
  const unexpected = applied.filter((name) => !expected.has(name));
  const unfinished = rows.filter((row) => !row.finished_at && !row.rolled_back_at && !row.logs);
  const rolledBack = rows.filter((row) => row.rolled_back_at);
  const failed = rows.filter((row) => row.logs);
  const passengerPresent = appliedSet.has(PASSENGER_SUPERSEDED);
  return {
    expectedCount: names.length,
    actualCount: applied.length,
    missing,
    unexpected,
    unfinished,
    rolledBack,
    failed,
    passengerPresent,
    valid: missing.length === 0 && unexpected.length === 0 && unfinished.length === 0
      && rolledBack.length === 0 && failed.length === 0 && !passengerPresent,
  };
}

async function main() {
  const names = expectedNames();
  const url = validateTarget(process.env.DATABASE_URL);
  const client = new Client({ connectionString: url.toString(), ssl: false });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(`
      SELECT migration_name, finished_at, rolled_back_at, logs
      FROM public."_prisma_migrations"
      ORDER BY migration_name
    `);
    const evidence = evaluateMigrationHistory(rows, names);

    output('expected_count', evidence.expectedCount);
    output('actual_count', evidence.actualCount);
    output('missing_count', evidence.missing.length);
    output('unexpected_count', evidence.unexpected.length);
    output('unfinished_count', evidence.unfinished.length);
    output('rolled_back_count', evidence.rolledBack.length);
    output('failed_count', evidence.failed.length);
    output('passenger_superseded_present', evidence.passengerPresent ? 'YES' : 'NO');
    output('missing_migrations', evidence.missing.join(',') || 'NONE');
    output('unexpected_migrations', evidence.unexpected.join(',') || 'NONE');

    if (!evidence.valid) {
      fail('EXACT_HISTORY_CONTRACT_FAILED');
      await client.query('ROLLBACK');
      return;
    }
    output('ephemeral_migration_audit', 'PASS');
    await client.query('ROLLBACK');
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    try { await client.query('ROLLBACK'); } catch {}
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => fail(error.message));

module.exports = { validateTarget, expectedTarget, expectedNames, evaluateMigrationHistory };
