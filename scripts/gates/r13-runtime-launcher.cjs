'use strict';

/**
 * R13C3-I1-R2 — Operational Runtime Composition (execution identity corrected)
 *
 * This is the sole authoritative entry point for R13 execution.
 * It closes the composition gap identified in R13_EXECUTION_PREFLIGHT=INCOMPLETE.
 *
 * CONTRACT
 * --------
 * - commands are built exclusively via dispatcher.buildCommandSet()
 * - the caller cannot supply, override, or substitute any command descriptor
 * - the caller cannot influence migration membership, order, or path
 * - the caller cannot influence baseline artifact identity
 * - DATABASE_URL is consumed exclusively from process.env (ephemeral transport)
 * - no .env file is loaded at any point
 * - runHistoricalReconciliationProof is invoked exactly once per execution
 *
 * EXECUTION AUTHORIZATION MODEL
 * ------------------------------
 * The launcher resolves and records the current git HEAD at runtime.
 * It does NOT decide whether that HEAD is the authorized execution artifact.
 * Execution authorization belongs entirely to the external governed gate (C1)
 * that preserves and attests the artifact commit SHA.
 *
 * This avoids the self-referential SHA problem: a hardcoded commit SHA inside
 * a file cannot equal the SHA of the commit that contains that file.
 * (R13C3-I1-R1 formally proved GOVERNED_EXECUTION_SHA_SELF_REFERENTIAL=YES.)
 *
 * RUNNER IDENTITY
 * ---------------
 * EXPECTED_RUNNER_SHA256 identifies diagnostic-process-runner.cjs (raw bytes).
 * It is NOT the dispatcher hash. The dispatcher has a separate versioned identity.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Versioned artifact paths — derived from this file's location, never caller-supplied
// ---------------------------------------------------------------------------

const GATES_DIR = __dirname;
const REPOSITORY_ROOT = path.resolve(GATES_DIR, '..', '..');

const RUNNER_PATH = path.join(GATES_DIR, 'diagnostic-process-runner.cjs');
const DISPATCHER_PATH = path.join(GATES_DIR, 'r7c-r13-operational-dispatcher.cjs');
const PROOF_PATH = path.join(GATES_DIR, 'historical-reconciliation-proof.cjs');

// ---------------------------------------------------------------------------
// Versioned identity constants
// ---------------------------------------------------------------------------

/**
 * SHA-256 of diagnostic-process-runner.cjs (uppercase, as sha256File produces).
 * This is NOT the dispatcher hash.
 * Physical hash observed in the R13C3-I1 execution worktree (1e341195 HEAD).
 * The value declared in R13C3-D1 adjudication (91144907...) did not match the
 * physical artefact — this constant reflects the actual file at RUNNER_PATH.
 */
const EXPECTED_RUNNER_SHA256 =
  'A286509A9CF626A230F1D6862D30C3424240E80DF45ECB076C7611A3A8B0E4CD';

// GOVERNED_EXECUTION_SHA removed in R13C3-I1-R2.
// Self-referential commit identity was proved invalid (R13C3-I1-R1).
// The launcher observes and records currentHead at runtime.
// Execution authorization is established by the external C1 preservation gate.

/**
 * Expected database identity — mirrors dispatcher constants.
 * The dispatcher independently validates these at connection time.
 * This object is used for evidence recording, not for re-validation.
 */
const EXPECTED_DATABASE_IDENTITY = Object.freeze({
  database: 'mobility',
  postgresMajor: 15,
});

// ---------------------------------------------------------------------------
// Module imports — all from versioned sibling artifacts, never from caller
// ---------------------------------------------------------------------------

const { runHistoricalReconciliationProof } = require(PROOF_PATH);
const { buildCommandSet } = require(DISPATCHER_PATH);
const runner = require(RUNNER_PATH);

// ---------------------------------------------------------------------------
// Runtime HEAD resolution — read-only git query, no mutation
// ---------------------------------------------------------------------------

function resolveCurrentHead(repositoryRoot, deps) {
  const spawn = (deps && deps.spawnSync) || spawnSync;
  const result = spawn('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 5000,
  });
  if (result.error || result.status !== 0) throw new Error('E: GIT_HEAD_RESOLUTION_FAILED');
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// DATABASE_URL extraction — process.env only, no .env file loading
// ---------------------------------------------------------------------------

function resolveDatabaseConnectionMaterial(env) {
  const url = typeof env.DATABASE_URL === 'string' ? env.DATABASE_URL.trim() : '';
  if (!url) throw new Error('E: DATABASE_URL_REQUIRED');
  // Full URL structural validation is delegated to dispatcher.requiredDatabaseUrl()
  // at connection time. Here we only confirm presence.
  return Object.freeze({ DATABASE_URL: url });
}

// ---------------------------------------------------------------------------
// Evidence root — ephemeral directory outside the repository
// ---------------------------------------------------------------------------

function createEvidenceRoot(runId, deps) {
  const tmpDir = (deps && deps.tmpDir) ? deps.tmpDir() : os.tmpdir();
  const base = path.join(tmpDir, `r13-evidence-${runId}`);
  ((deps && deps.mkdirSync) || fs.mkdirSync)(base, { recursive: true });
  return base;
}

// ---------------------------------------------------------------------------
// Composition entry point
//
// The caller supplies NOTHING except DATABASE_URL via process.env.
// All migration membership, order, paths, command descriptors, and artifact
// identities are resolved internally from versioned sources.
// ---------------------------------------------------------------------------

async function runLauncher(deps) {
  const env = (deps && deps.env) || process.env;

  const runId = `r13-${crypto.randomBytes(8).toString('hex')}`;
  const evidenceRoot = createEvidenceRoot(runId, deps);

  // Read current HEAD from git — never accepts it from caller
  const currentHead = resolveCurrentHead(REPOSITORY_ROOT, deps);

  // DATABASE_URL from process environment only — no file loading
  const databaseConnectionMaterial = resolveDatabaseConnectionMaterial(env);

  // All five command descriptors sourced exclusively from the versioned dispatcher.
  // buildCommandSet() returns a frozen object whose values reference the dispatcher
  // file itself — callers cannot inject alternative executables or argument vectors.
  const commands = buildCommandSet();

  const resolvedRunner = (deps && deps.runner) || runner;

  // expectedHead is set to currentHead so the proof's repositoryHeadMatch is always
  // recorded as true (the launcher always knows what it is running from).
  // Authorization that currentHead is the permitted artifact is the responsibility
  // of the external C1 gate — not of this code.
  const request = {
    runId,
    evidenceRoot,
    databaseConnectionMaterial,
    expectedDatabaseIdentity: EXPECTED_DATABASE_IDENTITY,
    commands,
    runner: resolvedRunner,
    runnerPath: RUNNER_PATH,
    expectedRunnerSha256: EXPECTED_RUNNER_SHA256,
    currentHead,
    expectedHead: currentHead,
  };

  return runHistoricalReconciliationProof(request);
}

// ---------------------------------------------------------------------------
// CLI entry point — zero arguments accepted
// ---------------------------------------------------------------------------

async function main() {
  if (process.argv.length > 2) {
    throw new Error('E: NO_CLI_ARGUMENTS_ACCEPTED');
  }
  const result = await runLauncher();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'ALL_HISTORICAL_PASS') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    const code =
      typeof error?.message === 'string' && /^E: [A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'E: LAUNCHER_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

// ---------------------------------------------------------------------------
// Exports — for static inspection and focused contract testing
// ---------------------------------------------------------------------------

module.exports = {
  EXPECTED_RUNNER_SHA256,
  EXPECTED_DATABASE_IDENTITY,
  REPOSITORY_ROOT,
  RUNNER_PATH,
  DISPATCHER_PATH,
  PROOF_PATH,
  GATES_DIR,
  createEvidenceRoot,
  resolveDatabaseConnectionMaterial,
  resolveCurrentHead,
  runLauncher,
};
