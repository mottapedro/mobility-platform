'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const BASELINE_MIGRATION = '20260101000000_init_baseline';
const BASELINE_SQL_PATH = path.join(REPOSITORY_ROOT, 'prisma', 'migrations', BASELINE_MIGRATION, 'migration.sql');
const BASELINE_SQL_SHA256 = '84e8350d60cf6fc917e8187a6df74871b885b1587149d7ad725c7cf7a213d814';
const AUTHORIZED_CATALOG_FINGERPRINT = '8419634934bf3ef9c91c37a0e2a3743b8995cbac9120afcd078d5165a39189aa';
const EXPECTED_DATABASE = 'mobility';
const EXPECTED_POSTGRES_MAJOR = 15;
const EXPECTED_PRISMA_VERSION = '7.8.0';
const EXPECTED_TSX_VERSION = '4.22.3';
const CATALOG_TEMP_PREFIX = 'r7c-r13-authorized-catalog-';
const PRISMA_ENV_ALLOWLIST = new Set([
  'path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'appdata',
  'localappdata', 'home', 'pathext', 'comspec',
]);
const OPERATIONS = Object.freeze([
  'targetIdentity',
  'emptyState',
  'migrationTable',
  'baseline',
  'baselineLedger',
]);

const EMPTY_STATE_SQL = `
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public')
      AND nspname NOT LIKE 'pg_toast%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND t.typtype <> 'p'
  )
  AND NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql')
THEN 0 ELSE 1 END AS nonempty;
`;

const MIGRATION_TABLE_SQL = `
SELECT CASE WHEN to_regclass('public._prisma_migrations') IS NULL THEN 0 ELSE 1 END AS present;
`;

function assertOperation(operation) {
  if (!OPERATIONS.includes(operation)) throw new Error('E: INVALID_OPERATION');
}

function buildCommandSet() {
  return Object.freeze(Object.fromEntries(OPERATIONS.map((operation) => [
    operation,
    Object.freeze({
      executable: process.execPath,
      args: Object.freeze([__filename, operation]),
    }),
  ])));
}

function requiredDatabaseUrl(env) {
  const value = env.DATABASE_URL;
  if (typeof value !== 'string' || value.trim() === '') throw new Error('E: DATABASE_URL_REQUIRED');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('E: DATABASE_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('E: DATABASE_URL_INVALID');
  let databaseName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('E: DATABASE_URL_INVALID');
  }
  if (databaseName !== EXPECTED_DATABASE) {
    throw new Error('E: DATABASE_NAME_MISMATCH');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('E: NONLOCAL_ENDPOINT_REJECTED');
  if (!parsed.port || Number(parsed.port) < 1 || Number(parsed.port) > 65535) throw new Error('E: EXPLICIT_LOCAL_PORT_REQUIRED');
  for (const key of ['host', 'hostaddr', 'port', 'service', 'options']) {
    if (parsed.searchParams.has(key)) throw new Error('E: DATABASE_URL_OVERRIDE_PARAMETER_REJECTED');
  }
  return value;
}

function baselineSqlBytes() {
  const bytes = fs.readFileSync(BASELINE_SQL_PATH);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== BASELINE_SQL_SHA256) throw new Error('E: BASELINE_SQL_IDENTITY_MISMATCH');
  return bytes.toString('utf8');
}

function createPgClient(connectionString) {
  const { Client } = require('pg');
  return new Client({ connectionString });
}

async function withClient(connectionString, deps, action) {
  const client = (deps.createClient || createPgClient)(connectionString);
  let actionFailed = false;
  try {
    await client.connect();
    return await action(client);
  } catch (error) {
    actionFailed = true;
    throw error;
  } finally {
    try {
      await client.end();
    } catch {
      if (!actionFailed) throw new Error('E: DATABASE_CLIENT_CLOSE_FAILED');
    }
  }
}

async function targetIdentity(client) {
  const result = await client.query(`
    SELECT current_database() AS database_name,
           current_setting('server_version_num')::integer AS server_version_num,
           inet_server_addr()::text AS server_address,
           inet_server_port() AS server_port;
  `);
  const row = result.rows?.[0];
  if (!row || row.database_name !== EXPECTED_DATABASE) throw new Error('E: DATABASE_IDENTITY_MISMATCH');
  if (Math.floor(Number(row.server_version_num) / 10000) !== EXPECTED_POSTGRES_MAJOR) {
    throw new Error('E: POSTGRES_VERSION_MISMATCH');
  }
  if (typeof row.server_address !== 'string' || !Number.isInteger(Number(row.server_port)) || Number(row.server_port) < 1) {
    throw new Error('E: TCP_TARGET_IDENTITY_UNAVAILABLE');
  }
  return {
    databaseName: row.database_name,
    postgresMajor: EXPECTED_POSTGRES_MAJOR,
    serverAddress: row.server_address,
    serverPort: Number(row.server_port),
  };
}

function childEnvironment(env, overrides = {}) {
  const result = Object.fromEntries(Object.entries(env)
    .filter(([key]) => PRISMA_ENV_ALLOWLIST.has(key.toLowerCase())));
  return { ...result, ...overrides };
}

function verifiedTemporaryRoot(deps) {
  const tempRoot = path.resolve((deps.tmpDir || os.tmpdir)());
  const repositoryRelative = path.relative(REPOSITORY_ROOT, tempRoot);
  if (!repositoryRelative.startsWith('..') && !path.isAbsolute(repositoryRelative)) {
    throw new Error('E: TEMP_DIRECTORY_INSIDE_REPOSITORY');
  }
  const createTemp = deps.mkdtempSync || fs.mkdtempSync;
  return createTemp(path.join(tempRoot, CATALOG_TEMP_PREFIX));
}

function removeVerifiedTemporaryRoot(tempRoot, deps) {
  const resolved = path.resolve(tempRoot);
  const parent = path.dirname(resolved);
  if (parent !== path.resolve((deps.tmpDir || os.tmpdir)()) || !path.basename(resolved).startsWith(CATALOG_TEMP_PREFIX)) {
    throw new Error('E: TEMP_DIRECTORY_IDENTITY_MISMATCH');
  }
  (deps.rmSync || fs.rmSync)(resolved, { recursive: true, force: true });
}

function materializeAuthorizedCatalog(tempRoot, env, deps) {
  const tsxPackagePath = path.join(REPOSITORY_ROOT, 'node_modules', 'tsx', 'package.json');
  const tsxPackage = JSON.parse(fs.readFileSync(tsxPackagePath, 'utf8'));
  if (tsxPackage.version !== EXPECTED_TSX_VERSION) throw new Error('E: TSX_TOOLCHAIN_IDENTITY_MISMATCH');

  const tsxCli = path.join(REPOSITORY_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const materializer = path.join(REPOSITORY_ROOT, 'scripts', 'materialize-authorized-migration-catalog.ts');
  const args = [tsxCli, materializer, '--output-dir', tempRoot, '--verify-fingerprint'];
  const result = (deps.spawnSync || spawnSync)(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    env: childEnvironment(env),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('E: AUTHORIZED_CATALOG_MATERIALIZATION_FAILED');

  const expectedPath = path.join(tempRoot, 'catalog');
  const lines = String(result.stdout || '').split(/\r?\n/);
  const reportedPath = lines.find((line) => line.startsWith('AUTHORIZED_CATALOG_PATH='))?.slice('AUTHORIZED_CATALOG_PATH='.length);
  const count = lines.find((line) => line.startsWith('AUTHORIZED_CATALOG_COUNT='))?.slice('AUTHORIZED_CATALOG_COUNT='.length);
  const fingerprint = lines.find((line) => line.startsWith('AUTHORIZED_CATALOG_FINGERPRINT='))?.slice('AUTHORIZED_CATALOG_FINGERPRINT='.length);
  if (path.resolve(reportedPath || '') !== path.resolve(expectedPath)
    || count !== '57'
    || fingerprint !== AUTHORIZED_CATALOG_FINGERPRINT) {
    throw new Error('E: AUTHORIZED_CATALOG_IDENTITY_MISMATCH');
  }
  if (!fs.statSync(expectedPath).isDirectory()) throw new Error('E: MATERIALIZED_CATALOG_MISSING');
  const materializedBaseline = path.join(expectedPath, BASELINE_MIGRATION, 'migration.sql');
  const materializedBaselineHash = crypto.createHash('sha256').update(fs.readFileSync(materializedBaseline)).digest('hex');
  if (materializedBaselineHash !== BASELINE_SQL_SHA256) throw new Error('E: BASELINE_SQL_IDENTITY_MISMATCH');
  return expectedPath;
}

async function withAuthorizedCatalog(env, deps, action) {
  const tempRoot = verifiedTemporaryRoot(deps);
  let result;
  let primaryError;
  try {
    const catalogPath = materializeAuthorizedCatalog(tempRoot, env, deps);
  } catch (error) {
    primaryError = error;
  }
  if (!primaryError) {
    try {
      const catalogPath = path.join(tempRoot, 'catalog');
      result = await action(catalogPath);
    } catch (error) {
      primaryError = error;
    }
  }
  try {
    removeVerifiedTemporaryRoot(tempRoot, deps);
  } catch {
    throw new Error(primaryError
      ? 'E: AUTHORIZED_CATALOG_TEMP_CLEANUP_FAILED_AFTER_OPERATION_FAILURE'
      : 'E: AUTHORIZED_CATALOG_TEMP_CLEANUP_FAILED');
  }
  if (primaryError) throw primaryError;
  return result;
}

async function runBaselineLedger(connectionString, env, deps, catalogPath) {
  baselineSqlBytes();
  const packageJsonPath = path.join(REPOSITORY_ROOT, 'node_modules', 'prisma', 'package.json');
  const prismaPackage = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (prismaPackage.version !== EXPECTED_PRISMA_VERSION) throw new Error('E: PRISMA_TOOLCHAIN_IDENTITY_MISMATCH');
  if (!fs.existsSync(BASELINE_SQL_PATH)) throw new Error('E: BASELINE_MIGRATION_MISSING');

  const prismaCli = path.join(REPOSITORY_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  const configPath = path.join(REPOSITORY_ROOT, 'scripts', 'prisma.bootstrap.ts');
  const args = [prismaCli, 'migrate', 'resolve', '--config', configPath, '--applied', BASELINE_MIGRATION];
  const childEnv = childEnvironment(env, {
    DATABASE_URL: connectionString,
    PRISMA_MIGRATIONS_PATH: catalogPath,
  });
  const result = (deps.spawnSync || spawnSync)(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    env: childEnv,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30000,
  });
  if (result.error || result.status !== 0) throw new Error('E: BASELINE_LEDGER_REGISTRATION_FAILED');
  return { migration: BASELINE_MIGRATION, prismaVersion: EXPECTED_PRISMA_VERSION };
}

async function runOperation(operation, deps = {}) {
  assertOperation(operation);
  const env = deps.env || process.env;
  const connectionString = requiredDatabaseUrl(env);

  if (operation === 'baseline') baselineSqlBytes();
  return withAuthorizedCatalog(env, deps, async (catalogPath) => {
    if (operation === 'baseline') {
      await withClient(connectionString, deps, (client) => client.query(baselineSqlBytes()));
      return { baseline: BASELINE_MIGRATION, sha256: BASELINE_SQL_SHA256 };
    }
    if (operation === 'baselineLedger') return runBaselineLedger(connectionString, env, deps, catalogPath);
    return withClient(connectionString, deps, async (client) => {
      if (operation === 'targetIdentity') return targetIdentity(client);
      if (operation === 'emptyState') {
        const result = await client.query(EMPTY_STATE_SQL);
        const value = String(result.rows?.[0]?.nonempty);
        if (!['0', '1'].includes(value)) throw new Error('E: EMPTY_STATE_RESULT_INVALID');
        return value;
      }
      const result = await client.query(MIGRATION_TABLE_SQL);
      const value = String(result.rows?.[0]?.present);
      if (!['0', '1'].includes(value)) throw new Error('E: MIGRATION_TABLE_RESULT_INVALID');
      return value;
    });
  });
}

function writeResult(operation, result, output = process.stdout) {
  if (operation === 'emptyState' || operation === 'migrationTable') output.write(`${result}\n`);
  else output.write(`${JSON.stringify(result)}\n`);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) throw new Error('E: ONE_FIXED_OPERATION_REQUIRED');
  const [operation] = argv;
  assertOperation(operation);
  const result = await runOperation(operation);
  writeResult(operation, result);
}

if (require.main === module) {
  main().catch((error) => {
    const code = /^E: [A-Z0-9_]+$/.test(error.message) ? error.message : 'E: DISPATCH_OPERATION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BASELINE_MIGRATION,
  BASELINE_SQL_SHA256,
  AUTHORIZED_CATALOG_FINGERPRINT,
  EMPTY_STATE_SQL,
  EXPECTED_DATABASE,
  EXPECTED_POSTGRES_MAJOR,
  MIGRATION_TABLE_SQL,
  OPERATIONS,
  buildCommandSet,
  main,
  runOperation,
  targetIdentity,
};
