'use strict';

const fs = require('node:fs');
const { Client } = require('pg');
const { validateTarget, PROJECT_REF } = require('./supabase-target.cjs');

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
};

const EMISSION_KEYS = [
  'POOLER_CONNECTION',
  'CLIENT_TLS_ENCRYPTED',
  'CLIENT_TLS_AUTHORIZED',
  'BACKEND_PG_STAT_SSL',
  'TLS',
  'PG_VERSION',
  'DATABASE_NAME',
  'READ_ONLY_MODE',
  'DATABASE_READ_ONLY_ENFORCEMENT',
  'TARGET_PROVIDER',
  'TARGET_PROJECT_ID',
  'TARGET_DATABASE_NAME',
  'TARGET_HOST_CLASS',
  'TARGET_IS_SUPABASE_E2E',
  'TARGET_IS_PRODUCTION',
  'TARGET_IS_OTHER_HML',
  'POSTGRES_VERSION',
  'DATABASE_URL_USED',
  'DIRECT_URL_USED',
  'EXPIRED_OFFER_SCAN',
  'EXPIRED_OFFER_ROW_COUNT',
  'EXPIRED_OFFER_DISTINCT_RIDE_REQUEST_COUNT',
  'EXPIRED_OFFER_DISTINCT_DRIVER_COUNT',
  'EXPIRED_OFFER_FRESH_WITHIN_24H_COUNT',
  'EXPIRED_OFFER_STALE_COUNT',
  'EXPIRED_OFFERS_BY_RIDE_STATUS',
  'EXPIRED_OFFERS_BY_DISPATCH_STAGE',
  'EXPIRED_OFFER_DISCOVERY_PAYLOAD',
  'EXPIRED_OFFER_DISCOVERY_PAYLOAD_ROWS',
  'ORIGIN_DESTINATION_PII_EXPOSURE',
  'WRITE_QUERY_ATTEMPTED',
  'DDL_ATTEMPTED',
  'DML_ATTEMPTED',
  'SECRET_EXPOSED',
  'LOGS_SANITIZED',
  'DATABASE_ACCESS_MODE',
  'MIGRATE_DEPLOY_AUTHORITY',
  'EXPIRED_OFFER_DISCOVERY_RESULT',
];

function emit(key, value) {
  if (!EMISSION_KEYS.includes(key)) throw new Error('EMISSION_KEY_NOT_ALLOWLISTED');
  const normalized = Array.isArray(value) ? value.join(',') : String(value);
  console.log(`${key}=${normalized}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key.toLowerCase()}=${normalized}\n`);
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
             ssl
      FROM pg_stat_ssl
      WHERE pid = pg_backend_pid()
    `);
    const connectionRow = connection.rows[0];
    const pgMajor = Math.floor(Number(connectionRow.server_version_num) / 10000);
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
    if (connectionRow.transaction_read_only !== 'on') throw new Error('READ_ONLY_ENFORCEMENT_FAILURE');
    emit('DATABASE_READ_ONLY_ENFORCEMENT', 'PASS');

    const identityValid = target.projectRef === PROJECT_REF
      && target.mode === 'session'
      && connectionRow.database_name === 'postgres'
      && pgMajor === 17;
    emit('TARGET_PROVIDER', 'Supabase');
    emit('TARGET_PROJECT_ID', target.projectRef);
    emit('TARGET_DATABASE_NAME', connectionRow.database_name);
    emit('TARGET_HOST_CLASS', target.mode === 'session' ? 'SESSION_POOLER' : 'REJECTED');
    emit('TARGET_IS_SUPABASE_E2E', identityValid ? 'YES' : 'NO');
    emit('TARGET_IS_PRODUCTION', identityValid ? 'NO' : 'UNKNOWN');
    emit('TARGET_IS_OTHER_HML', identityValid ? 'NO' : 'UNKNOWN');
    emit('POSTGRES_VERSION', pgMajor);
    emit('DATABASE_URL_USED', 'YES');
    emit('DIRECT_URL_USED', 'NO');
    if (!identityValid) throw new Error('TARGET_IDENTITY_FAILURE');

    const counters = await client.query(`
      SELECT count(*)::int AS expired_count,
             count(DISTINCT "rideRequestId")::int AS distinct_rides,
             count(DISTINCT "driverId")::int AS distinct_drivers,
             count(*) FILTER (WHERE "expiresAt" >= now() - interval '24 hours')::int AS fresh_count,
             count(*) FILTER (WHERE "expiresAt" < now() - interval '24 hours')::int AS stale_count
      FROM public."RideOffer"
      WHERE status::text = 'EXPIRED'
    `);
    const counts = counters.rows[0];
    emit('EXPIRED_OFFER_SCAN', 'EXECUTED');
    emit('EXPIRED_OFFER_ROW_COUNT', counts.expired_count);
    emit('EXPIRED_OFFER_DISTINCT_RIDE_REQUEST_COUNT', counts.distinct_rides);
    emit('EXPIRED_OFFER_DISTINCT_DRIVER_COUNT', counts.distinct_drivers);
    emit('EXPIRED_OFFER_FRESH_WITHIN_24H_COUNT', counts.fresh_count);
    emit('EXPIRED_OFFER_STALE_COUNT', counts.stale_count);

    const lifecycle = await client.query(`
      SELECT rr.status::text AS ride_status,
             rr."currentDispatchStage"::text AS dispatch_stage,
             count(DISTINCT o."rideRequestId")::int AS rides,
             count(*)::int AS offers
      FROM public."RideOffer" o
      JOIN public."RideRequest" rr ON rr.id = o."rideRequestId"
      WHERE o.status::text = 'EXPIRED'
      GROUP BY rr.status::text, rr."currentDispatchStage"::text
      ORDER BY rr.status::text, rr."currentDispatchStage"::text
    `);
    const byRideStatus = {};
    const byDispatchStage = {};
    for (const row of lifecycle.rows) {
      byRideStatus[row.ride_status] = (byRideStatus[row.ride_status] || 0) + row.offers;
      const stageValue = row.dispatch_stage === null ? 'UNASSIGNED' : row.dispatch_stage;
      byDispatchStage[stageValue] = (byDispatchStage[stageValue] || 0) + row.offers;
    }
    emit('EXPIRED_OFFERS_BY_RIDE_STATUS', JSON.stringify(byRideStatus));
    emit('EXPIRED_OFFERS_BY_DISPATCH_STAGE', JSON.stringify(byDispatchStage));

    const payload = await client.query(`
      SELECT o.id AS offer_id,
             o."rideRequestId" AS ride_request_id,
             rr.status::text AS ride_status,
             rr."currentDispatchStage"::text AS dispatch_stage
      FROM public."RideOffer" o
      JOIN public."RideRequest" rr ON rr.id = o."rideRequestId"
      WHERE o.status::text = 'EXPIRED'
      ORDER BY o.id
      LIMIT 200
    `);
    emit('EXPIRED_OFFER_DISCOVERY_PAYLOAD_ROWS', payload.rows.length);
    emit('EXPIRED_OFFER_DISCOVERY_PAYLOAD', JSON.stringify(payload.rows));

    emit('ORIGIN_DESTINATION_PII_EXPOSURE', 'NONE_EMITTED');
    emit('WRITE_QUERY_ATTEMPTED', 'NO');
    emit('DDL_ATTEMPTED', 'NO');
    emit('DML_ATTEMPTED', 'NO');
    emit('SECRET_EXPOSED', 'NO');
    emit('LOGS_SANITIZED', 'YES');
    emit('DATABASE_ACCESS_MODE', 'READ_ONLY');
    emit('MIGRATE_DEPLOY_AUTHORITY', 'DENIED');
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
  emit('EXPIRED_OFFER_DISCOVERY_RESULT', 'PASS');
}

if (require.main === module) main().catch((error) => {
  const code = /^[A-Z_]+$/.test(error?.message || '') ? error.message : 'DISCOVERY_FAILED';
  console.error(`EXPIRED_OFFER_DISCOVERY=FAIL code=${code}`);
  process.exitCode = 1;
});

module.exports = { EMISSION_KEYS };