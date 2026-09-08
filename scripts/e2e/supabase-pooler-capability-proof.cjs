'use strict';

const fs = require('node:fs');
const { validateTarget, PROJECT_REF } = require('./supabase-target.cjs');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`POOLER_${name}_MISSING`);
  return value;
}

function classifyFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (code === '28P01' || code === '28000' || /password authentication|authentication failed|invalid password/i.test(message)) return 'AUTHENTICATION_FAILURE';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS_FAILURE';
  if (code === 'ETIMEDOUT' || /timeout/i.test(message)) return 'NETWORK_TIMEOUT';
  if (code === 'ECONNREFUSED') return 'CONNECTION_REFUSED';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'NETWORK_UNREACHABLE';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'CONNECTION_RESET';
  if (code.startsWith('CERT_') || /certificate|self[- ]signed|tls|ssl|unable to verify/i.test(message)) return 'TLS_FAILURE';
  return 'UNKNOWN_CONNECTION_FAILURE';
}

function safeCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[A-Z0-9_]+$/.test(code) ? code : 'NONE';
}

function emit(name, value) {
  console.error(`${name}=${value}`);
}

async function main() {
  for (const file of fs.readdirSync('.')) {
    if ((file === '.env' || file.startsWith('.env.')) && file !== '.env.example') throw new Error('ENV_FILE_FORBIDDEN');
  }
  for (const key of ['PRISMA_BOOTSTRAP_CONFIG', 'DOTENV_CONFIG_OVERRIDE', 'DOTENV_CONFIG_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    if (process.env[key]) throw new Error('ENV_OVERRIDE_FORBIDDEN');
  }

  const target = validateTarget(required('DATABASE_URL'));
  if (target.mode !== 'session') throw new Error('POOLER_SESSION_TARGET_REQUIRED');
  const ca = required('E2E_CA_CERT');
  const { Pool } = require('pg');
  const { PrismaClient } = require('@prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const pool = new Pool({
    connectionString: target.connectionString,
    ssl: { ca, rejectUnauthorized: true },
    connectionTimeoutMillis: 10000,
    options: '-c default_transaction_read_only=on',
    application_name: 'offer-book-e2e-pooler-capability-proof',
  });
  let prisma;
  let transactionOpen = false;
  try {
    const pgClient = await pool.connect();
    try {
      emit('POOLER_CONNECTION', 'PASS');
      emit('POOLER_TLS', pgClient.connection?.stream?.encrypted === true ? 'PASS' : 'FAIL');
      await pgClient.query('BEGIN READ ONLY');
      transactionOpen = true;
      const { rows: [state] } = await pgClient.query(`SELECT
        current_database() AS database,
        current_setting('server_version_num')::int AS version_num,
        current_setting('transaction_read_only') AS read_only,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f','i','I')) AS relations,
        (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE n.nspname='public' AND t.typtype='e') AS enums,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public') AS routines,
        to_regclass('public._prisma_migrations')::text AS migrations`);
      emit('POOLER_PG_VERSION', Math.floor(state.version_num / 10000) === 17 ? '17' : 'FAIL');
      emit('POOLER_READ_ONLY', state.read_only === 'on' ? 'PASS' : 'FAIL');
      const initialState = state.database === 'postgres' && state.relations === 0 && state.enums === 0
        && state.routines === 0 && state.migrations === null;
      emit('POOLER_INITIAL_STATE', initialState ? 'PASS' : 'FAIL');
      await pgClient.query('ROLLBACK');
      transactionOpen = false;
    } finally {
      if (transactionOpen) await pgClient.query('ROLLBACK').catch(() => {});
      pgClient.release();
    }

    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
    await prisma.$queryRaw`SELECT 1 AS connectivity_probe`;
    emit('POOLER_PRISMA_CONNECTIVITY', 'PASS');

    const prismaState = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const rows = await tx.$queryRaw`
        SELECT
          current_database() = 'postgres' AS database_ok,
          current_setting('transaction_read_only') = 'on' AS read_only_ok
      `;
      const state = rows[0];
      emit('POOLER_PRISMA_RESULT_SHAPE', Array.isArray(rows) && rows.length === 1
        && state && typeof state === 'object' ? 'PASS' : 'FAIL');
      return state;
    });
    emit('POOLER_PRISMA_DATABASE_ASSERTION', prismaState?.database_ok === true ? 'PASS' : 'FAIL');
    emit('POOLER_PRISMA_TRANSACTION_READ_ONLY', prismaState?.read_only_ok === true ? 'PASS' : 'FAIL');
    if (prismaState?.database_ok !== true || prismaState?.read_only_ok !== true) {
      throw new Error('POOLER_PRISMA_TRANSACTION_ASSERTION_FAILED');
    }
    emit('POOLER_CAPABILITY_PROOF', 'PASS');
  } catch (error) {
    emit('POOLER_CAPABILITY_PROOF', `FAIL category=${classifyFailure(error)} code=${safeCode(error)}`);
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    await pool.end().catch(() => {});
  }
}

main().catch((error) => {
  emit('POOLER_CAPABILITY_PROOF', `FAIL category=${classifyFailure(error)} code=${safeCode(error)}`);
  process.exitCode = 1;
});
