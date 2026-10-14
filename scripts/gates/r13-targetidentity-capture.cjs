'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parsePreloaderProtocol } = require('./r13-preloader-wrapper.cjs');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const DISPATCHER_PATH = path.join(REPOSITORY_ROOT, 'scripts', 'gates', 'r7c-r13-operational-dispatcher.cjs');
const OPERATION = 'targetIdentity';

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function safeEvidenceRoot(root) {
  const value = root || path.join(os.tmpdir(), 'r13-targetidentity-capture');
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root || resolved.includes('..')) throw new Error('E: UNSAFE_EVIDENCE_DESTINATION');
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function persistEvidence(root, manifest, stdout, stderr, events, fd4 = Buffer.alloc(0)) {
  const dir = safeEvidenceRoot(root);
  const partial = path.join(dir, '.partial');
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, 'stdout.bin'), stdout);
  fs.writeFileSync(path.join(partial, 'stderr.bin'), stderr);
  fs.writeFileSync(path.join(partial, 'events.jsonl'), events);
  fs.writeFileSync(path.join(partial, 'fd4.bin'), fd4);
  fs.writeFileSync(path.join(partial, 'execution-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const name of ['stdout.bin', 'stderr.bin', 'events.jsonl', 'fd4.bin', 'execution-manifest.json']) {
    fs.renameSync(path.join(partial, name), path.join(dir, name));
  }
  fs.rmSync(partial, { recursive: true, force: true });
  return dir;
}

function classifyChildFailure({ exitCode, signal, fd3Bytes, fd4Bytes, preloaderProtocol }) {
  if (exitCode === 0 && signal === null) return null;

  if (preloaderProtocol?.diagnostic) {
    const diag = preloaderProtocol.diagnostic;
    if (diag.code === 'C01') {
      return Object.freeze({
        classification: 'TSX_LOADER_FAILURE_CONFIRMED',
        code: 'C01',
        category: 'TSX_LOADER_FAILURE',
        positiveEvidence: true,
      });
    }
    if (diag.code === 'C03') {
      return Object.freeze({
        classification: 'INITIAL_FD3_WRITE_FAILED',
        code: 'C03',
        category: 'FD3_WRITE_FAILURE',
        positiveEvidence: true,
      });
    }
  }

  const fd3Empty = !fd3Bytes || fd3Bytes.length === 0;
  const fd4Empty = !fd4Bytes || fd4Bytes.length === 0;
  if (fd3Empty && fd4Empty) {
    return Object.freeze({
      classification: 'OBSERVABILITY_FAILURE_UNCLASSIFIED',
      code: null,
      category: null,
      positiveEvidence: false,
    });
  }

  return Object.freeze({
    classification: 'PRE_MODULE_ENTRY_FAILURE_UNRESOLVED',
    code: null,
    category: null,
    positiveEvidence: false,
  });
}

function captureChild({ executable, args, env, evidenceRoot, source = 'synthetic', nonce = null }) {
  const started = {
    schemaVersion: 1,
    captureArtifactVersion: 'r13-f8i-2',
    sourceArtifactSha: '4fc82f9984151c843cdea1c3db687b0afc9d7ca0',
    operation: source === 'synthetic' ? 'synthetic' : OPERATION,
    executable: path.basename(executable),
    args: args.map(String),
    databaseUrlPresent: Boolean(env && env.DATABASE_URL),
    processCreated: false,
    fd3Established: false,
    fd4Established: false,
    exitCode: null,
    signal: null,
    stdoutByteCount: 0,
    stdoutSha256: sha256(Buffer.alloc(0)),
    stderrByteCount: 0,
    stderrSha256: sha256(Buffer.alloc(0)),
    eventsByteCount: 0,
    eventsSha256: sha256(Buffer.alloc(0)),
    fd4ByteCount: 0,
    fd4Sha256: sha256(Buffer.alloc(0)),
    evidenceState: 'PREPARED',
  };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        env: { ...process.env, ...env },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      started.processCreationError = error.name || 'Error';
      started.evidenceState = 'CHILD_COMPLETED';
      const empty = Buffer.alloc(0);
      started.evidenceState = 'EVIDENCE_COMPLETE';
      resolve({ ...started, processCreated: false, evidenceRoot: persistEvidence(evidenceRoot, started, empty, empty, empty, empty) });
      return;
    }
    let spawned = false;
    let settled = false;
    const out = [];
    const err = [];
    const events = [];
    const f4 = [];
    child.once('spawn', () => {
      spawned = true;
      started.processCreated = true;
      started.fd3Established = Boolean(child.stdio[3]);
      started.fd4Established = Boolean(child.stdio[4]);
      started.evidenceState = 'CHILD_CREATED';
    });
    child.stdout.on('data', (chunk) => out.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => err.push(Buffer.from(chunk)));
    if (child.stdio[3]) child.stdio[3].on('data', (chunk) => events.push(Buffer.from(chunk)));
    if (child.stdio[4]) child.stdio[4].on('data', (chunk) => f4.push(Buffer.from(chunk)));

    const finish = (code, signal, created) => {
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err);
      const eventBytes = Buffer.concat(events);
      const fd4Bytes = Buffer.concat(f4);

      started.evidenceState = 'CHILD_COMPLETED';
      started.processCreated = created;
      started.exitCode = code;
      started.signal = signal;

      started.stdoutByteCount = stdout.length;
      started.stdoutSha256 = sha256(stdout);
      started.stderrByteCount = stderr.length;
      started.stderrSha256 = sha256(stderr);
      started.eventsByteCount = eventBytes.length;
      started.eventsSha256 = sha256(eventBytes);
      started.fd4ByteCount = fd4Bytes.length;
      started.fd4Sha256 = sha256(fd4Bytes);

      let preloaderProtocol = null;
      if (fd4Bytes.length > 0) {
        try {
          preloaderProtocol = parsePreloaderProtocol(fd4Bytes.toString('utf8'), nonce);
        } catch {}
      }

      if (code !== 0 || signal !== null) {
        started.failureClassification = classifyChildFailure({
          exitCode: code,
          signal,
          fd3Bytes: eventBytes,
          fd4Bytes,
          preloaderProtocol,
        });
      } else {
        started.failureClassification = null;
      }
      if (preloaderProtocol?.diagnostic) {
        started.sanitizedDiagnostics = preloaderProtocol.diagnostic;
      }

      started.evidenceState = 'EVIDENCE_COMPLETE';
      resolve({ ...started, evidenceRoot: persistEvidence(evidenceRoot, started, stdout, stderr, eventBytes, fd4Bytes) });
    };

    child.once('error', (error) => {
      started.processError = error.name || 'Error';
      if (!spawned) finish(null, null, false);
    });
    child.once('close', (code, signal) => finish(code, signal, true));
  });
}

function captureTargetIdentity(options = {}) {
  if (Object.keys(options).length && options.synthetic !== true) throw new Error('E: CLOSED_CAPTURE_INTERFACE');
  return captureChild({
    executable: process.execPath,
    args: [DISPATCHER_PATH, OPERATION],
    env: { DATABASE_URL: process.env.DATABASE_URL },
    evidenceRoot: options.evidenceRoot,
    source: OPERATION,
  });
}

module.exports = {
  captureTargetIdentity,
  classifyChildFailure,
  __test: { captureChild, persistEvidence, sha256, classifyChildFailure },
};

if (require.main === module) {
  captureTargetIdentity().then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
  });
}
