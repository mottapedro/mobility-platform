'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateFinalState, evaluateMode, parseExecutionResult } = require('../../scripts/e2e/migration-safety-audit.cjs');

const row = (migration_name, overrides = {}) => ({
  migration_name,
  finished_at: new Date(),
  rolled_back_at: null,
  logs: null,
  ...overrides,
});

test('require-e0 + E0 exits 0 without execution result', () => {
  assert.deepEqual(evaluateMode({ mode: '--require-e0', stateName: 'E0' }), {
    writeEligible: 'YES', humanInspectionRequired: 'NO', governedFinal: 'NOT_APPLICABLE', exitCode: 0,
  });
});

test('require-e0 + non-E0 exits 1', () => {
  assert.equal(evaluateMode({ mode: '--require-e0', stateName: 'UNKNOWN' }).exitCode, 1);
});

test('require-e0 ignores absent execution result', () => {
  assert.equal(parseExecutionResult(['node', 'audit', '--require-e0']), undefined);
  assert.equal(evaluateMode({ mode: '--require-e0', stateName: 'E0' }).exitCode, 0);
});

test('post-write without execution result exits 1', () => {
  assert.equal(evaluateMode({ mode: '--post-write', stateName: 'FINAL' }).exitCode, 1);
});

test('post-write failure is not governed final', () => {
  const result = evaluateMode({ mode: '--post-write', executionResult: 'failure', stateName: 'FINAL' });
  assert.equal(result.governedFinal, 'NO');
  assert.equal(result.exitCode, 1);
});

test('require-final success + FINAL is governed final', () => {
  const result = evaluateMode({ mode: '--require-final', executionResult: 'success', stateName: 'FINAL' });
  assert.equal(result.governedFinal, 'YES');
  assert.equal(result.exitCode, 0);
});

test('certify-final + FINAL is governed without execution result', () => {
  const result = evaluateMode({ mode: '--certify-final', stateName: 'FINAL' });
  assert.deepEqual(result, {
    writeEligible: 'NO', humanInspectionRequired: 'NO', governedFinal: 'YES', exitCode: 0,
  });
});

test('certify-final + incomplete state fails closed', () => {
  const result = evaluateMode({ mode: '--certify-final', stateName: 'PARTIAL' });
  assert.equal(result.governedFinal, 'NO');
  assert.equal(result.humanInspectionRequired, 'YES');
  assert.equal(result.exitCode, 1);
});

test('UNKNOWN remains fail-closed', () => {
  const result = evaluateMode({ mode: '--post-write', executionResult: 'success', stateName: 'UNKNOWN' });
  assert.equal(result.exitCode, 1);
  assert.equal(result.humanInspectionRequired, 'YES');
});

test('complete authorized catalog is FINAL', () => {
  assert.equal(evaluateFinalState({
    migrationsExists: true,
    expectedNames: ['001', '002'],
    appliedRows: [row('001'), row('002')],
  }).stateName, 'FINAL');
});

test('migration table exists but incomplete catalog is PARTIAL', () => {
  const result = evaluateFinalState({
    migrationsExists: true,
    expectedNames: ['001', '002'],
    appliedRows: [row('001')],
  });
  assert.equal(result.stateName, 'PARTIAL');
  assert.equal(result.missingCount, 1);
});

test('unexpected, failed, and incomplete migrations are not FINAL', () => {
  const result = evaluateFinalState({
    migrationsExists: true,
    expectedNames: ['001'],
    appliedRows: [
      row('001', { logs: 'failed' }),
      row('002'),
      row('001-incomplete', { finished_at: null }),
    ],
  });
  assert.equal(result.stateName, 'PARTIAL');
  assert.equal(result.failedCount, 1);
  assert.equal(result.unexpectedCount, 2);
});

test('missing catalog evidence is UNKNOWN and fail-closed', () => {
  assert.equal(evaluateFinalState({ migrationsExists: true }).stateName, 'UNKNOWN');
});
