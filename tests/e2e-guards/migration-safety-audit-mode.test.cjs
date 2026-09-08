'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateMode, parseExecutionResult } = require('../../scripts/e2e/migration-safety-audit.cjs');

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

test('UNKNOWN remains fail-closed', () => {
  const result = evaluateMode({ mode: '--post-write', executionResult: 'success', stateName: 'UNKNOWN' });
  assert.equal(result.exitCode, 1);
  assert.equal(result.humanInspectionRequired, 'YES');
});
