'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const wrapper = require('../../scripts/gates/r13-preloader-wrapper.cjs');

const WRAPPER_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'scripts', 'gates', 'r13-preloader-wrapper.cjs'),
  'utf8',
);

// ---------------------------------------------------------------------------
// §1 — Static source analysis: ENV_FILE_LOADING=NO, DATABASE_ACCESS=NO
// ---------------------------------------------------------------------------

test('ENV_FILE_LOADING=NO: wrapper source does not load any .env file', () => {
  const forbidden = ['dotenv', "require('.env')", "require(\".env\")", 'readFileSync.*\\.env'];
  for (const pattern of forbidden) {
    const re = new RegExp(pattern);
    assert.equal(re.test(WRAPPER_SOURCE), false, `Forbidden env pattern found: ${pattern}`);
  }
});

test('DATABASE_ACCESS=NO: wrapper source has no database connections or clients', () => {
  const forbidden = ['pg', 'Client', 'Pool', 'prisma', 'DATABASE_URL'];
  for (const pattern of forbidden) {
    const re = new RegExp(`\\b${pattern}\\b`);
    assert.equal(re.test(WRAPPER_SOURCE), false, `Forbidden database access token: ${pattern}`);
  }
});

// ---------------------------------------------------------------------------
// §2 — Protocol and Boundary Invariants
// ---------------------------------------------------------------------------

test('boundaries list is frozen and closed to the seven governed lifecycle phases', () => {
  assert.equal(Object.isFrozen(wrapper.PRELOADER_BOUNDARIES), true);
  assert.deepEqual(wrapper.PRELOADER_BOUNDARIES, [
    'PRELOADER_WRAPPER_ENTERED',
    'PRELOADER_IDENTITY_ESTABLISHED',
    'PRELOADER_CHANNELS_ESTABLISHED',
    'PRELOADER_LOADER_INITIALIZATION_STARTED',
    'PRELOADER_LOADER_INITIALIZATION_COMPLETED',
    'PRELOADER_TARGET_EXECUTION_ENTERED',
    'PRELOADER_TARGET_EXECUTION_COMPLETED',
  ]);
});

test('diagnostic codes are frozen and map strictly to C01 and C03', () => {
  assert.equal(Object.isFrozen(wrapper.PRELOADER_DIAGNOSTIC_CODES), true);
  assert.deepEqual(wrapper.PRELOADER_DIAGNOSTIC_CODES, {
    C01: 'TSX_LOADER_FAILURE',
    C03: 'FD3_WRITE_FAILURE',
  });
});

test('createPreloaderDiagnostics emits structured boundary and diagnostic records to fd4', () => {
  const writes = [];
  const fakeWrite = (fd, buf) => {
    assert.equal(fd, 4);
    writes.push(buf.toString('utf8'));
  };
  const diag = wrapper.createPreloaderDiagnostics(fakeWrite, 'test-nonce-001');

  assert.equal(diag.boundary('PRELOADER_WRAPPER_ENTERED'), true);
  assert.equal(diag.diagnostic('C01'), true);
  // Duplicate diagnostic rejected
  assert.equal(diag.diagnostic('C01'), false);
  // Unknown code rejected
  assert.equal(diag.diagnostic('C99'), false);

  assert.equal(writes.length, 2);
  const rec1 = JSON.parse(writes[0]);
  assert.equal(rec1.type, 'BOUNDARY');
  assert.equal(rec1.boundary, 'PRELOADER_WRAPPER_ENTERED');
  assert.equal(rec1.nonce, 'test-nonce-001');

  const rec2 = JSON.parse(writes[1]);
  assert.equal(rec2.type, 'DIAGNOSTIC');
  assert.equal(rec2.code, 'C01');
  assert.equal(rec2.category, 'TSX_LOADER_FAILURE');
  assert.equal(rec2.component, wrapper.PRELOADER_COMPONENT);
  assert.equal(rec2.boundary, 'PRELOADER_WRAPPER_ENTERED');
  assert.equal(rec2.nonce, 'test-nonce-001');
});

// ---------------------------------------------------------------------------
// §3 — Protocol Parsing & Validation
// ---------------------------------------------------------------------------

test('parsePreloaderProtocol handles empty or null input fail-closed', () => {
  const empty = wrapper.parsePreloaderProtocol('');
  assert.deepEqual(empty.records, []);
  assert.deepEqual(empty.boundaries, []);
  assert.equal(empty.diagnostic, null);
  assert.equal(empty.processIdentity, null);
});

test('parsePreloaderProtocol validates complete boundary sequence and process identity', () => {
  const nonce = 'valid-nonce-abc';
  const identity = {
    pid: 1234,
    ppid: 5678,
    execPath: process.execPath,
    nodeVersion: process.version,
    platform: process.platform,
  };
  const lines = [
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_WRAPPER_ENTERED', nonce }),
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_IDENTITY_ESTABLISHED', ...identity, nonce }),
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_CHANNELS_ESTABLISHED', nonce }),
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_LOADER_INITIALIZATION_STARTED', nonce }),
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_LOADER_INITIALIZATION_COMPLETED', nonce }),
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_TARGET_EXECUTION_ENTERED', nonce }),
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_TARGET_EXECUTION_COMPLETED', nonce }),
  ].join('\n') + '\n';

  const protocol = wrapper.parsePreloaderProtocol(lines, nonce);
  assert.equal(protocol.records.length, 7);
  assert.deepEqual(protocol.boundaries, wrapper.PRELOADER_BOUNDARIES);
  assert.deepEqual(protocol.processIdentity, identity);
  assert.equal(protocol.diagnostic, null);
});

test('parsePreloaderProtocol rejects nonce mismatch, ordering violations, and malformed records', () => {
  const nonce = 'alpha';
  // Missing newline
  assert.throws(() => wrapper.parsePreloaderProtocol('{"type":"BOUNDARY"}', nonce), /PRELOADER_PROTOCOL_INVALID/);
  // Nonce mismatch
  const badNonce = JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_WRAPPER_ENTERED', nonce: 'beta' }) + '\n';
  assert.throws(() => wrapper.parsePreloaderProtocol(badNonce, nonce), /PRELOADER_NONCE_MISMATCH/);
  // Boundary ordering violation (starts with CHANNELS instead of WRAPPER_ENTERED)
  const badOrder = JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_CHANNELS_ESTABLISHED', nonce }) + '\n';
  assert.throws(() => wrapper.parsePreloaderProtocol(badOrder, nonce), /PRELOADER_PROTOCOL_INVALID/);
});

// ---------------------------------------------------------------------------
// §4 — Positive Classification Invariants (C01 / C03)
// ---------------------------------------------------------------------------

test('C01_POSITIVE_CLASSIFICATION: classified only when positive diagnostic evidence exists', () => {
  const nonce = 'n1';
  const lines = [
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_WRAPPER_ENTERED', nonce }),
    JSON.stringify({
      type: 'DIAGNOSTIC',
      code: 'C01',
      category: 'TSX_LOADER_FAILURE',
      component: wrapper.PRELOADER_COMPONENT,
      boundary: 'PRELOADER_WRAPPER_ENTERED',
      details: { reason: 'TSX_LOADER_FAILED' },
      nonce,
    }),
  ].join('\n') + '\n';

  const protocol = wrapper.parsePreloaderProtocol(lines, nonce);
  const classification = wrapper.classifyPreloaderFailure(protocol);
  assert.equal(classification.code, 'C01');
  assert.equal(classification.category, 'TSX_LOADER_FAILURE');
  assert.equal(classification.positiveEvidence, true);
});

test('C03_POSITIVE_CLASSIFICATION: classified only when positive diagnostic evidence exists', () => {
  const nonce = 'n2';
  const lines = [
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_WRAPPER_ENTERED', nonce }),
    JSON.stringify({
      type: 'DIAGNOSTIC',
      code: 'C03',
      category: 'FD3_WRITE_FAILURE',
      component: wrapper.PRELOADER_COMPONENT,
      boundary: 'PRELOADER_WRAPPER_ENTERED',
      details: { reason: 'EBADF' },
      nonce,
    }),
  ].join('\n') + '\n';

  const protocol = wrapper.parsePreloaderProtocol(lines, nonce);
  const classification = wrapper.classifyPreloaderFailure(protocol);
  assert.equal(classification.code, 'C03');
  assert.equal(classification.category, 'FD3_WRITE_FAILURE');
  assert.equal(classification.positiveEvidence, true);
});

test('ABSENCE_OF_EVENTS: absence of diagnostic event never proves or fabricates C01 or C03', () => {
  // Empty protocol
  const emptyProto = wrapper.parsePreloaderProtocol('');
  const c1 = wrapper.classifyPreloaderFailure(emptyProto);
  assert.equal(c1.code, null);
  assert.equal(c1.category, null);
  assert.equal(c1.positiveEvidence, false);

  // Normal protocol without diagnostic
  const nonce = 'n3';
  const normalProto = wrapper.parsePreloaderProtocol(
    JSON.stringify({ type: 'BOUNDARY', boundary: 'PRELOADER_WRAPPER_ENTERED', nonce }) + '\n',
    nonce,
  );
  const c2 = wrapper.classifyPreloaderFailure(normalProto);
  assert.equal(c2.code, null);
  assert.equal(c2.category, null);
  assert.equal(c2.positiveEvidence, false);
});

// ---------------------------------------------------------------------------
// §5 — Durable Evidence Persistence
// ---------------------------------------------------------------------------

test('persistPreloaderEvidence writes all bin and manifest files atomically', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-preloader-test-'));
  try {
    const manifest = { test: 'manifest', value: 42 };
    const stdout = Buffer.from('stdout-content');
    const stderr = Buffer.from('stderr-content');
    const fd3 = Buffer.from('fd3-content');
    const fd4 = Buffer.from('fd4-content');

    const dest = wrapper.persistPreloaderEvidence(tempDir, manifest, stdout, stderr, fd3, fd4);
    assert.equal(dest, tempDir);

    assert.equal(fs.readFileSync(path.join(tempDir, 'stdout.bin')).toString('utf8'), 'stdout-content');
    assert.equal(fs.readFileSync(path.join(tempDir, 'stderr.bin')).toString('utf8'), 'stderr-content');
    assert.equal(fs.readFileSync(path.join(tempDir, 'fd3.bin')).toString('utf8'), 'fd3-content');
    assert.equal(fs.readFileSync(path.join(tempDir, 'fd4.bin')).toString('utf8'), 'fd4-content');

    const savedManifest = JSON.parse(fs.readFileSync(path.join(tempDir, 'execution-manifest.json'), 'utf8'));
    assert.deepEqual(savedManifest, manifest);
    assert.equal(fs.existsSync(path.join(tempDir, '.partial')), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §6 — End-to-end child process lifecycle and simulation
// ---------------------------------------------------------------------------

test('child process with SIMULATE_TSX_LOADER_FAILURE produces positive C01 diagnostic', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-preloader-e2e-c01-'));
  try {
    const wrapperPath = path.resolve(__dirname, '..', '..', 'scripts', 'gates', 'r13-preloader-wrapper.cjs');
    const nonce = 'e2e-c01-nonce';

    const result = await wrapper.capturePreloaderChild({
      executable: process.execPath,
      args: [wrapperPath, '--nonce', nonce],
      env: { SIMULATE_TSX_LOADER_FAILURE: '1' },
      evidenceRoot: tempDir,
      nonce,
    });

    assert.equal(result.processCreated, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.classification.code, 'C01');
    assert.equal(result.classification.category, 'TSX_LOADER_FAILURE');
    assert.equal(result.classification.positiveEvidence, true);
    assert.equal(fs.existsSync(path.join(tempDir, 'execution-manifest.json')), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('child process with SIMULATE_FD3_WRITE_FAILURE produces positive C03 diagnostic', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-preloader-e2e-c03-'));
  try {
    const wrapperPath = path.resolve(__dirname, '..', '..', 'scripts', 'gates', 'r13-preloader-wrapper.cjs');
    const nonce = 'e2e-c03-nonce';

    const result = await wrapper.capturePreloaderChild({
      executable: process.execPath,
      args: [wrapperPath, '--nonce', nonce],
      env: { SIMULATE_FD3_WRITE_FAILURE: '1' },
      evidenceRoot: tempDir,
      nonce,
    });

    assert.equal(result.processCreated, true);
    assert.equal(result.exitCode, 70);
    assert.equal(result.classification.code, 'C03');
    assert.equal(result.classification.category, 'FD3_WRITE_FAILURE');
    assert.equal(result.classification.positiveEvidence, true);
    assert.equal(fs.existsSync(path.join(tempDir, 'execution-manifest.json')), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
