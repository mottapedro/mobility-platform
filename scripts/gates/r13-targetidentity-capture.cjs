'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

function persistEvidence(root, manifest, stdout, stderr) {
  const dir = safeEvidenceRoot(root);
  const partial = path.join(dir, '.partial');
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, 'stdout.bin'), stdout);
  fs.writeFileSync(path.join(partial, 'stderr.bin'), stderr);
  fs.writeFileSync(path.join(partial, 'execution-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const name of ['stdout.bin', 'stderr.bin', 'execution-manifest.json']) fs.renameSync(path.join(partial, name), path.join(dir, name));
  fs.rmSync(partial, { recursive: true, force: true });
  return dir;
}

function captureChild({ executable, args, env, evidenceRoot, source = 'synthetic' }) {
  const started = { schemaVersion: 1, captureArtifactVersion: 'r13-f6i-1', sourceArtifactSha: '50668e1dda8396576ea3feb409a0d2e6e843bd52', operation: source === 'synthetic' ? 'synthetic' : OPERATION, executable: path.basename(executable), args: args.map(String), databaseUrlPresent: Boolean(env && env.DATABASE_URL), processCreated: false, exitCode: null, signal: null, stdoutByteCount: 0, stdoutSha256: sha256(Buffer.alloc(0)), stderrByteCount: 0, stderrSha256: sha256(Buffer.alloc(0)), evidenceState: 'PREPARED' };
  return new Promise((resolve) => {
    let child;
    try { child = spawn(executable, args, { env: { ...process.env, ...env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { started.processCreationError = error.name || 'Error'; started.evidenceState = 'CHILD_COMPLETED'; const out = Buffer.alloc(0); const err = Buffer.alloc(0); started.stdoutByteCount = 0; started.stderrByteCount = 0; started.stdoutSha256 = sha256(out); started.stderrSha256 = sha256(err); started.evidenceState = 'EVIDENCE_COMPLETE'; resolve({ ...started, processCreated: false, evidenceRoot: persistEvidence(evidenceRoot, started, out, err) }); return; }
    let spawned = false; let settled = false; const out = []; const err = [];
    child.once('spawn', () => { spawned = true; started.processCreated = true; started.evidenceState = 'CHILD_CREATED'; });
    child.stdout.on('data', (chunk) => out.push(Buffer.from(chunk))); child.stderr.on('data', (chunk) => err.push(Buffer.from(chunk)));
    child.once('error', (error) => { started.processError = error.name || 'Error'; if (!spawned && !settled) { settled = true; const stdout = Buffer.concat(out); const stderr = Buffer.concat(err); started.evidenceState = 'CHILD_COMPLETED'; started.stdoutByteCount = stdout.length; started.stderrByteCount = stderr.length; started.stdoutSha256 = sha256(stdout); started.stderrSha256 = sha256(stderr); started.evidenceState = 'EVIDENCE_COMPLETE'; resolve({ ...started, processCreated: false, evidenceRoot: persistEvidence(evidenceRoot, started, stdout, stderr) }); } });
    child.once('close', (code, signal) => { if (settled) return; settled = true; const stdout = Buffer.concat(out); const stderr = Buffer.concat(err); started.evidenceState = 'CHILD_COMPLETED'; started.exitCode = code; started.signal = signal; started.stdoutByteCount = stdout.length; started.stderrByteCount = stderr.length; started.stdoutSha256 = sha256(stdout); started.stderrSha256 = sha256(stderr); started.evidenceState = 'EVIDENCE_COMPLETE'; resolve({ ...started, evidenceRoot: persistEvidence(evidenceRoot, started, stdout, stderr) }); });
  });
}

function captureTargetIdentity(options = {}) {
  if (Object.keys(options).length && options.synthetic !== true) throw new Error('E: CLOSED_CAPTURE_INTERFACE');
  return captureChild({ executable: process.execPath, args: [DISPATCHER_PATH, OPERATION], env: { DATABASE_URL: process.env.DATABASE_URL }, evidenceRoot: options.evidenceRoot });
}

module.exports = { captureTargetIdentity, __test: { captureChild, persistEvidence, sha256 } };

if (require.main === module) captureTargetIdentity().then((result) => { process.stdout.write(JSON.stringify(result) + '\n'); });
