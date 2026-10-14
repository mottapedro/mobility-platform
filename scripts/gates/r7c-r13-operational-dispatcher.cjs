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
const FD3_FAILURE_EXIT_CODE = 70;
const PRELOADER_WRAPPER_PATH = path.join(REPOSITORY_ROOT, 'scripts', 'gates', 'r13-preloader-wrapper.cjs');
const preloaderWrapper = require('./r13-preloader-wrapper.cjs');
const PRELOADER_PIPELINE_STATES = Object.freeze([
  'TRANSPORT_ESTABLISHED',
  'BYTES_RECEIVED',
  'RECORDS_PARSED',
  'RECORDS_ACCEPTED',
  'EVIDENCE_PERSISTED',
]);
const CHILD_MATERIALIZER_COMPONENT = 'authorizedMigrationCatalogMaterializer';
const CHILD_MATERIALIZER_BOUNDARIES = Object.freeze([
  'MATERIALIZER_MODULE_ENTERED', 'MATERIALIZER_MODULE_INITIALIZATION_COMPLETED',
  'MATERIALIZER_CLI_ENTERED', 'SOURCE_CATALOG_VALIDATION_ENTERED',
  'SOURCE_CATALOG_VALIDATED', 'CATALOG_COPY_COMPLETED',
  'OUTPUT_STRUCTURE_VALIDATED', 'FINGERPRINT_AUTHORITY_READ',
  'FINGERPRINT_VERIFIED', 'MANIFEST_WRITTEN',
]);
const CHILD_MATERIALIZER_FAILURE_CATEGORIES = Object.freeze([
  'MATERIALIZER_SOURCE_CATALOG_UNAVAILABLE', 'MATERIALIZER_SOURCE_CATALOG_INVALID',
  'MATERIALIZER_SOURCE_MEMBERSHIP_MISMATCH', 'MATERIALIZER_OUTPUT_CATALOG_CREATION_FAILED',
  'MATERIALIZER_MIGRATION_COPY_FAILED', 'MATERIALIZER_LOCKFILE_COPY_FAILED',
  'MATERIALIZER_OUTPUT_STRUCTURE_INVALID', 'MATERIALIZER_FINGERPRINT_AUTHORITY_UNAVAILABLE',
  'MATERIALIZER_FINGERPRINT_AUTHORITY_INVALID', 'MATERIALIZER_FINGERPRINT_MISMATCH',
  'MATERIALIZER_MANIFEST_WRITE_FAILED',
]);
const CHILD_BOUNDARY_PARENT_EVENTS = Object.freeze(Object.fromEntries(
  CHILD_MATERIALIZER_BOUNDARIES.map((boundary) => [boundary, `CHILD_${boundary}`]),
));
const CHILD_CATEGORY_PARENT_EVENTS = Object.freeze(Object.fromEntries(
  CHILD_MATERIALIZER_FAILURE_CATEGORIES.map((category) => [category, `CHILD_${category}`]),
));
const DIAGNOSTIC_EVENTS = Object.freeze([
  'DISPATCHER_MODULE_LOADED', 'DISPATCHER_MAIN_ENTERED', 'TARGETIDENTITY_ENTERED',
  'PG_CLIENT_CONSTRUCTION_REACHED', 'PG_CONNECT_ATTEMPTED', 'PG_CONNECT_SUCCEEDED',
  'TARGETIDENTITY_QUERY_ATTEMPTED', 'TARGETIDENTITY_QUERY_SUCCEEDED', 'MAIN_CATCH_ENTERED',
  'GENERIC_PROTOCOL_EMISSION_ATTEMPTED', 'GENERIC_PROTOCOL_EMISSION_COMPLETED',
  'BOUNDED_DIAGNOSTIC_EMISSION_ATTEMPTED', 'BOUNDED_DIAGNOSTIC_EMISSION_COMPLETED',
  'AUTHORIZED_CATALOG_MATERIALIZATION_ENTERED', 'MATERIALIZER_PROCESS_CREATE_ATTEMPTED',
  'MATERIALIZER_PROCESS_CREATED', 'MATERIALIZER_PROCESS_COMPLETED',
  'MATERIALIZER_OUTPUT_VALIDATION_ENTERED', 'MATERIALIZER_OUTPUT_VALIDATED',
  'AUTHORIZED_CATALOG_IDENTITY_VERIFICATION_ENTERED', 'AUTHORIZED_CATALOG_IDENTITY_VERIFIED',
  'AUTHORIZED_CATALOG_MATERIALIZATION_COMPLETED',
  'CHILD_DIAGNOSTIC_SCHEMA_VALID', 'CHILD_DIAGNOSTIC_PRESENT', 'CHILD_DIAGNOSTIC_CATEGORY_VALID',
  ...Object.values(CHILD_BOUNDARY_PARENT_EVENTS),
  ...Object.values(CHILD_CATEGORY_PARENT_EVENTS),
]);
const EVENT_BYTES = Object.freeze(Object.fromEntries(DIAGNOSTIC_EVENTS.map((event) => [
  event, Buffer.from(`${JSON.stringify({ event })}\n`, 'utf8'),
])));

function emitBoundaryEvent(event, write = fs.writeSync) {
  if (!EVENT_BYTES[event]) return false;
  try { write(3, EVENT_BYTES[event]); return true; }
  catch { process.exitCode = FD3_FAILURE_EXIT_CODE; return false; }
}

function requireBoundaryEvent(event, emit) {
  if (!emit(event)) throw new Error('E: DIAGNOSTIC_CHANNEL_FAILURE');
}

function parseChildMaterializerProtocol(raw) {
  const text = raw == null ? '' : String(raw);
  if (text === '') return Object.freeze({ records: Object.freeze([]), boundaries: Object.freeze([]), diagnostic: null });
  if (!text.endsWith('\n')) throw new Error('E: MATERIALIZER_CHILD_PROTOCOL_INVALID');
  const lines = text.slice(0, -1).split('\n');
  const records = [];
  const boundaries = [];
  let diagnostic = null;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); }
    catch { throw new Error('E: MATERIALIZER_CHILD_PROTOCOL_INVALID'); }
    if (!record || Array.isArray(record) || typeof record !== 'object') {
      throw new Error('E: MATERIALIZER_CHILD_PROTOCOL_INVALID');
    }
    const keys = Object.keys(record).sort();
    if (record.type === 'BOUNDARY') {
      if (diagnostic || keys.join(',') !== 'boundary,type' || !CHILD_MATERIALIZER_BOUNDARIES.includes(record.boundary)) {
        throw new Error('E: MATERIALIZER_CHILD_PROTOCOL_INVALID');
      }
      const expected = CHILD_MATERIALIZER_BOUNDARIES[boundaries.length];
      if (record.boundary !== expected) throw new Error('E: MATERIALIZER_CHILD_PROTOCOL_INVALID');
      boundaries.push(record.boundary);
    } else if (record.type === 'DIAGNOSTIC') {
      if (diagnostic || keys.join(',') !== 'boundary,category,component,type'
        || record.component !== CHILD_MATERIALIZER_COMPONENT
        || !CHILD_MATERIALIZER_FAILURE_CATEGORIES.includes(record.category)
        || record.boundary !== boundaries.at(-1)) {
        throw new Error('E: MATERIALIZER_CHILD_PROTOCOL_INVALID');
      }
      diagnostic = Object.freeze({
        component: record.component,
        category: record.category,
        boundary: record.boundary,
      });
    } else {
      throw new Error('E: MATERIALIZER_CHILD_PROTOCOL_INVALID');
    }
    records.push(Object.freeze({ ...record }));
  }
  return Object.freeze({ records: Object.freeze(records), boundaries: Object.freeze(boundaries), diagnostic });
}

function projectChildMaterializerProtocol(protocol, emit) {
  requireBoundaryEvent('CHILD_DIAGNOSTIC_SCHEMA_VALID', emit);
  for (const boundary of protocol.boundaries) {
    requireBoundaryEvent(CHILD_BOUNDARY_PARENT_EVENTS[boundary], emit);
  }
  if (protocol.diagnostic) {
    requireBoundaryEvent('CHILD_DIAGNOSTIC_PRESENT', emit);
    requireBoundaryEvent('CHILD_DIAGNOSTIC_CATEGORY_VALID', emit);
    requireBoundaryEvent(CHILD_CATEGORY_PARENT_EVENTS[protocol.diagnostic.category], emit);
  }
}

const MATERIALIZER_FAILURE_CATEGORIES = Object.freeze([
  'MATERIALIZER_TEMP_ROOT_FAILURE',
  'MATERIALIZER_PROCESS_CREATION_FAILED',
  'MATERIALIZER_NONZERO_EXIT',
  'MATERIALIZER_SIGNALLED',
  'MATERIALIZER_OUTPUT_MISSING',
  'MATERIALIZER_OUTPUT_INVALID',
  'MATERIALIZER_CATALOG_COUNT_MISMATCH',
  'MATERIALIZER_CATALOG_IDENTITY_MISMATCH',
  'MATERIALIZER_CLEANUP_FAILURE',
]);

function withMaterializerDiagnostic(error, category, processCreated = false, exitCode = null, signal = null) {
  const target = error instanceof Error ? error : new Error('E: AUTHORIZED_CATALOG_MATERIALIZATION_FAILED');
  const safeCategory = MATERIALIZER_FAILURE_CATEGORIES.includes(category)
    ? category
    : 'MATERIALIZER_OUTPUT_INVALID';
  Object.defineProperty(target, 'materializerDiagnostic', {
    value: Object.freeze({
      operation: 'authorizedCatalogMaterialization',
      category: safeCategory,
      processCreated: processCreated === true,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      signal: typeof signal === 'string' && /^[A-Z0-9]+$/.test(signal) ? signal : null,
    }),
    enumerable: false,
    configurable: true,
  });
  return target;
}

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
  const emit = deps.emitEvent || (() => true);
  requireBoundaryEvent('PG_CLIENT_CONSTRUCTION_REACHED', emit);
  const client = (deps.createClient || createPgClient)(connectionString);
  let actionFailed = false;
  try {
    requireBoundaryEvent('PG_CONNECT_ATTEMPTED', emit);
    await client.connect();
    requireBoundaryEvent('PG_CONNECT_SUCCEEDED', emit);
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

async function targetIdentity(client, emit = () => true) {
  requireBoundaryEvent('TARGETIDENTITY_ENTERED', emit);
  requireBoundaryEvent('TARGETIDENTITY_QUERY_ATTEMPTED', emit);
  const result = await client.query(`
    SELECT current_database() AS database_name,
           current_setting('server_version_num')::integer AS server_version_num,
           inet_server_addr()::text AS server_address,
           inet_server_port() AS server_port;
  `);
  requireBoundaryEvent('TARGETIDENTITY_QUERY_SUCCEEDED', emit);
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
  const emit = deps.emitEvent || (() => true);
  requireBoundaryEvent('AUTHORIZED_CATALOG_MATERIALIZATION_ENTERED', emit);
  const tsxPackagePath = path.join(REPOSITORY_ROOT, 'node_modules', 'tsx', 'package.json');
  const tsxPackage = JSON.parse(fs.readFileSync(tsxPackagePath, 'utf8'));
  if (tsxPackage.version !== EXPECTED_TSX_VERSION) throw new Error('E: TSX_TOOLCHAIN_IDENTITY_MISMATCH');

  const wrapper = deps.preloaderWrapperPath || PRELOADER_WRAPPER_PATH;
  const materializer = path.join(REPOSITORY_ROOT, 'scripts', 'materialize-authorized-migration-catalog.ts');
  const nonce = (deps.generateNonce || (() => crypto.randomBytes(16).toString('hex')))();
  const args = [wrapper, materializer, '--output-dir', tempRoot, '--verify-fingerprint'];
  const pipelineStates = new Set(['TRANSPORT_ESTABLISHED']);
  requireBoundaryEvent('MATERIALIZER_PROCESS_CREATE_ATTEMPTED', emit);
  const result = (deps.spawnSync || spawnSync)(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    env: childEnvironment(env, { R13_PRELOADER_NONCE: nonce }),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw withMaterializerDiagnostic(
      new Error('E: AUTHORIZED_CATALOG_MATERIALIZATION_FAILED'),
      'MATERIALIZER_PROCESS_CREATION_FAILED',
    );
  }
  requireBoundaryEvent('MATERIALIZER_PROCESS_CREATED', emit);
  requireBoundaryEvent('MATERIALIZER_PROCESS_COMPLETED', emit);
  pipelineStates.add('BYTES_RECEIVED');
  let childProtocol;
  let preloaderProtocol = null;
  try {
    childProtocol = parseChildMaterializerProtocol(result.output?.[3]);
    if (result.output?.[4] && String(result.output[4]).trim() !== '') {
      preloaderProtocol = preloaderWrapper.parsePreloaderProtocol(result.output[4], nonce);
    }
    pipelineStates.add('RECORDS_PARSED');
    projectChildMaterializerProtocol(childProtocol, emit);
    pipelineStates.add('RECORDS_ACCEPTED');
  } catch (error) {
    throw withMaterializerDiagnostic(error, 'MATERIALIZER_OUTPUT_INVALID', true, result.status, result.signal);
  }
  if (result.signal) {
    throw withMaterializerDiagnostic(
      new Error('E: AUTHORIZED_CATALOG_MATERIALIZATION_FAILED'),
      'MATERIALIZER_SIGNALLED', true, null, result.signal,
    );
  }
  if (result.status !== 0) {
    const error = withMaterializerDiagnostic(
      new Error('E: AUTHORIZED_CATALOG_MATERIALIZATION_FAILED'),
      'MATERIALIZER_NONZERO_EXIT', true, result.status,
    );
    const classification = preloaderWrapper.classifyPreloaderFailure(preloaderProtocol);
    if (classification?.positiveEvidence) {
      error.preloaderClassification = classification;
    }
    throw error;
  }
  if (childProtocol.diagnostic || childProtocol.boundaries.length !== CHILD_MATERIALIZER_BOUNDARIES.length) {
    throw withMaterializerDiagnostic(
      new Error('E: MATERIALIZER_CHILD_PROTOCOL_INVALID'), 'MATERIALIZER_OUTPUT_INVALID', true, 0,
    );
  }

  requireBoundaryEvent('MATERIALIZER_OUTPUT_VALIDATION_ENTERED', emit);
  const expectedPath = path.join(tempRoot, 'catalog');
  const lines = String(result.stdout || '').split(/\r?\n/);
  const values = Object.fromEntries(['AUTHORIZED_CATALOG_PATH', 'AUTHORIZED_CATALOG_COUNT', 'AUTHORIZED_CATALOG_FINGERPRINT']
    .map((key) => [key, lines.filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1))]));
  if (Object.values(values).some((matches) => matches.length === 0)) {
    throw withMaterializerDiagnostic(new Error('E: AUTHORIZED_CATALOG_IDENTITY_MISMATCH'), 'MATERIALIZER_OUTPUT_MISSING', true, 0);
  }
  if (Object.values(values).some((matches) => matches.length !== 1 || matches[0] === '')) {
    throw withMaterializerDiagnostic(new Error('E: AUTHORIZED_CATALOG_IDENTITY_MISMATCH'), 'MATERIALIZER_OUTPUT_INVALID', true, 0);
  }
  requireBoundaryEvent('MATERIALIZER_OUTPUT_VALIDATED', emit);

  requireBoundaryEvent('AUTHORIZED_CATALOG_IDENTITY_VERIFICATION_ENTERED', emit);
  const reportedPath = values.AUTHORIZED_CATALOG_PATH[0];
  const count = values.AUTHORIZED_CATALOG_COUNT[0];
  const fingerprint = values.AUTHORIZED_CATALOG_FINGERPRINT[0];
  if (path.resolve(reportedPath) !== path.resolve(expectedPath)) {
    throw withMaterializerDiagnostic(new Error('E: AUTHORIZED_CATALOG_IDENTITY_MISMATCH'), 'MATERIALIZER_CATALOG_IDENTITY_MISMATCH', true, 0);
  }
  if (count !== '57') {
    throw withMaterializerDiagnostic(new Error('E: AUTHORIZED_CATALOG_IDENTITY_MISMATCH'), 'MATERIALIZER_CATALOG_COUNT_MISMATCH', true, 0);
  }
  if (fingerprint !== AUTHORIZED_CATALOG_FINGERPRINT) {
    throw withMaterializerDiagnostic(new Error('E: AUTHORIZED_CATALOG_IDENTITY_MISMATCH'), 'MATERIALIZER_CATALOG_IDENTITY_MISMATCH', true, 0);
  }
  if (!fs.existsSync(expectedPath) || !fs.statSync(expectedPath).isDirectory()) {
    throw withMaterializerDiagnostic(new Error('E: MATERIALIZED_CATALOG_MISSING'), 'MATERIALIZER_OUTPUT_MISSING', true, 0);
  }
  const materializedBaseline = path.join(expectedPath, BASELINE_MIGRATION, 'migration.sql');
  let materializedBaselineHash;
  try { materializedBaselineHash = crypto.createHash('sha256').update(fs.readFileSync(materializedBaseline)).digest('hex'); }
  catch (error) { throw withMaterializerDiagnostic(error, 'MATERIALIZER_OUTPUT_MISSING', true, 0); }
  if (materializedBaselineHash !== BASELINE_SQL_SHA256) {
    throw withMaterializerDiagnostic(new Error('E: BASELINE_SQL_IDENTITY_MISMATCH'), 'MATERIALIZER_CATALOG_IDENTITY_MISMATCH', true, 0);
  }
  requireBoundaryEvent('AUTHORIZED_CATALOG_IDENTITY_VERIFIED', emit);
  requireBoundaryEvent('AUTHORIZED_CATALOG_MATERIALIZATION_COMPLETED', emit);

  try {
    const evidenceDir = path.join(tempRoot, '.evidence');
    const manifest = {
      schemaVersion: 1,
      operation: 'materializeAuthorizedCatalog',
      nonce,
      processIdentity: preloaderProtocol?.processIdentity || null,
      status: result.status,
      signal: result.signal,
      pipelineStates: Array.from(pipelineStates),
    };
    preloaderWrapper.persistPreloaderEvidence(
      evidenceDir,
      manifest,
      Buffer.from(result.stdout || ''),
      Buffer.from(result.stderr || ''),
      Buffer.from(result.output?.[3] || ''),
      Buffer.from(result.output?.[4] || ''),
    );
    pipelineStates.add('EVIDENCE_PERSISTED');
  } catch (err) {
    if (deps.failOnPersistence) throw err;
  }

  return expectedPath;
}

async function withAuthorizedCatalog(env, deps, action) {
  let tempRoot;
  try { tempRoot = verifiedTemporaryRoot(deps); }
  catch (error) { throw withMaterializerDiagnostic(error, 'MATERIALIZER_TEMP_ROOT_FAILURE'); }
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
  } catch (cleanupError) {
    const error = new Error(primaryError
      ? 'E: AUTHORIZED_CATALOG_TEMP_CLEANUP_FAILED_AFTER_OPERATION_FAILURE'
      : 'E: AUTHORIZED_CATALOG_TEMP_CLEANUP_FAILED');
    throw primaryError?.materializerDiagnostic
      ? withMaterializerDiagnostic(error, primaryError.materializerDiagnostic.category,
        primaryError.materializerDiagnostic.processCreated,
        primaryError.materializerDiagnostic.exitCode,
        primaryError.materializerDiagnostic.signal)
      : withMaterializerDiagnostic(error, 'MATERIALIZER_CLEANUP_FAILURE');
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
      if (operation === 'targetIdentity') return targetIdentity(client, deps.emitEvent);
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

const DIAGNOSTIC_CATEGORIES = Object.freeze([
  'AUTHENTICATION_FAILURE',
  'CONNECTION_FAILURE',
  'DATABASE_NOT_FOUND',
  'NAME_RESOLUTION_FAILURE',
  'TLS_TRANSPORT_FAILURE',
  'QUERY_FAILURE',
  'MODULE_RUNTIME_FAILURE',
  'UNKNOWN',
]);

function boundedValue(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'UNKNOWN';
}

function classifyDispatchError(error, operation = 'UNKNOWN') {
  const code = boundedValue(error?.code);
  const syscall = boundedValue(error?.syscall);
  let category = 'UNKNOWN';

  if (/^28/.test(code)) category = 'AUTHENTICATION_FAILURE';
  else if (/^3D/.test(code)) category = 'DATABASE_NOT_FOUND';
  else if (/^(08|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/.test(code)) category = 'CONNECTION_FAILURE';
  else if (/^(ENOTFOUND|EAI_AGAIN)$/.test(code)) category = 'NAME_RESOLUTION_FAILURE';
  else if (/^(CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS)/.test(code)) category = 'TLS_TRANSPORT_FAILURE';
  else if (/^(22|23|40|42|43|54|55)/.test(code)) category = 'QUERY_FAILURE';
  else if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') category = 'MODULE_RUNTIME_FAILURE';
  else if (syscall === 'connect') category = 'CONNECTION_FAILURE';

  return Object.freeze({
    protocol: 'E: DISPATCH_OPERATION_FAILED',
    operation: boundedValue(operation),
    category: DIAGNOSTIC_CATEGORIES.includes(category) ? category : 'UNKNOWN',
    code,
    syscall,
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const emit = deps.emitEvent || emitBoundaryEvent;
  requireBoundaryEvent('DISPATCHER_MAIN_ENTERED', emit);
  if (argv.length !== 1) throw new Error('E: ONE_FIXED_OPERATION_REQUIRED');
  const [operation] = argv;
  assertOperation(operation);
  const result = await runOperation(operation, { ...deps, emitEvent: emit });
  writeResult(operation, result);
}

if (require.main === module) {
  const emit = emitBoundaryEvent;
  if (!emit('DISPATCHER_MODULE_LOADED')) process.exitCode = FD3_FAILURE_EXIT_CODE;
  else main(process.argv.slice(2), { emitEvent: emit }).catch((error) => {
    if (process.exitCode === FD3_FAILURE_EXIT_CODE) return;
    if (!emit('MAIN_CATCH_ENTERED')) return;
    const code = /^E: [A-Z0-9_]+$/.test(error.message) ? error.message : 'E: DISPATCH_OPERATION_FAILED';
    if (!emit('GENERIC_PROTOCOL_EMISSION_ATTEMPTED')) return;
    process.stderr.write(`${code}\n`);
    if (!emit('GENERIC_PROTOCOL_EMISSION_COMPLETED')) return;
    if (code === 'E: DISPATCH_OPERATION_FAILED' || error.materializerDiagnostic) {
      if (!emit('BOUNDED_DIAGNOSTIC_EMISSION_ATTEMPTED')) return;
      process.stderr.write(`E: DISPATCH_DIAGNOSTIC ${JSON.stringify(error.materializerDiagnostic || classifyDispatchError(error, process.argv[2]))}\n`);
      if (!emit('BOUNDED_DIAGNOSTIC_EMISSION_COMPLETED')) return;
    }
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
  classifyDispatchError,
  DIAGNOSTIC_CATEGORIES,
  DIAGNOSTIC_EVENTS,
  MATERIALIZER_FAILURE_CATEGORIES,
  CHILD_MATERIALIZER_COMPONENT,
  CHILD_MATERIALIZER_BOUNDARIES,
  CHILD_MATERIALIZER_FAILURE_CATEGORIES,
  parseChildMaterializerProtocol,
  projectChildMaterializerProtocol,
  FD3_FAILURE_EXIT_CODE,
  emitBoundaryEvent,
  main,
  runOperation,
  targetIdentity,
  PRELOADER_WRAPPER_PATH,
  PRELOADER_PIPELINE_STATES,
  materializeAuthorizedCatalog,
};
