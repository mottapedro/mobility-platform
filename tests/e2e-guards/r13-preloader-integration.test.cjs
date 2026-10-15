'use strict';

/**
 * Gate R13-X1-F15I-P3-HISTORICAL-EXPORT-BOUNDARY-CORRECTION-01
 * Test Contract: Historical Export Boundary Correction (T01 - T10)
 *
 * Strict isolation:
 * - No migration SQL
 * - No database connection
 * - No historical materializer execution
 * - No Docker mutation
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dispatcher = require('../../scripts/gates/r7c-r13-operational-dispatcher.cjs');
const preloaderWrapper = require('../../scripts/gates/r13-preloader-wrapper.cjs');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const TEST_DATABASE_URL = 'postgresql://ephemeral:secret@127.0.0.1:54321/mobility';

// T01: Direct module import cannot invoke historical materialization without passing an authority boundary.
test('T01: Direct module import cannot invoke historical materialization without passing an authority boundary', () => {
  assert.equal(dispatcher.materializeAuthorizedCatalog, undefined, 'materializeAuthorizedCatalog must not be exported');
  assert.equal('materializeAuthorizedCatalog' in dispatcher, false, 'materializeAuthorizedCatalog property must not exist on dispatcher');

  // Assert assertHistoricalAuthority rejects direct unauthenticated invocation
  assert.throws(
    () => dispatcher.assertHistoricalAuthority({}),
    /HISTORICAL_EXECUTION_UNAUTHORIZED: Direct historical operation without authority is rejected/
  );
});

// T02: Exported API contains no newly exposed historical execution helper.
test('T02: Exported API contains no newly exposed historical execution helper', () => {
  const exportedKeys = Object.keys(dispatcher);
  assert.equal(exportedKeys.includes('materializeAuthorizedCatalog'), false);
  assert.equal(exportedKeys.includes('withAuthorizedCatalog'), false);
  assert.equal(exportedKeys.includes('runBaselineLedger'), false);
  assert.equal(exportedKeys.includes('verifiedTemporaryRoot'), false);
  assert.equal(exportedKeys.includes('removeVerifiedTemporaryRoot'), false);
});

// T03: Existing dispatcher historical operations reject missing authority.
test('T03: Existing dispatcher historical operations reject missing authority', async () => {
  for (const op of dispatcher.OPERATIONS) {
    await assert.rejects(
      () => dispatcher.runOperation(op, {
        env: { DATABASE_URL: TEST_DATABASE_URL },
      }),
      (err) => {
        assert.match(err.message, /HISTORICAL_EXECUTION_UNAUTHORIZED: Direct historical operation without authority is rejected/);
        return true;
      }
    );
  }
});

// T04: Diagnostic operation remains callable without historical authority.
test('T04: Diagnostic operation remains callable without historical authority', async () => {
  const outcome = await dispatcher.runOperation('diagnostic', {
    env: {}, // No historical authority, no DATABASE_URL
  });
  assert.equal(outcome.operation, 'diagnostic');
  assert.equal(outcome.status, 0);
  assert.equal(outcome.classification, 'VALID_EVIDENCE');
  assert.equal(outcome.diagnosticState, 'DIAGNOSTIC_COMPLETED');
  assert.equal(outcome.historicalAuthorityGranted, false);
  try { fs.rmSync(outcome.evidenceRoot, { recursive: true, force: true }); } catch {}
});

// T05: Diagnostic execution bypasses withAuthorizedCatalog.
test('T05: Diagnostic execution bypasses withAuthorizedCatalog', async () => {
  let catalogMkdtempCalled = false;
  const outcome = await dispatcher.runOperation('diagnostic', {
    env: {},
    mkdtempSync: (prefix) => {
      catalogMkdtempCalled = true;
      throw new Error('E: CATALOG_TEMPROOT_FORBIDDEN');
    },
  });
  assert.equal(catalogMkdtempCalled, false, 'withAuthorizedCatalog must not be called during diagnostic');
  assert.equal(outcome.operation, 'diagnostic');
  try { fs.rmSync(outcome.evidenceRoot, { recursive: true, force: true }); } catch {}
});

// T06: Diagnostic fd3/fd4 protocol remains unchanged.
test('T06: Diagnostic fd3/fd4 protocol remains unchanged', async () => {
  const nonce = 't06-protocol-' + Date.now();
  const outcome = await dispatcher.runOperation('diagnostic', {
    generateNonce: () => nonce,
  });
  assert.equal(outcome.fd3Established, true);
  assert.equal(outcome.fd4Established, true);
  assert.equal(outcome.classification, 'VALID_EVIDENCE');

  const manifest = JSON.parse(fs.readFileSync(path.join(outcome.evidenceRoot, 'execution-manifest.json'), 'utf8'));
  assert.equal(manifest.operation, 'diagnostic');
  assert.equal(manifest.nonce, nonce);
  assert.equal(manifest.fd3Established, true);
  assert.equal(manifest.fd4Established, true);

  const fd4Raw = fs.readFileSync(path.join(outcome.evidenceRoot, 'fd4.bin'), 'utf8');
  const preloaderProtocol = preloaderWrapper.parsePreloaderProtocol(fd4Raw, nonce);
  assert.equal(preloaderProtocol.boundaries.length, 7);
  assert.deepEqual(preloaderProtocol.boundaries, [
    'PRELOADER_WRAPPER_ENTERED',
    'PRELOADER_IDENTITY_ESTABLISHED',
    'PRELOADER_CHANNELS_ESTABLISHED',
    'PRELOADER_LOADER_INITIALIZATION_STARTED',
    'PRELOADER_LOADER_INITIALIZATION_COMPLETED',
    'PRELOADER_TARGET_EXECUTION_ENTERED',
    'PRELOADER_TARGET_EXECUTION_COMPLETED',
  ]);
  try { fs.rmSync(outcome.evidenceRoot, { recursive: true, force: true }); } catch {}
});

// T07: Synthetic test authority is rejected by production-facing entrypoints.
test('T07: Synthetic test authority is rejected by production-facing entrypoints', async () => {
  await assert.rejects(
    () => dispatcher.runOperation('targetIdentity', {
      env: { DATABASE_URL: TEST_DATABASE_URL },
      historicalAuthority: { synthetic: true },
    }),
    (err) => {
      assert.match(err.message, /HISTORICAL_EXECUTION_UNAUTHORIZED: Synthetic test capability cannot authorize historical execution/);
      return true;
    }
  );

  assert.throws(
    () => dispatcher.assertHistoricalAuthority({
      historicalAuthority: { synthetic: true },
    }),
    /HISTORICAL_EXECUTION_UNAUTHORIZED: Synthetic test capability cannot authorize historical execution/
  );
});

// T08: Historical constants and fingerprints remain unchanged.
test('T08: Historical constants and fingerprints remain unchanged', () => {
  assert.equal(dispatcher.BASELINE_MIGRATION, '20260101000000_init_baseline');
  assert.equal(dispatcher.BASELINE_SQL_SHA256, '84e8350d60cf6fc917e8187a6df74871b885b1587149d7ad725c7cf7a213d814');
  assert.equal(dispatcher.AUTHORIZED_CATALOG_FINGERPRINT, '8419634934bf3ef9c91c37a0e2a3743b8995cbac9120afcd078d5165a39189aa');
  assert.equal(dispatcher.EXPECTED_DATABASE, 'mobility');
  assert.equal(dispatcher.EXPECTED_POSTGRES_MAJOR, 15);
  assert.deepEqual(Array.from(dispatcher.OPERATIONS), [
    'targetIdentity',
    'emptyState',
    'migrationTable',
    'baseline',
    'baselineLedger',
  ]);
  assert.equal(Object.isFrozen(dispatcher.OPERATIONS), true);
});

// T09: Existing unit tests retain valid dependency injection behavior.
test('T09: Existing unit tests retain valid dependency injection behavior', () => {
  const mockSpawnSync = () => ({
    status: 0,
    error: null,
    stdout: 'MOCK_OUTPUT',
    stderr: '',
    output: [null, '', '', '', ''],
  });
  assert.doesNotThrow(() => {
    dispatcher.assertHistoricalAuthority({ spawnSync: mockSpawnSync });
  });
});

// T10: No historical materializer or SQL execution occurs during testing.
test('T10: No historical materializer or SQL execution occurs during testing', async () => {
  let pgAttempted = false;
  let materializerAttempted = false;
  const outcome = await dispatcher.runOperation('diagnostic', {
    env: { DATABASE_URL: 'postgresql://invalid-host:9999/mobility' },
    createClient: () => {
      pgAttempted = true;
      throw new Error('E: PG_CONNECT_FORBIDDEN');
    },
    spawnSync: (exec, args, options) => {
      if (args.some((a) => typeof a === 'string' && a.includes('materialize-authorized-migration-catalog.ts'))) {
        materializerAttempted = true;
        throw new Error('E: MATERIALIZER_EXECUTION_FORBIDDEN');
      }
      const probeScript = path.join(REPOSITORY_ROOT, 'scripts', 'gates', 'r13-diagnostic-probe.cjs');
      return require('node:child_process').spawnSync(exec, [probeScript], options);
    },
  });

  assert.equal(pgAttempted, false, 'No PostgreSQL connection attempted');
  assert.equal(materializerAttempted, false, 'No historical materializer executed');
  assert.equal(outcome.operation, 'diagnostic');
});
