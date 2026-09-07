'use strict';
const fs = require('node:fs');
const { validateTarget, PROJECT_REF } = require('./supabase-target.cjs');

async function main() {
  for (const file of fs.readdirSync('.')) {
    if ((file === '.env' || file.startsWith('.env.')) && file !== '.env.example') throw new Error('ENV_FILE_FORBIDDEN');
  }
  for (const key of ['PRISMA_BOOTSTRAP_CONFIG', 'DOTENV_CONFIG_OVERRIDE', 'DOTENV_CONFIG_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    if (process.env[key]) throw new Error('ENV_OVERRIDE_FORBIDDEN');
  }
  // Validate both URLs before opening either connection.
  const targets = ['DATABASE_URL', 'DIRECT_URL'].map(key => ({ key, ...validateTarget(process.env[key]) }));
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
      await client.query('BEGIN READ ONLY');
      const { rows: [row] } = await client.query(`SELECT current_database() AS database,
        current_setting('server_version_num')::int AS version_num,
        current_setting('transaction_read_only') AS read_only,
        (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f','i','I')) AS relations,
        (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE n.nspname='public' AND t.typtype='e') AS enums,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public') AS routines,
        to_regclass('public._prisma_migrations')::text AS migrations`);
      if (row.database !== 'postgres' || Math.floor(row.version_num / 10000) !== 17
        || row.read_only !== 'on' || row.tls !== true || row.relations !== 0
        || row.enums !== 0 || row.routines !== 0 || row.migrations !== null) {
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
main().catch(() => {
  // Driver error messages can contain secrets: do not print raw errors or URLs.
  console.error('E2E_CONNECTION_PROOF=FAIL (check target, credentials, network, CA and initial state)');
  process.exitCode = 1;
});
