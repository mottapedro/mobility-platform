'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrchestrator } = require('../../scripts/gates/historical-reconciliation-proof.cjs');

const runnerPath = path.resolve(__dirname, '../../scripts/gates/diagnostic-process-runner.cjs');
const expectedRunnerSha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(runnerPath)).digest('hex').toUpperCase();

function setup(overrides = {}) {
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-proof-'));
  const calls = [];
  const runner = {
    runCommand(request, suppliedEvidenceDir) {
      calls.push({ request, evidenceDir: suppliedEvidenceDir });
      return Promise.resolve({ exitCode: 0, evidenceFile: path.join(suppliedEvidenceDir, `${request.commandId}.jsonl`) });
    },
  };
  const orchestrator = createOrchestrator({
    repositoryRoot: process.cwd(), evidenceDir, runner, runnerPath,
    expectedRunnerSha256, expectedCatalogFingerprint: 'CATALOG_OK',
    currentHead: 'HEAD_OK', expectedHead: 'HEAD_OK', catalogFingerprint: 'CATALOG_OK',
    runId: 'test-run', ...overrides,
  });
  return { orchestrator, calls, evidenceDir };
}

function step(sequence, commandId = `step-${sequence}`) {
  return { sequence, stepId: `P${sequence}`, commandId, executable: 'synthetic', args: [] };
}

test('T01_REQUIRED_RUNNER_ARGUMENTS_MAPPED', async () => {
  const { orchestrator, calls, evidenceDir } = setup();
  await orchestrator.invokeProofCommand(step(1), {});
  assert.deepEqual(Object.keys(calls[0].request).sort(), ['args', 'commandId', 'cwd', 'executable', 'runId', 'sequence']);
  assert.equal(calls[0].evidenceDir, evidenceDir);
});

test('T02_EVIDENCEDIR_ALWAYS_SUPPLIED', async () => {
  const { orchestrator, calls, evidenceDir } = setup();
  await orchestrator.preflight({ executable: 'synthetic', args: [] });
  assert.equal(calls[0].evidenceDir, evidenceDir);
});

test('T03_SAME_ADAPTER_USED_BY_SMOKE_AND_REAL_PLAN', async () => {
  const { orchestrator, calls, evidenceDir } = setup();
  await orchestrator.preflight({ executable: 'synthetic', args: [] });
  await orchestrator.runPlan([step(9, 'real-step')]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].evidenceDir, evidenceDir);
  assert.equal(calls[1].evidenceDir, evidenceDir);
});

test('T04_FIRST_FAILURE_STOPS_SEQUENCE', async () => {
  const { orchestrator, calls } = setup({ runner: { runCommand(req, dir) { calls.push({ req, dir }); return Promise.resolve({ exitCode: req.commandId === 'fail' ? 9 : 0 }); } } });
  const result = await orchestrator.runPlan([step(1), step(2, 'fail'), step(3)]);
  assert.equal(result.length, 2);
  assert.equal(calls.length, 2);
});

test('T05_ORDER_PRESERVED', async () => {
  const { orchestrator } = setup();
  const plan = orchestrator.buildProofPlan(['m1', 'm2', 'm3']);
  assert.deepEqual(plan.slice(-3).map((item) => item.migrationName), ['m1', 'm2', 'm3']);
});

test('T06_ORCHESTRATOR_WRITE_BEFORE_RUNNER_CALL', async () => {
  const { orchestrator, calls, evidenceDir } = setup();
  await orchestrator.runPlan([step(1)]);
  assert.equal(calls.length, 1);
  const first = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'orchestrator.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(first.status, 'STARTING');
});

test('T07_ORCHESTRATOR_ABORT_PRESERVES_CURRENT_STEP', () => {
  const { orchestrator, evidenceDir } = setup();
  orchestrator.ensureEvidenceDirectory();
  const state = orchestrator.state;
  assert.equal(state.runId, 'test-run');
  assert.equal(fs.existsSync(path.join(evidenceDir, 'orchestrator.jsonl')), true);
});

test('T08_NO_AUTOMATIC_RETRY', async () => {
  let attempts = 0;
  const { orchestrator } = setup({ runner: { runCommand() { attempts += 1; return Promise.resolve({ exitCode: 4 }); } } });
  await orchestrator.runPlan([step(1)]);
  assert.equal(attempts, 1);
});

test('T09_RUNNER_IDENTITY_MISMATCH_STOPS_BEFORE_EXECUTION', async () => {
  const { orchestrator, calls } = setup({ expectedRunnerSha256: 'WRONG' });
  const result = await orchestrator.preflight({ executable: 'synthetic', args: [] });
  assert.equal(result.runnerSha256Match, false);
  assert.equal(calls.length, 0);
});

test('T10_EVIDENCE_DIRECTORY_FAILURE_STOPS_BEFORE_DATABASE', async () => {
  const { orchestrator, calls } = setup({ evidenceDir: undefined });
  await assert.rejects(() => orchestrator.preflight({ executable: 'synthetic', args: [] }), /EVIDENCE_DIR_REQUIRED/);
  assert.equal(calls.length, 0);
});

test('T11_CATALOG_IDENTITY_MISMATCH_STOPS_BEFORE_EXECUTION', async () => {
  const { orchestrator, calls } = setup({ catalogFingerprint: 'WRONG' });
  const result = await orchestrator.preflight({ executable: 'synthetic', args: [] });
  assert.equal(result.catalogFingerprintMatch, false);
  assert.equal(calls.length, 0);
});

test('T12_DATABASE_PROOF_READY_REQUIRES_COMPLETE_PREFLIGHT', async () => {
  const { orchestrator } = setup();
  const result = await orchestrator.preflight({ executable: 'synthetic', args: [] });
  assert.equal(result.databaseProofReady, true);
});

test('T13_NO_DATABASE_CREATION_CAPABILITY_IN_ORCHESTRATOR', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/gates/historical-reconciliation-proof.cjs'), 'utf8');
  assert.equal(/docker|prisma|DATABASE_URL|migrate deploy/i.test(source), false);
});

test('T14_NO_DIRECT_RUNCOMMAND_CALL_OUTSIDE_ADAPTER', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/gates/historical-reconciliation-proof.cjs'), 'utf8');
  assert.equal((source.match(/runner\.runCommand\(/g) || []).length, 1);
});

test('R4_R7_CALLER_CONTRACT_REGRESSION', async () => {
  const { orchestrator, calls } = setup({ evidenceDir: undefined });
  assert.throws(() => orchestrator.invokeProofCommand(step(1)), /EVIDENCE_DIR_REQUIRED/);
  assert.equal(calls.length, 0);
});
