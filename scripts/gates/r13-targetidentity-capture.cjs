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

function persistEvidence(root, manifest, stdout, stderr, events) {
  const dir = safeEvidenceRoot(root);
  const partial = path.join(dir, '.partial');
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, 'stdout.bin'), stdout);
  fs.writeFileSync(path.join(partial, 'stderr.bin'), stderr);
  fs.writeFileSync(path.join(partial, 'events.jsonl'), events);
  fs.writeFileSync(path.join(partial, 'execution-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const name of ['stdout.bin', 'stderr.bin', 'events.jsonl', 'execution-manifest.json']) fs.renameSync(path.join(partial, name), path.join(dir, name));
  fs.rmSync(partial, { recursive: true, force: true });
  return dir;
}

function captureChild({ executable, args, env, evidenceRoot, source = 'synthetic' }) {
  const started = { schemaVersion: 1, captureArtifactVersion: 'r13-f8i-1', sourceArtifactSha: '28cb7155dcb128c10bbcb6dd678c31df13c680a0', operation: source === 'synthetic' ? 'synthetic' : OPERATION, executable: path.basename(executable), args: args.map(String), databaseUrlPresent: Boolean(env && env.DATABASE_URL), processCreated: false, fd3Established: false, exitCode: null, signal: null, stdoutByteCount: 0, stdoutSha256: sha256(Buffer.alloc(0)), stderrByteCount: 0, stderrSha256: sha256(Buffer.alloc(0)), eventsByteCount: 0, eventsSha256: sha256(Buffer.alloc(0)), evidenceState: 'PREPARED' };
  return new Promise((resolve) => {
    let child;
    try { child = spawn(executable, args, { env: { ...process.env, ...env }, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] }); }
    catch (error) { started.processCreationError = error.name || 'Error'; started.evidenceState = 'CHILD_COMPLETED'; const empty = Buffer.alloc(0); started.evidenceState = 'EVIDENCE_COMPLETE'; resolve({ ...started, processCreated: false, evidenceRoot: persistEvidence(evidenceRoot, started, empty, empty, empty) }); return; }
    let spawned = false; let settled = false; const out = []; const err = []; const events = [];
    child.once('spawn', () => { spawned = true; started.processCreated = true; started.fd3Established = Boolean(child.stdio[3]); started.evidenceState = 'CHILD_CREATED'; });
    child.stdout.on('data', (chunk) => out.push(Buffer.from(chunk))); child.stderr.on('data', (chunk) => err.push(Buffer.from(chunk)));
    if (child.stdio[3]) child.stdio[3].on('data', (chunk) => events.push(Buffer.from(chunk)));
    const finish = (code, signal, created) => { if (settled) return; settled = true; const stdout = Buffer.concat(out); const stderr = Buffer.concat(err); const eventBytes = Buffer.concat(events); started.evidenceState = 'CHILD_COMPLETED'; started.processCreated = created; started.exitCode = code; started.signal = signal; for (const [name, bytes] of [['stdout', stdout], ['stderr', stderr], ['events', eventBytes]]) { started[`${name}ByteCount`] = bytes.length; started[`${name}Sha256`] = sha256(bytes); } started.evidenceState = 'EVIDENCE_COMPLETE'; resolve({ ...started, evidenceRoot: persistEvidence(evidenceRoot, started, stdout, stderr, eventBytes) }); };
    child.once('error', (error) => { started.processError = error.name || 'Error'; if (!spawned) finish(null, null, false); });
    child.once('close', (code, signal) => finish(code, signal, true));
  });
}

function captureTargetIdentity(options = {}) {
  if (Object.keys(options).length && options.synthetic !== true) throw new Error('E: CLOSED_CAPTURE_INTERFACE');
  return captureChild({ executable: process.execPath, args: [DISPATCHER_PATH, OPERATION], env: { DATABASE_URL: process.env.DATABASE_URL }, evidenceRoot: options.evidenceRoot, source: OPERATION });
}

module.exports = { captureTargetIdentity, __test: { captureChild, persistEvidence, sha256 } };

if (require.main === module) captureTargetIdentity().then((result) => { process.stdout.write(JSON.stringify(result) + '\n'); });
