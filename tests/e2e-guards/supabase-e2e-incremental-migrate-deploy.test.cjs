'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const yaml = require('js-yaml');
const { execFileSync } = require('node:child_process');
const { PRE, POST, FINGERPRINT, runIncremental, validateExecution, isolatedEnvironment,
  prismaConnection, caPath, assertArtifactPath, verifyArtifact, certify, productionDependencies,
} = require('../../scripts/e2e/supabase-e2e-incremental-migrate-deploy.cjs');

function harness(failAt) {
  const calls = [];
  const counts = {};
  const invoke = (name, value) => {
    calls.push(name);
    counts[name] = (counts[name] || 0) + 1;
    if (failAt === `${name}:${counts[name]}`) throw new Error('sensitive engine output must never escape');
    return value;
  };
  return { calls, deps: {
    validate: () => invoke('target', {}),
    verify: () => invoke('artifact', true),
    certify: (mode) => invoke(mode, true),
    prepare: () => invoke('tls', {}),
    deploy: () => invoke('deploy', ''),
    cleanup: () => invoke('cleanup', undefined),
    cancelled: () => false,
  } };
}

test('full call order: two pre-checks, final artifact verification, one deploy and mandatory post', async () => {
  const { deps, calls } = harness();
  const result = await runIncremental(deps, () => {});
  assert.equal(result.pass, true);
  assert.deepEqual(calls, ['target', 'artifact', PRE, 'tls', 'target', PRE, 'artifact', 'deploy', POST, 'cleanup']);
});

for (const stage of ['target:1', 'artifact:1', `${PRE}:1`, 'tls:1', 'target:2', `${PRE}:2`, 'artifact:2']) {
  test(`no mutation after failed ${stage}`, async () => {
    const { deps, calls } = harness(stage);
    const report = [];
    const result = await runIncremental(deps, (...args) => report.push(args));
    assert.equal(result.pass, false);
    assert.equal(result.attempted, false);
    assert.equal(calls.includes('deploy'), false);
    assert.equal(calls.includes(POST), false);
    assert.doesNotMatch(JSON.stringify(report), /sensitive engine/);
    if (stage.endsWith(':2')) assert.equal(calls.at(-1), 'cleanup');
  });
}

test('false artifact or pending-set certification result cannot fall through', async () => {
  for (const key of ['verify', 'certify']) {
    const { deps, calls } = harness();
    deps[key] = () => false;
    assert.equal((await runIncremental(deps, () => {})).pass, false);
    assert.equal(calls.includes('deploy'), false);
  }
});

test('deploy failure is never retried; post evidence cannot overwrite original failure', async () => {
  for (const postFails of [false, true]) {
    const { deps, calls } = harness('deploy:1');
    if (postFails) {
      deps.certify = (mode) => { calls.push(mode); if (mode === POST) throw new Error('post failure'); return true; };
    }
    const result = await runIncremental(deps, () => {});
    assert.equal(result.failure, 'DEPLOY_FAILED');
    assert.equal(result.pass, false);
    assert.equal(calls.filter((call) => call === 'deploy').length, 1);
    assert.equal(calls.filter((call) => call === POST).length, 1);
    assert.equal(calls.at(-1), 'cleanup');
  }
});

test('exit zero from deploy without complete post evidence fails', async () => {
  const { deps, calls } = harness(`${POST}:1`);
  const result = await runIncremental(deps, () => {});
  assert.equal(result.failure, 'POST_CERTIFICATION_FAILED');
  assert.equal(calls.filter((call) => call === 'deploy').length, 1);
});

test('cleanup failure blocks success and cancellation blocks dispatch', async () => {
  const first = harness('cleanup:1');
  assert.equal((await runIncremental(first.deps, () => {})).failure, 'TEMPORARY_CA_CLEANUP_FAILED');
  const second = harness();
  second.deps.cancelled = () => true;
  const result = await runIncremental(second.deps, () => {});
  assert.equal(result.pass, false);
  assert.equal(second.calls.includes('deploy'), false);
  assert.equal(second.calls.at(-1), 'cleanup');
});

const env = {
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'mottapedro/mobility-platform',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), RUNNER_TEMP: os.tmpdir(),
  GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
  DATABASE_URL: 'postgresql://postgres.jfuojmuyggmnlsxfyvby:fake%40password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?schema=public&sslmode=verify-full',
};

test('target rejection precedes CA preparation for arbitrary host/project/database/direct endpoint', () => {
  for (const url of [env.DATABASE_URL.replace('jfuojmuyggmnlsxfyvby', 'wrong'),
    env.DATABASE_URL.replace('/postgres?', '/other?'), env.DATABASE_URL.replace(':5432', ':6543'),
    env.DATABASE_URL.replace('aws-0-us-east-1.pooler.supabase.com', 'db.jfuojmuyggmnlsxfyvby.supabase.co'),
    `${env.DATABASE_URL}&host=other`, `${env.DATABASE_URL}&sslaccept=accept_invalid_certs`]) {
    assert.throws(() => validateExecution({ ...env, DATABASE_URL: url }), /TARGET_REJECTED/);
  }
  assert.throws(() => validateExecution({ ...env, E2E_CA_CERT: 'invalid' }), /CA_CERTIFICATE_REJECTED/);
  assert.throws(() => validateExecution({ ...env, GITHUB_EVENT_NAME: 'push' }), /WORKFLOW_IDENTITY_REJECTED/);
  assert.throws(() => validateExecution({ ...env, GITHUB_RUN_ATTEMPT: '2' }), /RUN_IDENTITY_REJECTED/);
});

test('TLS construction preserves all endpoint/credential components and requires strict CA validation', () => {
  const original = new URL(env.DATABASE_URL);
  original.search = '';
  const file = caPath(env);
  const connection = new URL(prismaConnection(original.toString(), file));
  for (const key of ['protocol', 'hostname', 'port', 'username', 'password', 'pathname']) {
    assert.equal(connection[key], original[key]);
  }
  assert.deepEqual([...connection.searchParams], [['sslmode', 'require'], ['sslaccept', 'strict'], ['sslcert', file]]);
});

test('production CA lifecycle uses an exclusive temporary file and removes it without credentials on disk', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-ca-test-'));
  const local = { ...env, RUNNER_TEMP: temp, E2E_CA_CERT: require('node:tls').rootCertificates[0] };
  const deps = productionDependencies(local, new AbortController().signal, async () => assert.fail('no process required'));
  try {
    const target = deps.validate();
    const childEnv = deps.prepare(target);
    assert.equal(fs.readFileSync(caPath(local), 'utf8'), local.E2E_CA_CERT);
    assert.doesNotMatch(fs.readFileSync(caPath(local), 'utf8'), /fake.*password/);
    assert.equal(new URL(childEnv.DATABASE_URL).searchParams.get('sslaccept'), 'strict');
    assert.throws(() => deps.prepare(target), /EEXIST/);
    deps.cleanup();
    assert.equal(fs.existsSync(caPath(local)), false);
    deps.cleanup();
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('child environment excludes alternate datasource, dotenv/preload, engine and TLS overrides', () => {
  const result = isolatedEnvironment({ ...env, DIRECT_URL: 'forbidden', NODE_OPTIONS: '--require attacker',
    NODE_TLS_REJECT_UNAUTHORIZED: '0', PRISMA_SCHEMA_ENGINE_BINARY: 'attacker', PGHOST: 'other',
    GITHUB_OUTPUT: 'unowned-file', RANDOM_SECRET: 'hidden' });
  for (const key of ['DIRECT_URL', 'DATABASE_URL', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'PRISMA_SCHEMA_ENGINE_BINARY', 'PGHOST', 'GITHUB_OUTPUT', 'RANDOM_SECRET']) assert.equal(result[key], undefined);
});

test('production spawn seam invokes only the local Prisma CLI with fixed config and no shell', async () => {
  const calls = [];
  const deps = productionDependencies(env, new AbortController().signal, async (...args) => { calls.push(args); return ''; });
  const childEnv = { DATABASE_URL: 'fake', PRISMA_MIGRATIONS_PATH: '/fixed/catalog' };
  await deps.deploy(childEnv);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], [path.resolve('node_modules/prisma/build/index.js'),
    'migrate', 'deploy', '--config', 'scripts/prisma.bootstrap.ts']);
  assert.equal(calls[0][1], childEnv);
});

test('certification process exit and exact success token are both required', async () => {
  for (const mode of [PRE, POST]) {
    for (const output of ['', 'INCREMENTAL_CERTIFICATION_RESULT=PASS', `INCREMENTAL_CERTIFICATION_RESULT=${PRE}:PASS\nINCREMENTAL_CERTIFICATION_RESULT=${POST}:PASS`]) {
      await assert.rejects(certify(mode, env, async () => output), /CERTIFICATION_INCOMPLETE/);
    }
    await assert.rejects(certify(mode, env, async () => { throw new Error('exit nonzero'); }), /exit nonzero/);
    assert.equal(await certify(mode, env, async (args, childEnv) => {
      assert.deepEqual(args.slice(-2), ['--mode', mode]);
      assert.equal(childEnv.DIRECT_URL, undefined);
      return `INCREMENTAL_CERTIFICATION_RESULT=${mode}:PASS\n`;
    }), true);
  }
});

test('artifact path is exact and rejects source-tree fallback; manifest mismatch stops before verifier', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-artifact-test-'));
  const root = path.join(temp, 'authorized-migration-catalog');
  const catalog = path.join(root, 'catalog');
  fs.mkdirSync(catalog, { recursive: true });
  const fixtureEnv = { ...env, RUNNER_TEMP: temp, PRISMA_MIGRATIONS_PATH: catalog };
  try {
    assert.equal(assertArtifactPath(fixtureEnv), catalog);
    for (const wrong of ['prisma/migrations', path.resolve('prisma/migrations'), `${catalog}-other`]) {
      assert.throws(() => assertArtifactPath({ ...fixtureEnv, PRISMA_MIGRATIONS_PATH: wrong }), /ARTIFACT_PATH_REJECTED/);
    }
    fs.writeFileSync(path.join(root, 'manifest'), `commit_sha=${env.GITHUB_SHA}\ncatalog_count=56\nfingerprint=wrong\n`);
    await assert.rejects(verifyArtifact(fixtureEnv, async () => assert.fail('no verifier after mismatch')), /ARTIFACT_MANIFEST_REJECTED/);
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('real local materializer and verifier accept the artifact then reject modified SQL bytes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-roundtrip-test-'));
  const root = path.join(temp, 'authorized-migration-catalog');
  const catalog = path.join(root, 'catalog');
  const fixtureEnv = { ...env, RUNNER_TEMP: temp, PRISMA_MIGRATIONS_PATH: catalog };
  try {
    execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'),
      'scripts/materialize-authorized-migration-catalog.ts', '--output-dir', root, '--verify-fingerprint'],
    { env: { ...isolatedEnvironment(process.env), GITHUB_SHA: env.GITHUB_SHA }, stdio: 'pipe' });
    assert.equal(await verifyArtifact(fixtureEnv), true);
    const name = fs.readdirSync(catalog, { withFileTypes: true }).find((entry) => entry.isDirectory()).name;
    fs.appendFileSync(path.join(catalog, name, 'migration.sql'), '\n-- test-only artifact tampering\n');
    await assert.rejects(verifyArtifact(fixtureEnv), /LOCAL_PROCESS_FAILED/);
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('workflow YAML, mutation count and static authority boundaries', () => {
  const text = fs.readFileSync('.github/workflows/supabase-e2e-incremental-migrate-deploy.yml', 'utf8');
  const workflow = yaml.load(text);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.equal(Object.keys(workflow.jobs).length, 1);
  const job = workflow.jobs['incremental-promotion'];
  assert.equal(job.environment, 'supabase-e2e-migration');
  assert.equal(job.strategy, undefined);
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.concurrency.group, 'supabase-e2e-persistent-migration-jfuojmuyggmnlsxfyvby');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual([...text.matchAll(/secrets\.(\w+)/g)].map((match) => match[1]).sort(),
    ['OFFER_BOOK_SUPABASE_E2E_CA_CERT', 'OFFER_BOOK_SUPABASE_E2E_DATABASE_URL']);
  assert.equal(job.steps[0].with.ref, '${{ github.sha }}');
  assert.match(text, /npm ci --include=dev --ignore-scripts/);
  assert.match(text, /\$RUNNER_TEMP\/authorized-migration-catalog/);
  assert.match(text, /PRISMA_MIGRATIONS_PATH=\$artifact_root\/catalog/);
  const source = fs.readFileSync('scripts/e2e/supabase-e2e-incremental-migrate-deploy.cjs', 'utf8');
  assert.equal((source.match(/'migrate', 'deploy'/g) || []).length, 1);
  assert.match(source, /'--config', 'scripts\/prisma.bootstrap.ts'/);
  assert.doesNotMatch(source + text, /DIRECT_URL|migrate\s+resolve|db\s+push|baseline-resolve|seed\b|backfill\b|db\s+execute/i);
  assert.doesNotMatch(source + text, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\s+(?:TABLE|TYPE|INDEX|INTO|FROM)\b/i);
  assert.doesNotMatch(text, /inputs\.|workflow_call|pull_request|--force|continue-on-error/);
  assert.equal(FINGERPRINT, fs.readFileSync('governance/authorized-migration-catalog.sha256', 'utf8').trim());
});
