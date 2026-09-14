'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateMigrationHistory } = require('../../scripts/e2e/ephemeral-migration-safety-audit.cjs');

const superseded = '20260518000000_passenger_codes_not_null_future';
const expected = ['20260101000000_init_baseline',
  ...Array.from({ length: 55 }, (_, index) => `authorized_${String(index).padStart(2, '0')}`)];

function rowsFor(names = expected) {
  return names.map((migration_name) => ({
    migration_name,
    finished_at: '2026-09-13T00:00:00Z',
    rolled_back_at: null,
    logs: null,
  }));
}

test('A: complete 56-name history passes', () => {
  assert.equal(evaluateMigrationHistory(rowsFor(), expected).valid, true);
});

test('B: one historical migration missing fails closed', () => {
  const rows = rowsFor();
  rows.pop();
  assert.equal(evaluateMigrationHistory(rows, expected).valid, false);
});

test('C: unexpected extra migration fails closed', () => {
  const rows = rowsFor();
  rows[0].migration_name = 'unexpected_migration';
  assert.equal(evaluateMigrationHistory(rows, expected).valid, false);
});

test('D: Passenger superseded migration fails closed', () => {
  const rows = rowsFor();
  rows[0].migration_name = superseded;
  const evidence = evaluateMigrationHistory(rows, expected);
  assert.equal(evidence.passengerPresent, true);
  assert.equal(evidence.valid, false);
});

test('E: unfinished migration fails closed', () => {
  const rows = rowsFor();
  rows[0].finished_at = null;
  assert.equal(evaluateMigrationHistory(rows, expected).valid, false);
});

test('F: rolled-back migration fails closed', () => {
  const rows = rowsFor();
  rows[0].rolled_back_at = '2026-09-13T00:00:00Z';
  assert.equal(evaluateMigrationHistory(rows, expected).valid, false);
});

test('G: the same 56 names in another order pass', () => {
  assert.equal(evaluateMigrationHistory(rowsFor([...expected].reverse()), expected).valid, true);
});

test('H: baseline plus twelve post-cutoff migrations fails closed', () => {
  assert.equal(evaluateMigrationHistory(rowsFor(expected.slice(0, 13)), expected).valid, false);
});
