'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePreDeployHistory } = require('../../scripts/e2e/ephemeral-replay-proof.cjs');

const pending = [
  '20260813000000_add_auth_sessions',
  '20260813010000_seed_skill_catalog_reference_data',
  '20260817000000_ride_scheduled_at_nullable',
  '20260817000001_add_ride_place_ids',
  '20260817000002_add_ride_quote_contract',
  '20260817000003_add_driver_base_current_location_offer_snapshot',
  '20260824000000_add_ride_offer_history_index',
  '20260909000000_add_ride_creation_correlation',
  '20260909000001_add_ride_creation_intent_fingerprint',
  '20260910000000_add_waiting_owner_ride_status',
  '20260910000001_add_cancelled_ride_offer_status',
  '20260911000000_restore_one_pending_offer_per_ride',
];

function fixture() {
  const historical = ['20260101000000_init_baseline',
    ...Array.from({ length: 43 }, (_, i) => `historical_${i}`)];
  return {
    authorized: [...historical, ...pending],
    rows: historical.map((migration_name) => ({ migration_name,
      finished_at: '2026-09-13T00:00:00Z', rolled_back_at: null, logs: null })),
  };
}

test('A: exactly 44 applied and the nominal 12 pending pass', () => {
  const { rows, authorized } = fixture();
  const result = evaluatePreDeployHistory(rows, authorized);
  assert.equal(result.PRE_DEPLOY_HISTORY_VALID, 'YES');
  assert.equal(result.PRE_DEPLOY_AUTHORIZED_COUNT, 56);
  assert.equal(result.PRE_DEPLOY_EXPECTED_APPLIED_COUNT, 44);
  assert.equal(result.PRE_DEPLOY_APPLIED_COUNT, 44);
  assert.equal(result.PRE_DEPLOY_APPLIED_EXACT_MATCH, 'YES');
  assert.equal(result.PRE_DEPLOY_PENDING_COUNT, 12);
  assert.equal(result.PRE_DEPLOY_PENDING_EXACT_MATCH, 'YES');
  assert.equal(result.PRE_DEPLOY_UNFINISHED_COUNT, 0);
  assert.equal(result.PRE_DEPLOY_ROLLED_BACK_COUNT, 0);
});

test('B: only 43 applied fails', () => {
  const { rows, authorized } = fixture();
  rows.pop();
  const result = evaluatePreDeployHistory(rows, authorized);
  assert.equal(result.PRE_DEPLOY_HISTORY_VALID, 'NO');
  assert.equal(result.PRE_DEPLOY_MISSING_APPLIED_COUNT, 1);
  assert.equal(result.PRE_DEPLOY_PENDING_COUNT, 13);
});

test('C: 44 applied with one wrong name fails', () => {
  const { rows, authorized } = fixture();
  rows[0].migration_name = 'foreign_migration';
  const result = evaluatePreDeployHistory(rows, authorized);
  assert.equal(result.PRE_DEPLOY_APPLIED_COUNT, 44);
  assert.equal(result.PRE_DEPLOY_HISTORY_VALID, 'NO');
  assert.equal(result.PRE_DEPLOY_APPLIED_EXACT_MATCH, 'NO');
  assert.equal(result.PRE_DEPLOY_UNEXPECTED_APPLIED_COUNT, 1);
});

test('D: 12 pending with a wrong nominal member fails', () => {
  const { rows, authorized } = fixture();
  authorized[55] = 'unexpected_pending';
  const result = evaluatePreDeployHistory(rows, authorized);
  assert.equal(result.PRE_DEPLOY_PENDING_COUNT, 12);
  assert.equal(result.PRE_DEPLOY_PENDING_EXACT_MATCH, 'NO');
  assert.equal(result.PRE_DEPLOY_MISSING_PENDING_COUNT, 1);
  assert.equal(result.PRE_DEPLOY_UNEXPECTED_PENDING_COUNT, 1);
  assert.equal(result.PRE_DEPLOY_HISTORY_VALID, 'NO');
});

test('E: superseded Passenger is rejected even if admitted into the catalog', () => {
  for (const admitted of [false, true]) {
    const { rows, authorized } = fixture();
    rows[0].migration_name = '20260518000000_passenger_codes_not_null_future';
    if (admitted) authorized[0] = rows[0].migration_name;
    const result = evaluatePreDeployHistory(rows, authorized);
    assert.equal(result.PRE_DEPLOY_PASSENGER_SUPERSEDED_PRESENT, 'YES');
    assert.equal(result.PRE_DEPLOY_HISTORY_VALID, 'NO');
  }
});

test('F: unfinished row fails with or without error logs', () => {
  for (const logs of [null, 'migration error']) {
    const { rows, authorized } = fixture();
    rows[0].finished_at = null;
    rows[0].logs = logs;
    const result = evaluatePreDeployHistory(rows, authorized);
    assert.equal(result.PRE_DEPLOY_UNFINISHED_COUNT, 1);
    assert.equal(result.PRE_DEPLOY_HISTORY_VALID, 'NO');
  }
});

test('G: rolled back row fails even with finished_at', () => {
  const { rows, authorized } = fixture();
  rows[0].rolled_back_at = '2026-09-13T01:00:00Z';
  const result = evaluatePreDeployHistory(rows, authorized);
  assert.equal(result.PRE_DEPLOY_ROLLED_BACK_COUNT, 1);
  assert.equal(result.PRE_DEPLOY_HISTORY_VALID, 'NO');
});

test('duplicate history or catalog entries fail closed', () => {
  const { rows, authorized } = fixture();
  assert.equal(evaluatePreDeployHistory([...rows, rows[0]], authorized).PRE_DEPLOY_HISTORY_VALID, 'NO');
  assert.equal(evaluatePreDeployHistory(rows, [...authorized, authorized[0]]).PRE_DEPLOY_HISTORY_VALID, 'NO');
  rows[1] = { ...rows[0] };
  assert.equal(evaluatePreDeployHistory(rows, authorized).PRE_DEPLOY_APPLIED_EXACT_MATCH, 'NO');
});

test('set comparison is order independent and does not mutate inputs', () => {
  const { rows, authorized } = fixture();
  const expected = evaluatePreDeployHistory(rows, authorized);
  const frozenRows = Object.freeze(rows.reverse().map(Object.freeze));
  const frozenCatalog = Object.freeze(authorized.reverse());
  assert.deepEqual(evaluatePreDeployHistory(frozenRows, frozenCatalog), expected);
});
