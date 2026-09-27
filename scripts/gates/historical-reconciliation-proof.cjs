'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  HISTORICAL_FINGERPRINT,
  loadGovernedHistoricalSet,
} = require('./historical-execution-manifest.cjs');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function durableAppend(file, record) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function buildHistoricalExecutionPlan(historicalEntries, commandScriptPath) {
  if (!Array.isArray(historicalEntries)) throw new TypeError('verified historical entries are required');
  return historicalEntries.map((entry, index) => ({
    sequence: index + 6,
    stepId: `P${String(index + 6).padStart(2, '0')}`,
    commandId: `historical-${String(index + 1).padStart(2, '0')}`,
    executable: process.execPath,
    args: [commandScriptPath, entry.sqlPath],
    position: index + 1,
    migrationName: entry.folderName,
    migrationSqlHash: entry.normalizedSqlHash,
  }));
}

function createOrchestrator(options) {
  const {
    repositoryRoot,
    evidenceDir,
    runner,
    runnerPath,
    expectedRunnerSha256,
    expectedCatalogFingerprint,
    currentHead,
    expectedHead,
    catalogFingerprint,
  } = options;
  const state = {
    runId: options.runId || `proof-${crypto.randomBytes(8).toString('hex')}`,
    sequence: 0,
    evidenceDir,
    repositoryRoot,
  };
  const stateFile = evidenceDir ? path.join(evidenceDir, 'orchestrator.jsonl') : undefined;

  function ensureEvidenceDirectory() {
    if (typeof evidenceDir !== 'string' || evidenceDir.length === 0) throw new Error('EVIDENCE_DIR_REQUIRED');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.accessSync(evidenceDir, fs.constants.W_OK);
    if (stateFile && !fs.existsSync(stateFile)) fs.closeSync(fs.openSync(stateFile, 'a'));
  }

  function invokeProofCommand(step, context = {}) {
    ensureEvidenceDirectory();
    if (!runner || typeof runner.runCommand !== 'function') throw new Error('RUNNER_API_UNAVAILABLE');
    const request = {
      runId: state.runId,
      sequence: step.sequence,
      commandId: step.commandId,
      executable: step.executable,
      args: [...step.args],
      cwd: repositoryRoot,
    };
    if (context.envAdditions) request.envAdditions = { ...context.envAdditions };
    return runner.runCommand(request, evidenceDir);
  }

  function writeAhead(step) {
    ensureEvidenceDirectory();
    state.sequence = step.sequence;
    durableAppend(stateFile, {
      proofRunId: state.runId,
      proofSequence: step.sequence,
      proofStepId: step.stepId,
      migrationPosition: step.position ?? null,
      migrationName: step.migrationName ?? null,
      migrationSqlHash: step.migrationSqlHash ?? null,
      status: 'STARTING',
      runnerCommandId: step.commandId,
      evidenceDir,
      startedAt: new Date().toISOString(),
    });
  }

  async function runPlan(steps, context = {}) {
    const results = [];
    for (const step of steps) {
      writeAhead(step);
      try {
        const result = await invokeProofCommand(step, context);
        durableAppend(stateFile, {
          proofRunId: state.runId,
          proofSequence: step.sequence,
          proofStepId: step.stepId,
          status: result && result.exitCode === 0 ? 'COMPLETED' : 'FAILED',
          runnerResultReference: result?.evidenceFile || null,
          exitCode: result?.exitCode ?? null,
          finishedAt: new Date().toISOString(),
        });
        results.push({ step, result });
        if (!result || result.exitCode !== 0) break;
      } catch (error) {
        durableAppend(stateFile, {
          proofRunId: state.runId,
          proofSequence: step.sequence,
          proofStepId: step.stepId,
          status: 'FAILED',
          runnerResultReference: error.evidenceFile || null,
          exitCode: error.evidence?.exitCode ?? null,
          error: error.message,
          finishedAt: new Date().toISOString(),
        });
        results.push({ step, error });
        break;
      }
    }
    return results;
  }

  function buildInspectionPlan(commands) {
    if (!commands || typeof commands !== 'object') throw new TypeError('inspection commands are required');
    const required = ['targetIdentity', 'emptyState', 'migrationTable'];
    required.forEach((key) => {
      if (!commands[key] || typeof commands[key].executable !== 'string' || !Array.isArray(commands[key].args)) {
        throw new TypeError(`invalid inspection command: ${key}`);
      }
    });
    return [
      { sequence: 1, stepId: 'P01', commandId: 'target-identity', executable: commands.targetIdentity.executable, args: [...commands.targetIdentity.args] },
      { sequence: 2, stepId: 'P02', commandId: 'empty-state', executable: commands.emptyState.executable, args: [...commands.emptyState.args] },
      { sequence: 3, stepId: 'P03', commandId: 'migration-table-presence', executable: commands.migrationTable.executable, args: [...commands.migrationTable.args] },
    ];
  }

  function deriveInspectionFact(result, commandId, parse) {
    if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
      return { value: 'UNKNOWN', sourceCommandId: commandId };
    }
    return { value: parse(result.stdout), sourceCommandId: commandId };
  }

  function deriveEmptyDatabase(result) {
    const fact = deriveInspectionFact(result, 'empty-state', (stdout) => {
      const value = stdout.trim();
      if (value !== '0' && value !== '1') return 'UNKNOWN';
      return value === '0' ? 'YES' : 'NO';
    });
    if (fact.value === 'UNKNOWN') return fact;
    return fact;
  }

  function deriveMigrationTablePresence(result) {
    return deriveInspectionFact(result, 'migration-table-presence', (stdout) => {
      const value = stdout.trim();
      if (value !== '0' && value !== '1') return 'UNKNOWN';
      return value === '1' ? 'YES' : 'NO';
    });
  }

  async function preflight(smoke) {
    ensureEvidenceDirectory();
    const repositoryHeadMatch = currentHead === expectedHead;
    const runnerSha256 = sha256File(runnerPath);
    const runnerSha256Match = runnerSha256 === expectedRunnerSha256;
    const catalogFingerprintMatch = catalogFingerprint === expectedCatalogFingerprint;
    const smokeStep = {
      sequence: 0,
      stepId: 'PREFLIGHT-SMOKE',
      commandId: 'runner-smoke',
      executable: smoke.executable,
      args: [...smoke.args],
    };
    const smokeResult = repositoryHeadMatch && runnerSha256Match && catalogFingerprintMatch
      ? await runPlan([smokeStep], smoke.envAdditions ? { envAdditions: smoke.envAdditions } : {})
      : [];
    const runnerSmokePass = smokeResult.length === 1 && smokeResult[0].result?.exitCode === 0;
    return {
      repositoryHeadMatch,
      runnerSha256,
      runnerSha256Match,
      catalogFingerprintMatch,
      evidenceDirectoryWritable: true,
      runnerSmokePass,
      databaseProofReady: repositoryHeadMatch && runnerSha256Match && catalogFingerprintMatch && runnerSmokePass,
      smokeResult,
    };
  }

  return {
    buildInspectionPlan,
    deriveEmptyDatabase,
    deriveMigrationTablePresence,
    ensureEvidenceDirectory,
    invokeProofCommand,
    preflight,
    runPlan,
    state,
  };
}

const FORBIDDEN_EXECUTION_INPUTS = [
  'historicalMigrations', 'historicalOrder', 'migrationNames', 'migrationCatalog',
  'migrationSqlPath', 'migrationSqlHash', 'historicalCommandFactory', 'manifestPath',
  'expectedManifestSha256', 'catalogFingerprint', 'expectedCatalogFingerprint',
];

async function runHistoricalReconciliationProof(request) {
  if (!request || typeof request !== 'object') throw new TypeError('runtime request is required');
  const forbidden = FORBIDDEN_EXECUTION_INPUTS.find((key) => Object.hasOwn(request, key));
  if (forbidden) throw new TypeError(`caller-controlled execution input is forbidden: ${forbidden}`);
  const allowedRequestKeys = new Set([
    'runId', 'evidenceRoot', 'databaseConnectionMaterial', 'expectedDatabaseIdentity',
    'commands', 'runner', 'runnerPath', 'expectedRunnerSha256', 'currentHead', 'expectedHead', 'smoke',
  ]);
  const unknownRequestKey = Object.keys(request).find((key) => !allowedRequestKeys.has(key));
  if (unknownRequestKey) throw new TypeError(`unknown runtime request field: ${unknownRequestKey}`);
  const required = ['runId', 'evidenceRoot', 'databaseConnectionMaterial', 'expectedDatabaseIdentity'];
  required.forEach((key) => {
    if (request[key] === undefined || request[key] === null) throw new TypeError(`missing runtime field: ${key}`);
  });
  if (!request.commands || typeof request.commands !== 'object') throw new TypeError('runtime commands are required');
  const commandKeys = ['targetIdentity', 'emptyState', 'migrationTable', 'baseline', 'baselineLedger'];
  if (JSON.stringify(Object.keys(request.commands).sort()) !== JSON.stringify([...commandKeys].sort())) {
    throw new TypeError('runtime command set must contain only governed non-historical commands');
  }
  commandKeys.forEach((key) => {
    if (!request.commands[key] || typeof request.commands[key].executable !== 'string' || !Array.isArray(request.commands[key].args)) {
      throw new TypeError(`invalid runtime command: ${key}`);
    }
  });

  const repositoryRoot = path.resolve(__dirname, '..', '..');
  const terminal = (status, extra = {}) => ({ status, runId: request.runId, evidenceRoot: request.evidenceRoot, ...extra });
  let governedSet;
  try {
    governedSet = loadGovernedHistoricalSet(repositoryRoot);
  } catch (error) {
    return terminal('MANIFEST_VALIDATION_FAILURE', { errorCode: error.message });
  }

  const orchestrator = createOrchestrator({
    repositoryRoot,
    evidenceDir: request.evidenceRoot,
    runner: request.runner,
    runnerPath: request.runnerPath,
    expectedRunnerSha256: request.expectedRunnerSha256,
    expectedCatalogFingerprint: HISTORICAL_FINGERPRINT,
    currentHead: request.currentHead,
    expectedHead: request.expectedHead,
    catalogFingerprint: governedSet.historicalCatalogFingerprint,
    runId: request.runId,
  });
  const envAdditions = { ...request.databaseConnectionMaterial };
  const historicalPlan = buildHistoricalExecutionPlan(
    governedSet.entries,
    path.join(repositoryRoot, 'scripts', 'apply-sql-migration.cjs'),
  );
  const preflight = await orchestrator.preflight(request.smoke || { executable: process.execPath, args: ['-e', "process.stdout.write('PROOF_SMOKE')"] });
  const manifestEvidence = {
    manifestSha256: governedSet.manifestSha256,
    historicalCatalogFingerprint: governedSet.historicalCatalogFingerprint,
    promotedFullCatalogFingerprint: governedSet.promotedFullCatalogFingerprint,
    executionSetCount: governedSet.entries.length,
  };
  if (!preflight.databaseProofReady) return terminal('PREFLIGHT_FAILURE', { preflight, ...manifestEvidence });
  const inspectionSteps = orchestrator.buildInspectionPlan({
    targetIdentity: request.commands.targetIdentity,
    emptyState: request.commands.emptyState,
    migrationTable: request.commands.migrationTable,
  });
  const inspections = await orchestrator.runPlan(inspectionSteps, { envAdditions });
  const target = inspections[0]?.result;
  const empty = inspections[1]?.result;
  const migrationTable = inspections[2]?.result;
  if (!target || target.exitCode !== 0) return terminal('TARGET_IDENTITY_FAILURE', { preflight, inspections, ...manifestEvidence });
  const emptyDatabase = orchestrator.deriveEmptyDatabase(empty);
  if (emptyDatabase.value !== 'YES') return terminal('EMPTY_STATE_FAILURE', { preflight, inspections, emptyDatabase, ...manifestEvidence });
  const prismaMigrationsTable = orchestrator.deriveMigrationTablePresence(migrationTable);
  if (prismaMigrationsTable.value !== 'NO') {
    return terminal('PRISMA_LEDGER_INSPECTION_FAILURE', { preflight, inspections, emptyDatabase, prismaMigrationsTable, ...manifestEvidence });
  }
  const baseline = (await orchestrator.runPlan([{ sequence: 4, stepId: 'P04', commandId: 'baseline-materialization', ...request.commands.baseline }], { envAdditions }))[0];
  if (!baseline?.result || baseline.result.exitCode !== 0) return terminal('BASELINE_MATERIALIZATION_FAILURE', { preflight, inspections, emptyDatabase, prismaMigrationsTable, baseline, ...manifestEvidence });
  const baselineLedger = (await orchestrator.runPlan([{ sequence: 5, stepId: 'P05', commandId: 'baseline-ledger-registration', ...request.commands.baselineLedger }], { envAdditions }))[0];
  if (!baselineLedger?.result || baselineLedger.result.exitCode !== 0) return terminal('BASELINE_LEDGER_FAILURE', { preflight, inspections, emptyDatabase, prismaMigrationsTable, baseline, baselineLedger, ...manifestEvidence });
  const historical = [];
  for (let index = 0; index < historicalPlan.length; index += 1) {
    const step = historicalPlan[index];
    const migrationName = step.migrationName;
    const record = (await orchestrator.runPlan([step], { envAdditions }))[0];
    const result = record?.result;
    historical.push({ migrationName, position: index + 1, expectedSqlHash: step.migrationSqlHash, commandId: step.commandId, status: result?.status || 'FAILED', exitCode: result?.exitCode ?? null, signal: result?.signal ?? null, stdout: result?.stdout || '', stderr: result?.stderr || '' });
    if (!result || result.exitCode !== 0) return terminal('HISTORICAL_FIRST_FAILURE', { preflight, inspections, emptyDatabase, prismaMigrationsTable, baseline, baselineLedger, ...manifestEvidence, historical, firstFailedHistoricalPosition: index + 1, firstFailedHistoricalMigration: migrationName, lastSuccessfulHistoricalPosition: index, historicalAttemptedCount: index + 1, historicalSucceededCount: index, ledgerCountAfterFailure: null });
  }
  return terminal('ALL_HISTORICAL_PASS', {
    preflight, inspections, emptyDatabase, prismaMigrationsTable, baseline, baselineLedger,
    ...manifestEvidence, historical, historicalAttemptedCount: historical.length,
    historicalSucceededCount: historical.length, historicalFailedCount: 0,
    finalHistoricalLedgerCount: historical.length + 1,
  });
}

module.exports = { createOrchestrator, runHistoricalReconciliationProof, sha256File };
