'use strict';
const fs = require('node:fs');
const { validateTarget, targetDiagnostics, PROJECT_REF } = require('./supabase-target.cjs');

function classifyFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message === 'E2E_TARGET_REJECTED' || message === 'ENV_FILE_FORBIDDEN' || message === 'ENV_OVERRIDE_FORBIDDEN') {
    return 'TARGET_REJECTED';
  }
  if (message === 'E2E_INITIAL_STATE_REJECTED') return 'DATABASE_STATE_FAILURE';
  if (code === '28P01' || code === '28000') return 'AUTHENTICATION_FAILURE';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return 'NETWORK_FAILURE';
  }
  if (code.startsWith('CERT_') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return 'TLS_FAILURE';
  }
  return 'CONNECTION_FAILURE';
}

function databaseStateChecks(row) {
  return {
    DATABASE_STATE_DATABASE: row.database === 'postgres',
    DATABASE_STATE_PG17: Math.floor(row.version_num / 10000) === 17,
    DATABASE_STATE_READ_ONLY: row.read_only === 'on',
    DATABASE_STATE_TLS: row.tls === true,
    DATABASE_STATE_PUBLIC_SCOPE: row.relations === 0 && row.enums === 0 && row.routines === 0,
    DATABASE_STATE_PRISMA_MIGRATIONS: row.migrations === null,
  };
}

function printDatabaseStateChecks(checks) {
  for (const [name, passed] of Object.entries(checks)) {
    console.error(`${name}=${passed ? 'PASS' : 'FAIL'}`);
  }
  console.error(`TLS_SOCKET=${checks.DATABASE_STATE_TLS ? 'PASS' : 'FAIL'}`);
}

function printTargetDiagnostics(checks) {
  for (const [name, value] of Object.entries(checks)) {
    console.error(`${name}=${typeof value === 'boolean' ? (value ? 'PASS' : 'FAIL') : value}`);
  }
}

async function main() {
  for (const file of fs.readdirSync('.')) {
    if ((file === '.env' || file.startsWith('.env.')) && file !== '.env.example') throw new Error('ENV_FILE_FORBIDDEN');
  }
  for (const key of ['PRISMA_BOOTSTRAP_CONFIG', 'DOTENV_CONFIG_OVERRIDE', 'DOTENV_CONFIG_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    if (process.env[key]) throw new Error('ENV_OVERRIDE_FORBIDDEN');
  }
  // Validate both URLs before opening either connection.
  const targetInputs = ['DATABASE_URL', 'DIRECT_URL'].map(key => ({ key, value: process.env[key] }));
  let targets;
  try {
    targets = targetInputs.map(({ key, value }) => ({ key, ...validateTarget(value) }));
  } catch (error) {
    printTargetDiagnostics(targetDiagnostics(targetInputs));
    throw error;
  }
  if (process.argv.includes('--guard-only')) {
    console.log('E2E_TARGET_GUARDS=PASS');
    return;
  }
  const { Client } = require('pg');
  const evidence = [];
  for (const target of targets) {
    const client = new Client({
      connectionString: target.connectionString,
      ssl: { rejectUnauthorized: true, ...(process.env.E2E_CA_CERT ? { ca: process.env.E2E_CA_CERT } : {}) },
      connectionTimeoutMillis: 15000,
      query_timeout: 15000,
      statement_timeout: 10000,
      options: '-c default_transaction_read_only=on',
      application_name: 'offer-book-e2e-connection-proof',
    });
    try {
      await client.connect();
      const tlsSocket = client.connection?.stream?.encrypted === true;
      await client.query('BEGIN READ ONLY');
      const { rows: [row] } = await client.query(`SELECT current_database() AS database,
        current_setting('server_version_num')::int AS version_num,
        current_setting('transaction_read_only') AS read_only,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f','i','I')) AS relations,
        (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE n.nspname='public' AND t.typtype='e') AS enums,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public') AS routines,
        to_regclass('public._prisma_migrations')::text AS migrations`);
      row.tls = tlsSocket;
      const checks = databaseStateChecks(row);
      if (Object.values(checks).some((passed) => !passed)) {
        printDatabaseStateChecks(checks);
        throw new Error('E2E_INITIAL_STATE_REJECTED');
      }
      await client.query('ROLLBACK');
      evidence.push({ variable: target.key, mode: target.mode, project: PROJECT_REF, ...row });
    } finally {
      await client.end().catch(() => {});
    }
  }
  console.log(JSON.stringify({ result: 'PASS', commit: process.env.GITHUB_SHA, evidence, bootstrapExecuted: false }));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\nConnection proof: PASS\n\nProject: ${PROJECT_REF}\n\nCommit: ${process.env.GITHUB_SHA}\n\nPG17, TLS and empty public scope verified for both URLs. No bootstrap executed.\n`);
}
main().catch((error) => {
  // Driver error messages can contain secrets: do not print raw errors or URLs.
  console.error(`E2E_CONNECTION_PROOF=${classifyFailure(error)}`);
  process.exitCode = 1;
});
