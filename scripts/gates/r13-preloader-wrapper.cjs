'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CJS_LOADER_PATH = path.join(REPOSITORY_ROOT, 'node_modules', 'tsx', 'dist', 'cjs', 'index.cjs');

const PRELOADER_COMPONENT = 'preloaderWrapper';

const PRELOADER_BOUNDARIES = Object.freeze([
  'PRELOADER_WRAPPER_ENTERED',
  'PRELOADER_IDENTITY_ESTABLISHED',
  'PRELOADER_CHANNELS_ESTABLISHED',
  'PRELOADER_LOADER_INITIALIZATION_STARTED',
  'PRELOADER_LOADER_INITIALIZATION_COMPLETED',
  'PRELOADER_TARGET_EXECUTION_ENTERED',
  'PRELOADER_TARGET_EXECUTION_COMPLETED',
]);

const PRELOADER_DIAGNOSTIC_CODES = Object.freeze({
  C01: 'TSX_LOADER_FAILURE',
  C03: 'FD3_WRITE_FAILURE',
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createPreloaderDiagnostics(write = fs.writeSync, nonce = null) {
  let lastBoundary = null;
  let diagnosticEmitted = false;
  const emit = (record) => {
    try {
      const payload = Buffer.from(`${JSON.stringify({ ...record, nonce })}\n`, 'utf8');
      write(4, payload);
      return true;
    } catch {
      return false;
    }
  };
  return Object.freeze({
    boundary(boundary, extra = {}) {
      if (!PRELOADER_BOUNDARIES.includes(boundary)) return false;
      if (!emit({ type: 'BOUNDARY', boundary, ...extra })) return false;
      lastBoundary = boundary;
      return true;
    },
    diagnostic(code, details = {}) {
      if (diagnosticEmitted || !lastBoundary) return false;
      const category = PRELOADER_DIAGNOSTIC_CODES[code];
      if (!category) return false;
      if (!emit({
        type: 'DIAGNOSTIC',
        code,
        category,
        component: PRELOADER_COMPONENT,
        boundary: lastBoundary,
        ...details,
      })) return false;
      diagnosticEmitted = true;
      return true;
    },
    get lastBoundary() { return lastBoundary; },
  });
}

function resolveNonce() {
  const envNonce = process.env.R13_PRELOADER_NONCE;
  if (typeof envNonce === 'string' && envNonce.trim() !== '') {
    return envNonce.trim();
  }
  const nonceIndex = process.argv.indexOf('--nonce');
  if (nonceIndex >= 0 && process.argv[nonceIndex + 1]) {
    return process.argv[nonceIndex + 1].trim();
  }
  return crypto.randomBytes(16).toString('hex');
}

function parsePreloaderProtocol(raw, expectedNonce = null) {
  const text = raw == null ? '' : String(raw);
  if (text === '') {
    return Object.freeze({
      records: Object.freeze([]),
      boundaries: Object.freeze([]),
      diagnostic: null,
      processIdentity: null,
    });
  }
  if (!text.endsWith('\n')) {
    throw new Error('E: PRELOADER_PROTOCOL_INVALID');
  }
  const lines = text.slice(0, -1).split('\n');
  const records = [];
  const boundaries = [];
  let diagnostic = null;
  let processIdentity = null;

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error('E: PRELOADER_PROTOCOL_INVALID');
    }
    if (!record || Array.isArray(record) || typeof record !== 'object') {
      throw new Error('E: PRELOADER_PROTOCOL_INVALID');
    }
    if (expectedNonce !== null && record.nonce !== expectedNonce) {
      throw new Error('E: PRELOADER_NONCE_MISMATCH');
    }

    if (record.type === 'BOUNDARY') {
      if (diagnostic || !PRELOADER_BOUNDARIES.includes(record.boundary)) {
        throw new Error('E: PRELOADER_PROTOCOL_INVALID');
      }
      const expected = PRELOADER_BOUNDARIES[boundaries.length];
      if (record.boundary !== expected) {
        throw new Error('E: PRELOADER_PROTOCOL_INVALID');
      }
      boundaries.push(record.boundary);
      if (record.boundary === 'PRELOADER_IDENTITY_ESTABLISHED') {
        processIdentity = Object.freeze({
          pid: record.pid,
          ppid: record.ppid,
          execPath: record.execPath,
          nodeVersion: record.nodeVersion,
          platform: record.platform,
        });
      }
    } else if (record.type === 'DIAGNOSTIC') {
      if (diagnostic || !PRELOADER_DIAGNOSTIC_CODES[record.code]) {
        throw new Error('E: PRELOADER_PROTOCOL_INVALID');
      }
      if (record.component !== PRELOADER_COMPONENT) {
        throw new Error('E: PRELOADER_PROTOCOL_INVALID');
      }
      if (record.category !== PRELOADER_DIAGNOSTIC_CODES[record.code]) {
        throw new Error('E: PRELOADER_PROTOCOL_INVALID');
      }
      if (record.boundary !== boundaries.at(-1)) {
        throw new Error('E: PRELOADER_PROTOCOL_INVALID');
      }
      diagnostic = Object.freeze({
        type: 'DIAGNOSTIC',
        code: record.code,
        category: record.category,
        component: record.component,
        boundary: record.boundary,
        details: Object.freeze(record.details || {}),
      });
    } else {
      throw new Error('E: PRELOADER_PROTOCOL_INVALID');
    }
    records.push(Object.freeze({ ...record }));
  }

  return Object.freeze({
    records: Object.freeze(records),
    boundaries: Object.freeze(boundaries),
    diagnostic,
    processIdentity,
  });
}

function classifyPreloaderFailure(protocol) {
  if (!protocol || !protocol.diagnostic) {
    return Object.freeze({
      code: null,
      category: null,
      positiveEvidence: false,
    });
  }
  const { code, category } = protocol.diagnostic;
  if (code === 'C01' && category === 'TSX_LOADER_FAILURE') {
    return Object.freeze({
      code: 'C01',
      category: 'TSX_LOADER_FAILURE',
      positiveEvidence: true,
    });
  }
  if (code === 'C03' && category === 'FD3_WRITE_FAILURE') {
    return Object.freeze({
      code: 'C03',
      category: 'FD3_WRITE_FAILURE',
      positiveEvidence: true,
    });
  }
  return Object.freeze({
    code: null,
    category: null,
    positiveEvidence: false,
  });
}

function safeEvidenceRoot(root) {
  const value = root || path.join(os.tmpdir(), 'r13-preloader-evidence');
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root || resolved.includes('..')) {
    throw new Error('E: UNSAFE_EVIDENCE_DESTINATION');
  }
  const relToRepo = path.relative(REPOSITORY_ROOT, resolved);
  if (!relToRepo.startsWith('..') && !path.isAbsolute(relToRepo)) {
    throw new Error('E: UNSAFE_EVIDENCE_DESTINATION');
  }
  if (resolved.includes('r7c-r13-authorized-catalog-')) {
    throw new Error('E: UNSAFE_EVIDENCE_DESTINATION');
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function persistPreloaderEvidence(root, manifest, stdout, stderr, fd3, fd4) {
  const dir = safeEvidenceRoot(root);
  const partial = path.join(dir, '.partial');
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, 'stdout.bin'), stdout);
  fs.writeFileSync(path.join(partial, 'stderr.bin'), stderr);
  fs.writeFileSync(path.join(partial, 'fd3.bin'), fd3);
  fs.writeFileSync(path.join(partial, 'fd4.bin'), fd4);
  fs.writeFileSync(path.join(partial, 'execution-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const name of ['stdout.bin', 'stderr.bin', 'fd3.bin', 'fd4.bin', 'execution-manifest.json']) {
    fs.renameSync(path.join(partial, name), path.join(dir, name));
  }
  fs.rmSync(partial, { recursive: true, force: true });
  return dir;
}

function capturePreloaderChild({ executable = process.execPath, args = [], env = {}, evidenceRoot, nonce = null }) {
  const resolvedNonce = nonce || resolveNonce();
  const started = {
    schemaVersion: 1,
    artifact: 'r13-preloader-wrapper',
    nonce: resolvedNonce,
    executable: path.basename(executable),
    args: args.map(String),
    processCreated: false,
    fd3Established: false,
    fd4Established: false,
    exitCode: null,
    signal: null,
    stdoutByteCount: 0,
    stdoutSha256: sha256(Buffer.alloc(0)),
    stderrByteCount: 0,
    stderrSha256: sha256(Buffer.alloc(0)),
    fd3ByteCount: 0,
    fd3Sha256: sha256(Buffer.alloc(0)),
    fd4ByteCount: 0,
    fd4Sha256: sha256(Buffer.alloc(0)),
    evidenceState: 'PREPARED',
  };

  return new Promise((resolve) => {
    let child;
    const childEnv = { ...process.env, ...env, R13_PRELOADER_NONCE: resolvedNonce };
    try {
      child = spawn(executable, args, {
        env: childEnv,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      started.processCreationError = error.name || 'Error';
      started.evidenceState = 'EVIDENCE_COMPLETE';
      const empty = Buffer.alloc(0);
      resolve({
        ...started,
        processCreated: false,
        protocol: parsePreloaderProtocol(''),
        classification: classifyPreloaderFailure(null),
        evidenceRoot: persistPreloaderEvidence(evidenceRoot, started, empty, empty, empty, empty),
      });
      return;
    }

    let spawned = false;
    let settled = false;
    const out = [];
    const err = [];
    const f3 = [];
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
    if (child.stdio[3]) child.stdio[3].on('data', (chunk) => f3.push(Buffer.from(chunk)));
    if (child.stdio[4]) child.stdio[4].on('data', (chunk) => f4.push(Buffer.from(chunk)));

    const finish = (code, signal, created) => {
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err);
      const fd3Bytes = Buffer.concat(f3);
      const fd4Bytes = Buffer.concat(f4);

      started.evidenceState = 'CHILD_COMPLETED';
      started.processCreated = created;
      started.exitCode = code;
      started.signal = signal;

      started.stdoutByteCount = stdout.length;
      started.stdoutSha256 = sha256(stdout);
      started.stderrByteCount = stderr.length;
      started.stderrSha256 = sha256(stderr);
      started.fd3ByteCount = fd3Bytes.length;
      started.fd3Sha256 = sha256(fd3Bytes);
      started.fd4ByteCount = fd4Bytes.length;
      started.fd4Sha256 = sha256(fd4Bytes);

      let protocol = null;
      let protocolError = null;
      try {
        protocol = parsePreloaderProtocol(fd4Bytes.toString('utf8'), resolvedNonce);
      } catch (e) {
        protocolError = e.message;
      }

      const classification = classifyPreloaderFailure(protocol);
      started.classification = classification;
      started.protocolValid = protocol !== null;
      if (protocolError) started.protocolError = protocolError;
      if (protocol?.processIdentity) started.processIdentity = protocol.processIdentity;

      started.evidenceState = 'EVIDENCE_COMPLETE';
      const rootPersisted = persistPreloaderEvidence(evidenceRoot, started, stdout, stderr, fd3Bytes, fd4Bytes);
      resolve({
        ...started,
        protocol,
        classification,
        evidenceRoot: rootPersisted,
      });
    };

    child.once('error', (error) => {
      started.processError = error.name || 'Error';
      if (!spawned) finish(null, null, false);
    });

    child.once('close', (code, signal) => finish(code, signal, true));
  });
}

function main() {
  const nonce = resolveNonce();
  const diagnostics = createPreloaderDiagnostics(fs.writeSync, nonce);

  // Phase 1: Wrapper entered
  diagnostics.boundary('PRELOADER_WRAPPER_ENTERED', {
    pid: process.pid,
    ppid: process.ppid,
  });

  // Phase 2: Process identity established
  const processIdentity = {
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    nodeVersion: process.version,
    platform: process.platform,
  };
  diagnostics.boundary('PRELOADER_IDENTITY_ESTABLISHED', processIdentity);

  // Phase 3: Channels established (validate fd4 and test fd3)
  try {
    if (process.env.SIMULATE_FD3_WRITE_FAILURE === '1') {
      throw new Error('Simulated fd3 write failure');
    }
    fs.fstatSync(3);
  } catch (error) {
    diagnostics.diagnostic('C03', {
      reason: error.code || 'FD3_UNAVAILABLE',
    });
    process.exit(70);
  }

  diagnostics.boundary('PRELOADER_CHANNELS_ESTABLISHED');

  // Phase 4: Loader initialization
  diagnostics.boundary('PRELOADER_LOADER_INITIALIZATION_STARTED');
  try {
    if (process.env.SIMULATE_TSX_LOADER_FAILURE === '1') {
      throw new Error('Simulated TSX loader failure');
    }
    require(TSX_CJS_LOADER_PATH);
  } catch (error) {
    diagnostics.diagnostic('C01', {
      reason: 'TSX_LOADER_FAILED',
    });
    process.exit(1);
  }
  diagnostics.boundary('PRELOADER_LOADER_INITIALIZATION_COMPLETED');

  // Phase 5: Target execution
  diagnostics.boundary('PRELOADER_TARGET_EXECUTION_ENTERED');

  const targetIndex = process.argv.indexOf('--target');
  let targetScript;
  let targetArgs;
  if (targetIndex >= 0 && process.argv[targetIndex + 1]) {
    targetScript = process.argv[targetIndex + 1];
    targetArgs = [targetScript, ...process.argv.slice(targetIndex + 2)];
  } else {
    targetScript = process.argv[2];
    targetArgs = process.argv.slice(2);
  }

  if (!targetScript) {
    diagnostics.boundary('PRELOADER_TARGET_EXECUTION_COMPLETED');
    return;
  }

  const resolvedTarget = path.resolve(targetScript);
  const TargetModule = require('module');
  const targetMod = new TargetModule(resolvedTarget, null);
  targetMod.filename = resolvedTarget;
  targetMod.paths = TargetModule._nodeModulePaths(path.dirname(resolvedTarget));
  process.mainModule = targetMod;
  require.main = targetMod;
  process.argv = [process.execPath, ...targetArgs];

  try {
    targetMod.load(resolvedTarget);
    diagnostics.boundary('PRELOADER_TARGET_EXECUTION_COMPLETED');
  } catch (targetError) {
    process.exit(process.exitCode || 1);
  }
}

module.exports = {
  PRELOADER_COMPONENT,
  PRELOADER_BOUNDARIES,
  PRELOADER_DIAGNOSTIC_CODES,
  createPreloaderDiagnostics,
  resolveNonce,
  parsePreloaderProtocol,
  classifyPreloaderFailure,
  safeEvidenceRoot,
  persistPreloaderEvidence,
  capturePreloaderChild,
  main,
};

if (require.main === module) {
  main();
}
