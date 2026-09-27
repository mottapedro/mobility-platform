'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrchestrator, runHistoricalReconciliationProof } = require('../../scripts/gates/historical-reconciliation-proof.cjs');
const {
  HISTORICAL_COUNT,
  HISTORICAL_FINGERPRINT,
  MANIFEST_SHA256,
  fingerprintEntries,
  loadAndVerifyManifest,
  loadGovernedHistoricalSet,
  normalizedSqlBytes,
  validateManifestDocument,
  verifyPhysicalArtifacts,
} = require('../../scripts/gates/historical-execution-manifest.cjs');

const repositoryRoot = path.resolve(__dirname, '../..');
const runnerPath = path.join(repositoryRoot, 'scripts/gates/diagnostic-process-runner.cjs');
const runnerSha256 = crypto.createHash('sha256').update(fs.readFileSync(runnerPath)).digest('hex').toUpperCase();

function setupOrchestrator(overrides = {}) {
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-proof-orchestrator-'));
  const calls = [];
  const runner = {
    runCommand(request, suppliedEvidenceRoot) {
      calls.push({ request, evidenceRoot: suppliedEvidenceRoot });
      return Promise.resolve({ exitCode: 0, evidenceFile: path.join(suppliedEvidenceRoot, `${request.commandId}.jsonl`) });
    },
  };
  const orchestrator = createOrchestrator({
    repositoryRoot, evidenceDir: evidenceRoot, runner, runnerPath,
    expectedRunnerSha256: runnerSha256,
    expectedCatalogFingerprint: 'CATALOG_OK', currentHead: 'HEAD_OK', expectedHead: 'HEAD_OK',
    catalogFingerprint: 'CATALOG_OK', runId: 'test-run', ...overrides,
  });
  return { orchestrator, calls, evidenceRoot };
}

function genericStep(sequence, commandId = `step-${sequence}`) {
  return { sequence, stepId: `P${sequence}`, commandId, executable: 'synthetic', args: [] };
}

function createRequest(overrides = {}) {
  const calls = [];
  const evidenceRoot = overrides.evidenceRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'r7c-r13-contract-'));
  const runner = {
    runCommand(request) {
      calls.push(request);
      const stdout = request.commandId === 'empty-state' || request.commandId === 'migration-table-presence'
        ? '0\n'
        : '';
      return Promise.resolve({
        exitCode: request.commandId === overrides.failCommandId ? 11 : 0,
        status: request.commandId === overrides.failCommandId ? 'FAILED' : 'COMPLETED',
        signal: null,
        stdout,
        stderr: request.commandId === overrides.failCommandId ? 'synthetic failure' : '',
        evidenceFile: path.join(evidenceRoot, `${request.commandId}.jsonl`),
      });
    },
  };
  const request = {
    runId: 'runtime-test',
    evidenceRoot,
    databaseConnectionMaterial: { DATABASE_URL: 'synthetic-secret' },
    expectedDatabaseIdentity: { databaseName: 'ephemeral-test', postgresMajor: 15 },
    runner,
    runnerPath,
    expectedRunnerSha256: runnerSha256,
    currentHead: 'EXPECTED_HEAD',
    expectedHead: 'EXPECTED_HEAD',
    commands: {
      targetIdentity: { executable: 'synthetic-target', args: ['identity'] },
      emptyState: { executable: 'synthetic-inspector', args: ['empty'] },
      migrationTable: { executable: 'synthetic-inspector', args: ['ledger'] },
      baseline: { executable: 'synthetic-baseline', args: ['baseline'] },
      baselineLedger: { executable: 'synthetic-baseline', args: ['ledger'] },
    },
    ...overrides,
  };
  return { request, calls };
}

test('R7C_ORCHESTRATOR_MAPS_RUNNER_ARGUMENTS_AND_EVIDENCE_ROOT', async () => {
  const { orchestrator, calls, evidenceRoot } = setupOrchestrator();
  await orchestrator.invokeProofCommand(genericStep(1));
  assert.deepEqual(Object.keys(calls[0].request).sort(), ['args', 'commandId', 'cwd', 'executable', 'runId', 'sequence']);
  assert.equal(calls[0].evidenceRoot, evidenceRoot);
  assert.equal(calls[0].request.cwd, repositoryRoot);
});

test('R7C_ORCHESTRATOR_STOPS_AT_FIRST_FAILED_STEP_WITHOUT_RETRY', async () => {
  let attempts = 0;
  const { orchestrator } = setupOrchestrator({
    runner: { runCommand(request) { attempts += 1; return Promise.resolve({ exitCode: request.commandId === 'fail' ? 9 : 0 }); } },
  });
  const result = await orchestrator.runPlan([genericStep(1), genericStep(2, 'fail'), genericStep(3)]);
  assert.equal(result.length, 2);
  assert.equal(attempts, 2);
});

test('R7C_PREFLIGHT_MISMATCH_PREVENTS_RUNNER_EXECUTION', async () => {
  const { orchestrator, calls } = setupOrchestrator({ catalogFingerprint: 'WRONG' });
  const result = await orchestrator.preflight({ executable: process.execPath, args: ['-e', ''] });
  assert.equal(result.catalogFingerprintMatch, false);
  assert.equal(result.databaseProofReady, false);
  assert.equal(calls.length, 0);
});

test('R5_INSPECTION_PLAN_AND_FACTS_REMAIN_FAIL_CLOSED', async () => {
  const { orchestrator, calls } = setupOrchestrator();
  const plan = orchestrator.buildInspectionPlan({
    targetIdentity: { executable: 'psql', args: ['identity'] },
    emptyState: { executable: 'psql', args: ['empty'] },
    migrationTable: { executable: 'psql', args: ['ledger'] },
  });
  await orchestrator.runPlan(plan);
  assert.deepEqual(calls.map(({ request }) => request.commandId), ['target-identity', 'empty-state', 'migration-table-presence']);
  assert.equal(orchestrator.deriveEmptyDatabase({ exitCode: 0, stdout: '0\n', stderr: '' }).value, 'YES');
  assert.equal(orchestrator.deriveEmptyDatabase({ exitCode: 0, stdout: '1\n', stderr: '' }).value, 'NO');
  assert.equal(orchestrator.deriveEmptyDatabase({ exitCode: 7, stdout: '', stderr: 'failed' }).value, 'UNKNOWN');
  assert.equal(orchestrator.deriveMigrationTablePresence({ exitCode: 0, stdout: '0\n', stderr: '' }).value, 'NO');
  assert.equal(orchestrator.deriveMigrationTablePresence({ exitCode: 0, stdout: 'bad', stderr: '' }).value, 'UNKNOWN');
});

test('R7C_ORCHESTRATOR_HAS_NO_DIRECT_DATABASE_OR_CHILD_PROCESS_EXECUTION', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts/gates/historical-reconciliation-proof.cjs'), 'utf8');
  assert.equal(/spawnSync|execSync|execFileSync|docker exec|migrate deploy/i.test(source), false);
  assert.equal((source.match(/runner\.runCommand\(/g) || []).length, 1);
});

test('R13A_MANIFEST_IDENTITY_AND_EXECUTION_SET_ARE_VALID', () => {
  const governed = loadAndVerifyManifest(repositoryRoot);
  assert.equal(governed.manifestSha256, MANIFEST_SHA256);
  assert.equal(governed.entries.length, HISTORICAL_COUNT);
  assert.equal(governed.historicalCatalogFingerprint, HISTORICAL_FINGERPRINT);
  assert.equal(fingerprintEntries(governed.entries), HISTORICAL_FINGERPRINT);
});

test('R13A_PUBLIC_RUNTIME_BINDS_MANIFEST_EXECUTION_SET_TO_GOVERNED_RUNNER', async () => {
  const { request, calls } = createRequest();
  const result = await runHistoricalReconciliationProof(request);
  const manifestNames = loadAndVerifyManifest(repositoryRoot).entries.map((entry) => entry.folderName);
  const historicalCalls = calls.filter((call) => call.commandId.startsWith('historical-'));
  assert.equal(result.status, 'ALL_HISTORICAL_PASS');
  assert.equal(result.executionSetCount, HISTORICAL_COUNT);
  assert.equal(result.historicalSucceededCount, HISTORICAL_COUNT);
  assert.equal(historicalCalls.length, HISTORICAL_COUNT);
  assert.deepEqual(historicalCalls.map((call) => path.basename(path.dirname(call.args[1]))), manifestNames);
  assert.deepEqual(historicalCalls.map((call) => call.commandId), manifestNames.map((_, index) => `historical-${String(index + 1).padStart(2, '0')}`));
  assert.equal(historicalCalls.every((call) => call.executable === process.execPath), true);
  assert.deepEqual(historicalCalls.map((call) => call.args[0]), manifestNames.map(() => path.join(repositoryRoot, 'scripts', 'apply-sql-migration.cjs')));
  assert.deepEqual(historicalCalls.map((call) => call.args[1]), manifestNames.map((name) => path.join(repositoryRoot, 'prisma', 'migrations', name, 'migration.sql')));
});

test('R13A_VALID_PHYSICAL_FIXTURE_BINDS_TO_MANIFEST_HASH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r7c-physical-valid-'));
  const name = '20260421003315_init';
  const sqlPath = path.join(root, 'prisma/migrations', name, 'migration.sql');
  const sql = Buffer.from('SELECT 1;\r\n');
  fs.mkdirSync(path.dirname(sqlPath), { recursive: true });
  fs.writeFileSync(sqlPath, sql);
  const normalizedHash = crypto.createHash('sha256').update(normalizedSqlBytes(sql)).digest('hex');
  const verified = verifyPhysicalArtifacts(root, [{ sequence: 1, folderName: name, normalizedSqlHash: normalizedHash }]);
  assert.equal(verified[0].sqlPath, sqlPath);
  assert.equal(verified[0].normalizedSqlHash, normalizedHash);
});

test('R13A_CALLER_CANNOT_SUBSTITUTE_EXECUTION_MEMBERSHIP_ORDER_OR_FACTORY', async () => {
  const names = loadAndVerifyManifest(repositoryRoot).entries.map((entry) => entry.folderName);
  const attempts = [
    { historicalMigrations: ['fake'] },
    { historicalMigrations: names.slice(0, 42) },
    { historicalMigrations: [...names, '20260921000000_not_authorized'] },
    { historicalMigrations: [...names].reverse() },
    { historicalMigrations: names.map((name, index) => index === 4 ? `${name}_substituted` : name) },
    { historicalOrder: ['reordered'] },
    { migrationCatalog: ['substituted'] },
    { migrationSqlPath: 'outside.sql' },
    { migrationSqlHash: '0'.repeat(64) },
    { historicalCommandFactory: () => ({ executable: 'evil', args: [] }) },
    { repositoryRoot: os.tmpdir() },
    { commands: { ...createRequest().request.commands, historical: () => ({ executable: 'evil', args: [] }) } },
  ];
  for (const addition of attempts) {
    const { request, calls } = createRequest(addition);
    await assert.rejects(() => runHistoricalReconciliationProof(request), /forbidden|only governed non-historical|unknown runtime request field/);
    assert.equal(calls.length, 0);
  }
});

test('R13A_CALLER_CANNOT_OVERRIDE_MANIFEST_IDENTITY', async () => {
  const { request, calls } = createRequest({
    manifestPath: path.join(os.tmpdir(), 'attacker-manifest.json'),
    expectedManifestSha256: '0'.repeat(64),
    catalogFingerprint: 'caller-selected',
    expectedCatalogFingerprint: 'caller-selected',
  });
  await assert.rejects(() => runHistoricalReconciliationProof(request), /caller-controlled execution input is forbidden/);
  assert.equal(calls.length, 0);
});

test('R13A_MANIFEST_SHA_MISMATCH_FAILS_BEFORE_ANY_RUNNER_CALL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r7c-manifest-hash-'));
  fs.mkdirSync(path.join(root, 'governance'), { recursive: true });
  const source = fs.readFileSync(path.join(repositoryRoot, 'governance/r7c-r13-historical-execution-manifest.json'));
  fs.writeFileSync(path.join(root, 'governance/r7c-r13-historical-execution-manifest.json'), Buffer.concat([source, Buffer.from(' ')]));
  assert.throws(() => loadGovernedHistoricalSet(root), /MANIFEST_SHA256_MISMATCH/);
});

test('R13A_HISTORICAL_FINGERPRINT_MISMATCH_IS_REJECTED', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'governance/r7c-r13-historical-execution-manifest.json'), 'utf8'));
  manifest.catalog[0].normalizedSqlHash = '0'.repeat(64);
  assert.throws(() => validateManifestDocument(manifest), /HISTORICAL_FINGERPRINT_MISMATCH/);
});

test('R13A_PHYSICAL_SQL_HASH_MISMATCH_IS_REJECTED', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r7c-physical-hash-'));
  const name = '20260421003315_init';
  const migrationDir = path.join(root, 'prisma/migrations', name);
  fs.mkdirSync(migrationDir, { recursive: true });
  fs.writeFileSync(path.join(migrationDir, 'migration.sql'), 'SELECT 2;\n');
  assert.throws(() => verifyPhysicalArtifacts(root, [{
    sequence: 1,
    folderName: name,
    normalizedSqlHash: '0'.repeat(64),
  }]), /MIGRATION_SQL_HASH_MISMATCH/);
});

test('R13A_SQL_NORMALIZATION_CONVERTS_CRLF_TO_LF', () => {
  assert.deepEqual(normalizedSqlBytes(Buffer.from('SELECT 1;\r\nSELECT 2;\r\n')), Buffer.from('SELECT 1;\nSELECT 2;\n'));
});

test('R13A_SECRET_VALUE_IS_NOT_RETURNED', async () => {
  const { request } = createRequest();
  const result = await runHistoricalReconciliationProof(request);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});
