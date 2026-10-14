'use strict';

/**
 * Gate R13-X1-F15I-P2 — Governed Preloader Runtime Integration Tests (T01 - T12)
 *
 * Isolated tests validating the full integration chain:
 * CAPTURE -> DISPATCHER -> PRELOADER WRAPPER -> TSX -> MATERIALIZER
 *
 * Strict isolation:
 * - No migration SQL
 * - No database connection
 * - No historical materializer execution
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

// T01 - Dispatcher invokes governed wrapper
test('T01 - Dispatcher invokes governed wrapper', () => {
  let invokedExecutable = null;
  let invokedArgs = null;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-t01-'));

  try {
    const fakeSpawn = (executable, args, options) => {
      invokedExecutable = executable;
      invokedArgs = args;
      return {
        status: 1,
        error: null,
        stdout: '',
        stderr: '',
        output: [null, '', '', '', ''],
      };
    };

    assert.throws(() => {
      dispatcher.materializeAuthorizedCatalog(tempRoot, {}, { spawnSync: fakeSpawn });
    }, /AUTHORIZED_CATALOG_MATERIALIZATION_FAILED/);

    assert.equal(invokedExecutable, process.execPath);
    assert.equal(invokedArgs[0], dispatcher.PRELOADER_WRAPPER_PATH);
    assert.equal(path.basename(invokedArgs[0]), 'r13-preloader-wrapper.cjs');
    assert.ok(invokedArgs[1].endsWith('materialize-authorized-migration-catalog.ts'));
    assert.ok(invokedArgs.includes('--output-dir'));
    assert.ok(invokedArgs.includes('--verify-fingerprint'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// T02 - Wrapper reaches materializer fixture
test('T02 - Wrapper reaches materializer fixture', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-t02-'));
  const fixturePath = path.join(tempRoot, 'fixture.js');
  const markerPath = path.join(tempRoot, 'reached.txt');

  try {
    fs.writeFileSync(fixturePath, `
      const fs = require('node:fs');
      fs.writeFileSync('${markerPath.replace(/\\/g, '\\\\')}', 'REACHED');
      process.stdout.write('FIXTURE_EXECUTED\\n');
    `);

    const result = await wrapper.capturePreloaderChild({
      executable: process.execPath,
      args: [dispatcher.PRELOADER_WRAPPER_PATH, fixturePath],
      evidenceRoot: tempRoot,
    });

    assert.equal(result.processCreated, true);
    assert.equal(result.exitCode, 0);
    assert.equal(fs.existsSync(markerPath), true);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'REACHED');
    assert.ok(result.stdoutSha256.length === 64);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// T03 - fd4 record reaches parent
test('T03 - fd4 record reaches parent', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-t03-'));
  const nonce = 't03-test-nonce';

  try {
    const result = await wrapper.capturePreloaderChild({
      executable: process.execPath,
      args: [dispatcher.PRELOADER_WRAPPER_PATH, '--nonce', nonce],
      evidenceRoot: tempRoot,
      nonce,
    });

    assert.equal(result.fd4Established, true);
    assert.ok(result.fd4ByteCount > 0);
    assert.ok(result.protocol !== null);
    assert.ok(result.protocol.boundaries.includes('PRELOADER_WRAPPER_ENTERED'));
    assert.ok(result.protocol.boundaries.includes('PRELOADER_CHANNELS_ESTABLISHED'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// T04 - Invocation nonce is validated
test('T04 - Invocation nonce is validated', () => {
  const nonce = 'valid-nonce-999';
  const raw = [
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_WRAPPER_ENTERED', nonce }),
    JSON.stringify({
      type: 'BOUNDARY',
      boundary: 'PRELOADER_IDENTITY_ESTABLISHED',
      pid: 1,
      ppid: 2,
      execPath: process.execPath,
      nodeVersion: process.version,
      platform: process.platform,
      nonce,
    }),
  ].join('\n') + '\n';

  const protocol = wrapper.parsePreloaderProtocol(raw, nonce);
  assert.equal(protocol.records.length, 2);
  assert.equal(protocol.records[0].nonce, nonce);
  assert.equal(protocol.processIdentity.pid, 1);
});

// T05 - Invalid nonce is rejected
test('T05 - Invalid nonce is rejected', () => {
  const expectedNonce = 'expected-nonce-abc';
  const receivedNonce = 'wrong-nonce-xyz';
  const raw = JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_WRAPPER_ENTERED', nonce: receivedNonce }) + '\n';

  assert.throws(() => {
    wrapper.parsePreloaderProtocol(raw, expectedNonce);
  }, /PRELOADER_NONCE_MISMATCH/);
});

// T06 - Duplicate and out-of-order records rejected
test('T06 - Duplicate and out-of-order records rejected', () => {
  const nonce = 'test-nonce-order';
  // Out of order: jumps straight to CHANNELS without WRAPPER_ENTERED
  const outOfOrder = JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_CHANNELS_ESTABLISHED', nonce }) + '\n';
  assert.throws(() => wrapper.parsePreloaderProtocol(outOfOrder, nonce), /PRELOADER_PROTOCOL_INVALID/);

  // Duplicate diagnostic
  const duplicateDiag = [
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_WRAPPER_ENTERED', nonce }),
    JSON.stringify({ type: 'DIAGNOSTIC', code: 'C01', category: 'TSX_LOADER_FAILURE', component: wrapper.PRELOADER_COMPONENT, boundary: 'PRELOADER_WRAPPER_ENTERED', nonce }),
    JSON.stringify({ type: 'DIAGNOSTIC', code: 'C01', category: 'TSX_LOADER_FAILURE', component: wrapper.PRELOADER_COMPONENT, boundary: 'PRELOADER_WRAPPER_ENTERED', nonce }),
  ].join('\n') + '\n';
  assert.throws(() => wrapper.parsePreloaderProtocol(duplicateDiag, nonce), /PRELOADER_PROTOCOL_INVALID/);
});

// T07 - Positive C03 failure classification
test('T07 - Positive C03 failure classification', () => {
  const nonce = 'c03-test-nonce';
  const lines = [
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_WRAPPER_ENTERED', nonce }),
    JSON.stringify({
      type: 'DIAGNOSTIC',
      code: 'C03',
      category: 'FD3_WRITE_FAILURE',
      component: wrapper.PRELOADER_COMPONENT,
      boundary: 'PRELOADER_WRAPPER_ENTERED',
      details: { reason: 'FD3_UNAVAILABLE' },
      nonce,
    }),
  ].join('\n') + '\n';

  const protocol = wrapper.parsePreloaderProtocol(lines, nonce);
  const failure = capture.classifyChildFailure({
    exitCode: 70,
    signal: null,
    fd3Bytes: Buffer.alloc(0),
    fd4Bytes: Buffer.from(lines),
    preloaderProtocol: protocol,
  });

  assert.equal(failure.classification, 'INITIAL_FD3_WRITE_FAILED');
  assert.equal(failure.code, 'C03');
  assert.equal(failure.category, 'FD3_WRITE_FAILURE');
  assert.equal(failure.positiveEvidence, true);
});

// T08 - Missing fd4 evidence remains unclassified
test('T08 - Missing fd4 evidence remains unclassified', () => {
  const failure = capture.classifyChildFailure({
    exitCode: 1,
    signal: null,
    fd3Bytes: Buffer.from('some-fd3-data'),
    fd4Bytes: Buffer.alloc(0),
    preloaderProtocol: null,
  });

  assert.equal(failure.classification, 'PRE_MODULE_ENTRY_FAILURE_UNRESOLVED');
  assert.equal(failure.code, null);
  assert.equal(failure.category, null);
  assert.equal(failure.positiveEvidence, false);
});

// T09 - Empty fd3 remains semantically empty
test('T09 - Empty fd3 remains semantically empty', () => {
  const parsed = dispatcher.parseChildMaterializerProtocol('');
  assert.deepEqual(parsed.records, []);
  assert.deepEqual(parsed.boundaries, []);
  assert.equal(parsed.diagnostic, null);
});

// T10 - Parent evidence persistence failure
test('T10 - Parent evidence persistence failure', () => {
  assert.throws(() => {
    wrapper.persistPreloaderEvidence(
      path.parse(path.resolve('.')).root,
      { manifest: true },
      Buffer.alloc(0),
      Buffer.alloc(0),
      Buffer.alloc(0),
      Buffer.alloc(0),
    );
  }, /UNSAFE_EVIDENCE_DESTINATION/);
});

// T11 - Capture receives and preserves dispatcher diagnostic evidence
test('T11 - Capture receives and preserves dispatcher diagnostic evidence', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-t11-'));

  try {
    const code = [
      "require('node:fs').writeSync(3, Buffer.from('{\"event\":\"DISPATCHER_MODULE_LOADED\"}\\n'));",
      "require('node:fs').writeSync(4, Buffer.from('{\"type\":\"BOUNDARY\",\"boundary\":\"PRELOADER_WRAPPER_ENTERED\"}\\n'));",
      "process.stdout.write('OUT_DATA');",
      "process.stderr.write('ERR_DATA');",
    ].join(' ');

    const result = await capture.__test.captureChild({
      executable: process.execPath,
      args: ['-e', code],
      env: {},
      evidenceRoot: tempDir,
    });

    assert.equal(result.evidenceState, 'EVIDENCE_COMPLETE');
    assert.equal(result.fd3Established, true);
    assert.equal(result.fd4Established, true);
    assert.equal(result.stdoutByteCount, Buffer.from('OUT_DATA').length);
    assert.equal(result.stderrByteCount, Buffer.from('ERR_DATA').length);
    assert.ok(result.eventsByteCount > 0);
    assert.ok(result.fd4ByteCount > 0);

    assert.equal(fs.existsSync(path.join(tempDir, 'stdout.bin')), true);
    assert.equal(fs.existsSync(path.join(tempDir, 'stderr.bin')), true);
    assert.equal(fs.existsSync(path.join(tempDir, 'events.jsonl')), true);
    assert.equal(fs.existsSync(path.join(tempDir, 'fd4.bin')), true);
    assert.equal(fs.existsSync(path.join(tempDir, 'execution-manifest.json')), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// T12 - Existing dispatcher behavior remains compatible where contracts are unchanged
test('T12 - Existing dispatcher behavior remains compatible where contracts are unchanged', async () => {
  assert.deepEqual(dispatcher.OPERATIONS, [
    'targetIdentity', 'emptyState', 'migrationTable', 'baseline', 'baselineLedger',
  ]);

  const commands = dispatcher.buildCommandSet();
  assert.deepEqual(Object.keys(commands), dispatcher.OPERATIONS);

  await assert.rejects(() => dispatcher.runOperation('targetIdentity', { env: {} }), /DATABASE_URL_REQUIRED/);
  assert.deepEqual(dispatcher.PRELOADER_PIPELINE_STATES, [
    'TRANSPORT_ESTABLISHED', 'BYTES_RECEIVED', 'RECORDS_PARSED', 'RECORDS_ACCEPTED', 'EVIDENCE_PERSISTED',
  ]);
});
