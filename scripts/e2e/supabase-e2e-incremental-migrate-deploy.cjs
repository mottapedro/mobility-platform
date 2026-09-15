'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const { validateTarget, PROJECT_REF } = require('./supabase-target.cjs');

const FINGERPRINT = '061c8aa563bbb2023fa96a17f7ef4580e3303dfc6271427c77c369753f622d88';
const PRE = 'PRE_INCREMENTAL_DEPLOY';
const POST = 'POST_INCREMENTAL_DEPLOY';
const failure = (code) => Object.assign(new Error(code), { code });
const emit = (key, value) => console.log(`${key}=${value}`);

function isolatedEnvironment(env) {
  // Deliberate allowlist: no inherited datasource, Node preload or engine overrides.
  const result = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'GITHUB_SHA', 'RUNNER_TEMP']) {
    if (env[key]) result[key] = env[key];
  }
  return { ...result, CI: 'true', CHECKPOINT_DISABLE: '1' };
}

function caPath(env) {
  if (!path.isAbsolute(env.RUNNER_TEMP || '') || !/^\d+$/.test(env.GITHUB_RUN_ID || '')
      || env.GITHUB_RUN_ATTEMPT !== '1') throw failure('RUN_IDENTITY_REJECTED');
  return path.join(env.RUNNER_TEMP, `incremental-e2e-ca-${env.GITHUB_RUN_ID}-1.pem`);
}

function validateExecution(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || env.GITHUB_REPOSITORY !== 'mottapedro/mobility-platform'
      || env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) {
    throw failure('WORKFLOW_IDENTITY_REJECTED');
  }
  caPath(env);
  let target;
  try { target = validateTarget(env.DATABASE_URL); } catch { throw failure('TARGET_REJECTED'); }
  if (target.mode !== 'session' || target.projectRef !== PROJECT_REF) throw failure('TARGET_REJECTED');
  try { new X509Certificate(env.E2E_CA_CERT); } catch { throw failure('CA_CERTIFICATE_REJECTED'); }
  return target;
}

function prismaConnection(connectionString, certificatePath) {
  const url = new URL(connectionString);
  url.searchParams.set('sslmode', 'require');
  url.searchParams.set('sslaccept', 'strict');
  url.searchParams.set('sslcert', certificatePath);
  return url.toString();
}

function assertArtifactPath(env) {
  const expected = path.join(env.RUNNER_TEMP, 'authorized-migration-catalog', 'catalog');
  if (!path.isAbsolute(env.PRISMA_MIGRATIONS_PATH || '') || env.PRISMA_MIGRATIONS_PATH !== expected
      || fs.realpathSync(expected) !== expected) throw failure('ARTIFACT_PATH_REJECTED');
  const inspect = (entry) => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) throw failure('ARTIFACT_SYMLINK_REJECTED');
    if (stat.isDirectory()) for (const name of fs.readdirSync(entry)) inspect(path.join(entry, name));
    else if (!stat.isFile()) throw failure('ARTIFACT_ENTRY_REJECTED');
  };
  inspect(path.dirname(expected));
  return expected;
}

function executeLocal(args, env, signal, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { env, signal, timeout, maxBuffer: 4 * 1024 * 1024,
      windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        // Never forward engine output or Error objects that may contain credentials.
        reject(failure(signal?.aborted ? 'EXECUTION_CANCELLED' : 'LOCAL_PROCESS_FAILED'));
      } else resolve(stdout);
    });
  });
}

async function verifyArtifact(env, run = executeLocal, signal) {
  const catalog = assertArtifactPath(env);
  const manifest = Object.fromEntries(fs.readFileSync(path.join(path.dirname(catalog), 'manifest'), 'utf8')
    .trim().split('\n').map((line) => line.trim().split('=')));
  const expected = fs.readFileSync('governance/authorized-migration-catalog.sha256', 'utf8').trim();
  if (manifest.commit_sha !== env.GITHUB_SHA || manifest.catalog_count !== '56'
      || manifest.fingerprint !== FINGERPRINT || expected !== FINGERPRINT) throw failure('ARTIFACT_MANIFEST_REJECTED');
  const output = await run([path.resolve('scripts/e2e/verify-authorized-migration-artifact.cjs'), path.dirname(catalog)],
    isolatedEnvironment(env), signal);
  const lines = output.split(/\r?\n/);
  if (!lines.includes('EXECUTED_CATALOG_ARTIFACT=VERIFIED')
      || !lines.includes(`AUTHORIZED_CATALOG_FINGERPRINT=${FINGERPRINT}`)) throw failure('ARTIFACT_VERIFICATION_FAILED');
  const names = fs.readdirSync(catalog, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const source = fs.readdirSync('prisma/migrations', { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const allowed = new Set([...names, '20260518000000_passenger_codes_not_null_future']);
  if (names.length !== 56 || names.some((name) => !source.includes(name)) || source.some((name) => !allowed.has(name))) {
    throw failure('SOURCE_CATALOG_REJECTED');
  }
  emit('AUTHORIZED_CATALOG_COUNT', names.length);
  emit('AUTHORIZED_ARTIFACT_VERIFY', 'PASS');
  emit('AUTHORIZED_FINGERPRINT_MATCH', 'YES');
  emit('SOURCE_UNKNOWN_MIGRATION_COUNT', 0);
  return true;
}

async function certify(mode, env, run = executeLocal, signal, report = emit) {
  const output = await run([path.resolve('scripts/e2e/lifecycle-read-only-certification.cjs'), '--mode', mode],
    { ...isolatedEnvironment(env), DATABASE_URL: env.DATABASE_URL, E2E_CA_CERT: env.E2E_CA_CERT,
      PRISMA_MIGRATIONS_PATH: env.PRISMA_MIGRATIONS_PATH }, signal);
  const tokens = output.split(/\r?\n/).filter((line) => line.startsWith('INCREMENTAL_CERTIFICATION_RESULT='));
  if (tokens.length !== 1 || tokens[0] !== `INCREMENTAL_CERTIFICATION_RESULT=${mode}:PASS`) {
    throw failure('CERTIFICATION_INCOMPLETE');
  }
  // Publish only known scalar evidence, never arbitrary subprocess output.
  const evidenceKeys = new Set(['AUTHORIZED_ARTIFACT_VERIFY', 'AUTHORIZED_ARTIFACT_ACTUAL_COUNT',
    'TARGET_PROVIDER', 'TARGET_PROJECT_ID', 'TARGET_DATABASE_NAME', 'TARGET_HOST_CLASS',
    'TARGET_IS_SUPABASE_E2E', 'TARGET_IS_PRODUCTION', 'TARGET_IS_OTHER_HML',
    'TARGET_APPLIED_MIGRATION_COUNT', 'TARGET_PENDING_MIGRATION_COUNT', 'TARGET_PENDING_SET_EXACT',
    'TARGET_MISSING_AUTHORIZED_COUNT', 'TARGET_UNEXPECTED_MIGRATION_COUNT', 'TARGET_UNFINISHED_COUNT',
    'TARGET_ROLLED_BACK_COUNT', 'TARGET_FAILED_COUNT', 'TARGET_HISTORY_CONFLICT_PRESENT',
    'TARGET_PENDING_ORDER_VALID', 'TARGET_PENDING_MIGRATION_COMPATIBILITY_MATRIX_COMPLETE',
    'TARGET_UNEXPLAINED_PHYSICAL_DRIFT', 'FINAL_HISTORY_EXACT_SET_MATCH',
    'WAITING_OWNER_TARGET_PRESENT', 'RIDEOFFER_CANCELLED_TARGET_PRESENT',
    'CREATION_CORRELATION_TARGET_PRESENT', 'CREATION_INTENT_FINGERPRINT_TARGET_PRESENT',
    'TARGET_ONE_PENDING_INDEX_PRESENT', 'TARGET_ONE_PENDING_INDEX_EQUIVALENT', 'DUPLICATE_PENDING_RIDE_COUNT',
    'PASSENGER_SUPERSEDED_PRESENT_IN_TARGET_HISTORY', 'TLS', 'READ_ONLY_MODE', 'MIGRATE_DEPLOY_PROJECTED_SAFE']);
  report('CERTIFICATION_MODE', mode);
  for (const line of output.split(/\r?\n/)) {
    const [key, value] = line.split('=');
    if (evidenceKeys.has(key) && /^[A-Za-z0-9_]+$/.test(value || '')) report(key, value);
  }
  return true;
}

function cleanupCertificate(env) {
  const file = caPath(env);
  if (fs.existsSync(file)) {
    if (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile()) throw failure('CA_CLEANUP_REJECTED');
    fs.unlinkSync(file);
  }
}

function productionDependencies(env, signal, run = executeLocal) {
  return {
    validate: () => validateExecution(env),
    verify: () => verifyArtifact(env, run, signal),
    certify: (mode) => certify(mode, env, run, signal),
    prepare: (target) => {
      const file = caPath(env);
      fs.writeFileSync(file, env.E2E_CA_CERT, { flag: 'wx', mode: 0o600 });
      return { ...isolatedEnvironment(env), DATABASE_URL: prismaConnection(target.connectionString, file),
        PRISMA_MIGRATIONS_PATH: env.PRISMA_MIGRATIONS_PATH };
    },
    deploy: (childEnv) => run([path.resolve('node_modules/prisma/build/index.js'),
      'migrate', 'deploy', '--config', 'scripts/prisma.bootstrap.ts'], childEnv, signal, 600000),
    cleanup: () => cleanupCertificate(env),
    cancelled: () => signal.aborted,
  };
}

async function runIncremental(deps, report = emit) {
  let attempted = false;
  let prepared = false;
  let originalFailure;
  let phase = 'PRECONDITION';
  report('PROMOTION_CERTIFIED', 'NO');
  report('HUMAN_INSPECTION_REQUIRED', 'YES');
  report('MIGRATE_DEPLOY_EXECUTED', 'NO');
  try {
    const target = await deps.validate();
    if (await deps.verify() !== true) throw failure('ARTIFACT_VERIFICATION_FAILED');
    if (await deps.certify(PRE) !== true) throw failure('PRE_CERTIFICATION_FAILED');
    const childEnv = await deps.prepare(target);
    prepared = true;
    phase = 'IMMEDIATE_REVALIDATION';
    await deps.validate();
    if (await deps.certify(PRE) !== true) throw failure('PRE_CERTIFICATION_FAILED');
    // Last operation before the sole mutation call: reverify the exact artifact bytes.
    if (await deps.verify() !== true) throw failure('ARTIFACT_VERIFICATION_FAILED');
    if (deps.cancelled()) throw failure('EXECUTION_CANCELLED');
    phase = 'DEPLOY';
    attempted = true;
    report('MIGRATE_DEPLOY_EXECUTED', 'YES');
    try { await deps.deploy(childEnv); } catch { originalFailure = 'DEPLOY_FAILED'; }
    phase = 'POST_CERTIFICATION';
    try {
      if (await deps.certify(POST) !== true) throw failure('POST_CERTIFICATION_FAILED');
      report('POST_INCREMENTAL_CERTIFICATION', 'PASS');
    } catch {
      report('POST_INCREMENTAL_CERTIFICATION', 'FAIL');
      originalFailure ||= 'POST_CERTIFICATION_FAILED';
    }
  } catch {
    originalFailure ||= `${phase}_FAILED`;
  } finally {
    if (prepared) {
      try { await deps.cleanup(); } catch { originalFailure ||= 'TEMPORARY_CA_CLEANUP_FAILED'; }
    }
  }
  if (deps.cancelled()) originalFailure ||= 'EXECUTION_CANCELLED';
  const pass = attempted && !originalFailure;
  report('PROMOTION_CERTIFIED', pass ? 'YES' : 'NO');
  report('HUMAN_INSPECTION_REQUIRED', pass ? 'NO' : 'YES');
  report('INCREMENTAL_DEPLOY_RESULT', pass ? 'PASS' : originalFailure || 'NOT_EXECUTED');
  return { pass, attempted, failure: originalFailure };
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--cleanup-ca') return cleanupCertificate(process.env);
  if (process.argv.length !== 2) throw failure('ARGUMENTS_REJECTED');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  try {
    const result = await runIncremental(productionDependencies(process.env, controller.signal));
    if (!result.pass) process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
}

if (require.main === module) main().catch(() => {
  emit('PROMOTION_CERTIFIED', 'NO');
  emit('HUMAN_INSPECTION_REQUIRED', 'YES');
  emit('INCREMENTAL_DEPLOY_RESULT', 'EXECUTION_FAILED');
  process.exitCode = 1;
});

module.exports = { PRE, POST, FINGERPRINT, runIncremental, validateExecution, isolatedEnvironment,
  prismaConnection, caPath, assertArtifactPath, verifyArtifact, certify, productionDependencies };
