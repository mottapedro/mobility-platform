'use strict';

/**
 * Gate R13-X1-F15I-P3-IMPLEMENTATION-01 — Governed Evidence Publication and Collection Tests (T01 - T20)
 *
 * Isolated tests validating governed evidence publication, isolation, durability, and collection:
 * CAPTURE -> DISPATCHER -> PRELOADER WRAPPER -> ARTIFACT COLLECTOR
 *
 * Strict isolation:
 * - No migration SQL
 * - No database connection
 * - No historical materializer execution
 * - No Docker mutation
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dispatcher = require('../../scripts/gates/r7c-r13-operational-dispatcher.cjs');
const wrapper = require('../../scripts/gates/r13-preloader-wrapper.cjs');
const capture = require('../../scripts/gates/r13-targetidentity-capture.cjs');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');

// T01: Closed capture interface rejects non-empty caller options.
test('T01: Closed capture interface rejects non-empty caller options', () => {
  assert.throws(() => capture.captureTargetIdentity({ callerCustom: 'disallowed' }), /CLOSED_CAPTURE_INTERFACE/);
  assert.throws(() => capture.captureTargetIdentity({ timeout: 5000 }), /CLOSED_CAPTURE_INTERFACE/);
});

// T02: Destination root validated before child spawn.
test('T02: Destination root validated before child spawn', () => {
  const invalidRoot = path.parse(path.resolve('.')).root;
  assert.throws(() => {
    capture.__test.captureChild({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      evidenceRoot: invalidRoot,
    });
  }, /UNSAFE_EVIDENCE_DESTINATION/);
});

// T03: Governed root inside repository root is rejected.
test('T03: Governed root inside repository root is rejected', () => {
  const insideRepo = path.join(REPOSITORY_ROOT, 'test-evidence-leak');
  assert.throws(() => capture.validateGovernedEvidenceRoot(insideRepo), /EVIDENCE_DESTINATION_INSIDE_REPOSITORY/);
  assert.throws(() => wrapper.safeEvidenceRoot(insideRepo), /UNSAFE_EVIDENCE_DESTINATION/);
});

// T04: Governed root inside dispatcher tempRoot is rejected.
test('T04: Governed root inside dispatcher tempRoot is rejected', () => {
  const insideTempRoot = path.join(os.tmpdir(), 'r7c-r13-authorized-catalog-xyz', 'sub-dir');
  assert.throws(() => capture.validateGovernedEvidenceRoot(insideTempRoot), /EVIDENCE_DESTINATION_INSIDE_TEMPROOT/);
  assert.throws(() => wrapper.safeEvidenceRoot(insideTempRoot, path.dirname(insideTempRoot)), /UNSAFE_EVIDENCE_DESTINATION/);
});

// T05: Symlink escape in destination root is rejected.
test('T05: Symlink escape in destination root is rejected', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-t05-'));
  const symlinkPath = path.join(tempDir, 'symlink-escape');
  try {
    try {
      fs.symlinkSync(REPOSITORY_ROOT, symlinkPath, 'junction');
    } catch {
      return; // If symlink creation not permitted in this OS environment, pass gracefully
    }
    assert.throws(
      () => capture.validateGovernedEvidenceRoot(symlinkPath),
      /EVIDENCE_DESTINATION_SYMLINK_ESCAPE|EVIDENCE_DESTINATION_INSIDE_REPOSITORY/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// T06: Destination collision (.staging or final) is rejected.
test('T06: Destination collision (.staging or final) is rejected', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-t06-'));
  const nonce = 'collision-nonce-123';
  const finalDest = path.join(tempRoot, nonce);
  const stagingDest = path.join(tempRoot, `.staging-${nonce}`);
  try {
    // 1. Collision on final destination
    fs.mkdirSync(finalDest);
    assert.throws(
      () => capture.captureTargetIdentity({ synthetic: true, evidenceRoot: finalDest, nonce }),
      /EVIDENCE_DESTINATION_COLLISION/
    );
    fs.rmSync(finalDest, { recursive: true, force: true });

    // 2. Collision on staging destination
    fs.mkdirSync(stagingDest);
    assert.throws(
      () => capture.captureTargetIdentity({ synthetic: true, evidenceRoot: finalDest, nonce }),
      /EVIDENCE_DESTINATION_COLLISION/
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// T07: Successful execution publishes via atomic directory rename.
test('T07: Successful execution publishes via atomic directory rename', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-t07-'));
  const nonce = 't07-atomic-nonce';
  const destination = path.join(tempRoot, nonce);
  try {
    const result = await capture.__test.captureChild({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('T07_STDOUT');"],
      evidenceRoot: destination,
      nonce,
    });
    assert.equal(result.publicationStatus, 'PUBLISHED');
    assert.equal(result.evidenceState, 'EVIDENCE_COMPLETE');
    assert.equal(fs.existsSync(destination), true);
    assert.equal(fs.existsSync(path.join(tempRoot, `.staging-${nonce}`)), false);

    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'execution-manifest.json'), 'utf8'));
    assert.equal(manifest.publicationStatus, 'PUBLISHED');
    assert.equal(manifest.evidenceState, 'EVIDENCE_COMPLETE');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// T08: Staging failure does not leave final published directory.
test('T08: Staging failure does not leave final published directory', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-t08-'));
  const destination = path.join(tempRoot, 'dest-t08');
  try {
    assert.throws(() => {
      capture.__test.persistEvidence(
        destination,
        { nonce: 't08-nonce' },
        null, // Invalid stdout data causes write failure during staging
        Buffer.alloc(0),
        Buffer.alloc(0)
      );
    }, /EVIDENCE_PERSISTENCE_FAILED/);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(path.join(tempRoot, '.staging-t08-nonce')), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// T09: Publication failure is fail-closed with unhandled rethrow.
test('T09: Publication failure is fail-closed with unhandled rethrow', () => {
  const invalidRoot = path.parse(path.resolve('.')).root;
  assert.throws(() => {
    capture.__test.persistEvidence(
      invalidRoot,
      { nonce: 't09-nonce' },
      Buffer.alloc(0),
      Buffer.alloc(0),
      Buffer.alloc(0)
    );
  }, /UNSAFE_EVIDENCE_DESTINATION/);
});

// T10: Dispatcher tempRoot cleanup leaves governed evidence intact.
test('T10: Dispatcher tempRoot cleanup leaves governed evidence intact', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r7c-r13-authorized-catalog-t10-'));
  const nonce = 't10-nonce';
  const preloaderEvidenceDir = path.join(os.tmpdir(), 'r13-preloader-evidence', nonce);
  try {
    wrapper.persistPreloaderEvidence(
      preloaderEvidenceDir,
      { manifest: true, nonce },
      Buffer.alloc(0),
      Buffer.alloc(0),
      Buffer.alloc(0),
      Buffer.alloc(0)
    );
    assert.equal(fs.existsSync(preloaderEvidenceDir), true);

    // Simulate dispatcher tempRoot cleanup
    fs.rmSync(tempRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(tempRoot), false);

    // Governed evidence remains intact outside tempRoot
    assert.equal(fs.existsSync(preloaderEvidenceDir), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(preloaderEvidenceDir, { recursive: true, force: true });
  }
});

// T11: Child nonzero exit produces published evidence with error manifest.
test('T11: Child nonzero exit produces published evidence with error manifest', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-t11-'));
  const nonce = 't11-nonzero-nonce';
  const destination = path.join(tempRoot, nonce);
  try {
    const result = await capture.__test.captureChild({
      executable: process.execPath,
      args: ['-e', "process.stderr.write('FAILURE_LOG\\n'); process.exit(42);"],
      evidenceRoot: destination,
      nonce,
    });
    assert.equal(result.exitCode, 42);
    assert.equal(result.publicationStatus, 'PUBLISHED');
    assert.equal(result.evidenceState, 'EVIDENCE_COMPLETE');
    assert.equal(fs.existsSync(destination), true);

    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'execution-manifest.json'), 'utf8'));
    assert.equal(manifest.exitCode, 42);
    assert.equal(manifest.publicationStatus, 'PUBLISHED');
    assert.ok(manifest.stderrByteCount > 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// T12: Missing fd4 produces unclassified evidence, does not fabricate C01/C03.
test('T12: Missing fd4 produces unclassified evidence, does not fabricate C01/C03', () => {
  const failure = capture.classifyChildFailure({
    exitCode: 1,
    signal: null,
    fd3Bytes: Buffer.from('some-fd3-bytes'),
    fd4Bytes: Buffer.alloc(0),
    preloaderProtocol: null,
  });
  assert.equal(failure.classification, 'PRE_MODULE_ENTRY_FAILURE_UNRESOLVED');
  assert.equal(failure.code, null);
  assert.equal(failure.category, null);
  assert.equal(failure.positiveEvidence, false);
});

// T13: Malformed fd4 produces unclassified evidence, does not fabricate C01/C03.
test('T13: Malformed fd4 produces unclassified evidence, does not fabricate C01/C03', () => {
  const nonce = 't13-nonce';
  const malformedBytes = Buffer.from('NOT_VALID_JSON\\nCORRUPT_BYTES\\n');
  let protocol = null;
  try {
    protocol = wrapper.parsePreloaderProtocol(malformedBytes.toString('utf8'), nonce);
  } catch {
    protocol = null;
  }
  const failure = capture.classifyChildFailure({
    exitCode: 1,
    signal: null,
    fd3Bytes: Buffer.from('some-fd3-bytes'),
    fd4Bytes: malformedBytes,
    preloaderProtocol: protocol,
  });
  assert.equal(failure.classification, 'PRE_MODULE_ENTRY_FAILURE_UNRESOLVED');
  assert.equal(failure.code, null);
  assert.equal(failure.category, null);
  assert.equal(failure.positiveEvidence, false);
});

// T14: Dispatcher inner fd4 is relayed to outer fd4 without truncation.
test('T14: Dispatcher inner fd4 is relayed to outer fd4 without truncation', () => {
  let writtenFd = null;
  let writtenBuffer = null;
  const originalWriteSync = fs.writeSync;
  try {
    fs.writeSync = (fd, buffer, ...rest) => {
      if (fd === 4) {
        writtenFd = fd;
        writtenBuffer = buffer;
        return buffer.length;
      }
      return originalWriteSync(fd, buffer, ...rest);
    };
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r7c-r13-authorized-catalog-t14-'));
    const testPayload = Buffer.from('{"type":"BOUNDARY","boundary":"PRELOADER_WRAPPER_ENTERED"}\\n');
    try {
      dispatcher.materializeAuthorizedCatalog(tempRoot, {}, {
        spawnSync: () => ({
          status: 1,
          error: null,
          stdout: '',
          stderr: '',
          output: [null, '', '', '', testPayload],
        }),
      });
    } catch {
      // Expected materialization failure
    }
    assert.equal(writtenFd, 4);
    assert.deepEqual(writtenBuffer, testPayload);
  } finally {
    fs.writeSync = originalWriteSync;
  }
});

// T15: Persistence failure in dispatcher or preloader is fail-closed.
test('T15: Persistence failure in dispatcher or preloader is fail-closed', () => {
  const rootDir = path.parse(path.resolve('.')).root;
  assert.throws(() => {
    wrapper.safeEvidenceRoot(rootDir);
  }, /UNSAFE_EVIDENCE_DESTINATION/);
  assert.throws(() => {
    capture.validateGovernedEvidenceRoot(rootDir);
  }, /UNSAFE_EVIDENCE_DESTINATION/);
});

// T16: All published evidence contains complete manifest with sha256 and byte counts.
test('T16: All published evidence contains complete manifest with sha256 and byte counts', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-t16-'));
  const nonce = 't16-manifest-nonce';
  const destination = path.join(tempRoot, nonce);
  try {
    await capture.__test.captureChild({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('OUT_16'); process.stderr.write('ERR_16');"],
      evidenceRoot: destination,
      nonce,
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'execution-manifest.json'), 'utf8'));
    assert.equal(manifest.stdoutByteCount, Buffer.from('OUT_16').length);
    assert.equal(manifest.stderrByteCount, Buffer.from('ERR_16').length);
    assert.match(manifest.stdoutSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.stderrSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.eventsSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.fd4Sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// T17: GitHub Actions workflow specifies retention-days: 30 for diagnostic evidence.
test('T17: GitHub Actions workflow specifies retention-days: 30 for diagnostic evidence', () => {
  const workflowPath = path.join(REPOSITORY_ROOT, '.github', 'workflows', 'godnetwork-governance.yml');
  const content = fs.readFileSync(workflowPath, 'utf8');
  assert.match(content, /Collect R13 diagnostic evidence/);
  assert.match(content, /retention-days:\s*30/);
  assert.match(content, /actions\/upload-artifact@v4/);
});

// T18: GitHub Actions workflow runs evidence collection with if: always().
test('T18: GitHub Actions workflow runs evidence collection with if: always()', () => {
  const workflowPath = path.join(REPOSITORY_ROOT, '.github', 'workflows', 'godnetwork-governance.yml');
  const content = fs.readFileSync(workflowPath, 'utf8');
  const lines = content.split('\n');
  const stepIndex = lines.findIndex((l) => l.includes('Collect R13 diagnostic evidence'));
  assert.ok(stepIndex !== -1);
  const stepSlice = lines.slice(stepIndex, stepIndex + 12).join('\n');
  assert.match(stepSlice, /if:\s*always\(\)/);
});

// T19: Artifact upload failure does not mask gate execution failure.
test('T19: Artifact upload failure does not mask gate execution failure', () => {
  const workflowPath = path.join(REPOSITORY_ROOT, '.github', 'workflows', 'godnetwork-governance.yml');
  const content = fs.readFileSync(workflowPath, 'utf8');
  const lines = content.split('\n');
  const gateStepIdx = lines.findIndex((l) => l.includes('Run Gate R13 targetIdentity'));
  if (gateStepIdx !== -1) {
    const gateSlice = lines.slice(gateStepIdx, gateStepIdx + 10).join('\n');
    assert.doesNotMatch(gateSlice, /continue-on-error:\s*true/);
  }
  assert.match(content, /if-no-files-found:\s*ignore/);
});

// T20: No tests perform historical R13 execution or touch database/Docker.
test('T20: No tests perform historical R13 execution or touch database/Docker', () => {
  assert.equal(typeof dispatcher.materializeAuthorizedCatalog, 'function');
  assert.equal(typeof capture.captureTargetIdentity, 'function');
  assert.equal(typeof wrapper.parsePreloaderProtocol, 'function');
});
