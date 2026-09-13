'use strict';

const { Client } = require('pg');

const PENDING = [
  '20260813000000_add_auth_sessions',
  '20260813010000_seed_skill_catalog_reference_data',
  '20260817000000_ride_scheduled_at_nullable',
  '20260817000001_add_ride_place_ids',
  '20260817000002_add_ride_quote_contract',
  '20260817000003_add_driver_base_current_location_offer_snapshot',
  '20260824000000_add_ride_offer_history_index',
  '20260909000000_add_ride_creation_correlation',
  '20260909000001_add_ride_creation_intent_fingerprint',
  '20260910000000_add_waiting_owner_ride_status',
  '20260910000001_add_cancelled_ride_offer_status',
  '20260911000000_restore_one_pending_offer_per_ride',
].sort();

function fail(message) {
  console.error(`EPHEMERAL_REPLAY_PROOF=FAIL`);
  console.error(`FAILURE=${message}`);
  process.exitCode = 1;
}

function expectedTarget() {
  return {
    host: process.env.EPHEMERAL_PG_HOST || 'postgres',
    port: Number(process.env.EPHEMERAL_PG_PORT || 5432),
    database: process.env.EPHEMERAL_PG_DATABASE || 'mobility_replay',
  };
}

function validateTarget() {
  const raw = process.env.DATABASE_URL;
  if (!raw || process.env.DIRECT_URL) throw new Error('EXTERNAL_DATASOURCE_OR_DIRECT_URL_PRESENT');
  const url = new URL(raw);
  const expected = expectedTarget();
  if (url.protocol !== 'postgresql:' || url.hostname !== expected.host
    || Number(url.port || 5432) !== expected.port || url.pathname !== `/${expected.database}`) {
    throw new Error('DATABASE_URL_IS_NOT_THE_EXPECTED_EPHEMERAL_TARGET');
  }
  return url;
}

async function withReadOnlyClient(callback) {
  const client = new Client({ connectionString: validateTarget().toString(), ssl: false });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await callback(client);
    await client.query('ROLLBACK');
  } finally {
    await client.end().catch(() => {});
  }
}

async function preDeploy(client) {
  const { rows } = await client.query(`
    SELECT migration_name, finished_at, rolled_back_at, logs
    FROM public."_prisma_migrations"
    ORDER BY migration_name
  `);
  const catalog = process.env.PRISMA_MIGRATIONS_PATH;
  if (!catalog) throw new Error('PRISMA_MIGRATIONS_PATH_REQUIRED');
  const fs = require('node:fs');
  const all = fs.readdirSync(catalog, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(`${catalog}/${entry.name}/migration.sql`))
    .map((entry) => entry.name).sort();
  const evidence = evaluatePreDeployHistory(rows, all);
  for (const [key, value] of Object.entries(evidence)) console.log(`${key}=${value}`);
  if (evidence.PRE_DEPLOY_HISTORY_VALID !== 'YES') {
    throw new Error('PRE_DEPLOY_HISTORY_FAILED see PRE_DEPLOY evidence');
  }
  console.log('PRE_DEPLOY_APPLIED_MIGRATION_COUNT=44');
  console.log('PENDING_EXACT_SET_MATCH=YES');
}

function evaluatePreDeployHistory(rows, authorizedNames) {
  const appliedSet = new Set(rows.map((row) => row.migration_name));
  const authorizedSet = new Set(authorizedNames);
  const expectedPendingSet = new Set(PENDING);
  const expectedAppliedSet = new Set([...authorizedSet].filter((name) => !expectedPendingSet.has(name)));
  const actualPendingSet = new Set([...authorizedSet].filter((name) => !appliedSet.has(name)));
  const differenceCount = (left, right) => [...left].filter((name) => !right.has(name)).length;
  const missingApplied = differenceCount(expectedAppliedSet, appliedSet);
  const unexpectedApplied = differenceCount(appliedSet, expectedAppliedSet);
  const missingPending = differenceCount(expectedPendingSet, actualPendingSet);
  const unexpectedPending = differenceCount(actualPendingSet, expectedPendingSet);
  // A failed row with logs is still unfinished; logs must not hide it.
  const unfinished = rows.filter((row) => !row.finished_at).length;
  const rolledBack = rows.filter((row) => row.rolled_back_at).length;
  const superseded = '20260518000000_passenger_codes_not_null_future';
  const supersededPresent = authorizedSet.has(superseded) || appliedSet.has(superseded);
  const appliedExact = missingApplied === 0 && unexpectedApplied === 0 && rows.length === appliedSet.size;
  const pendingExact = missingPending === 0 && unexpectedPending === 0;
  const valid = authorizedNames.length === 56 && authorizedSet.size === 56
    && expectedPendingSet.size === 12 && expectedAppliedSet.size === 44
    && rows.length === 44 && appliedExact && actualPendingSet.size === 12 && pendingExact
    && unfinished === 0 && rolledBack === 0 && !supersededPresent;
  return {
    PRE_DEPLOY_AUTHORIZED_COUNT: authorizedSet.size,
    PRE_DEPLOY_EXPECTED_APPLIED_COUNT: expectedAppliedSet.size,
    PRE_DEPLOY_APPLIED_COUNT: rows.length,
    PRE_DEPLOY_APPLIED_EXACT_MATCH: appliedExact ? 'YES' : 'NO',
    PRE_DEPLOY_MISSING_APPLIED_COUNT: missingApplied,
    PRE_DEPLOY_UNEXPECTED_APPLIED_COUNT: unexpectedApplied,
    PRE_DEPLOY_PENDING_COUNT: actualPendingSet.size,
    PRE_DEPLOY_PENDING_EXACT_MATCH: pendingExact ? 'YES' : 'NO',
    PRE_DEPLOY_MISSING_PENDING_COUNT: missingPending,
    PRE_DEPLOY_UNEXPECTED_PENDING_COUNT: unexpectedPending,
    PRE_DEPLOY_UNFINISHED_COUNT: unfinished,
    PRE_DEPLOY_ROLLED_BACK_COUNT: rolledBack,
    PRE_DEPLOY_PASSENGER_SUPERSEDED_PRESENT: supersededPresent ? 'YES' : 'NO',
    PRE_DEPLOY_HISTORY_VALID: valid ? 'YES' : 'NO',
  };
}

async function physical(client) {
  const enumRows = await client.query(`
    SELECT t.typname, e.enumlabel
    FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
    JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname IN ('RideStatus','RideOfferStatus')
  `);
  const labels = new Map();
  for (const row of enumRows.rows) labels.set(row.typname, [...(labels.get(row.typname) || []), row.enumlabel]);
  const columns = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND ((table_name='RideRequest' AND column_name IN ('creationCorrelationId','creationIntentFingerprint')))
  `);
  const columnSet = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
  const index = await client.query(`
    SELECT c.relname AS index_name, i.indisunique, i.indisvalid, i.indisready,
      pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
    JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname='RideOffer' AND c.relname='RideOffer_one_pending_per_ride'
  `);
  const pendingGroups = await client.query(`
    SELECT "rideRequestId", count(*)::int AS count
    FROM public."RideOffer" WHERE status='PENDING'
    GROUP BY "rideRequestId" HAVING count(*) > 1
  `);
  const idx = index.rows[0];
  const indexPass = idx && idx.indisunique && idx.indisvalid && idx.indisready
    && /\("rideRequestId"\)/.test(idx.definition) && /WHERE .*status.*PENDING/i.test(idx.definition);
  if (!labels.get('RideStatus')?.includes('WAITING_OWNER') || !labels.get('RideOfferStatus')?.includes('CANCELLED')
    || !columnSet.has('RideRequest.creationCorrelationId') || !columnSet.has('RideRequest.creationIntentFingerprint')
    || !indexPass || pendingGroups.rows.length !== 0) {
    throw new Error('PHYSICAL_SCHEMA_OR_INDEX_PROOF_FAILED');
  }
  console.log('PHYSICAL_SCHEMA_PROOF=PASS');
  console.log('ONE_PENDING_INDEX_PROOF=PASS');
  console.log('DUPLICATE_PENDING_GROUPS=0');
}

if (require.main === module) {
  const mode = process.argv[2];
  if (!['--pre-deploy', '--physical'].includes(mode)) {
    fail('MODE_REQUIRED');
  } else {
    withReadOnlyClient((client) => mode === '--pre-deploy' ? preDeploy(client) : physical(client))
      .catch((error) => fail(error instanceof Error ? error.message : String(error)));
  }
}

module.exports = { validateTarget, expectedTarget, evaluatePreDeployHistory };
