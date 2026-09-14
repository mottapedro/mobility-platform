'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  enumAvailability,
  enumDependentChecks,
  evaluateMigrationInventory,
  evaluatePhysicalCompatibility,
  runEnumDependentChecks,
} = require('../../scripts/e2e/lifecycle-read-only-certification.cjs');

const absentEnums = [
  { enum_name: 'RideStatus', enum_value: 'PENDING' },
  { enum_name: 'RideOfferStatus', enum_value: 'PENDING' },
];
const presentEnums = [
  { enum_name: 'RideStatus', enum_value: 'WAITING_OWNER' },
  { enum_name: 'RideOfferStatus', enum_value: 'CANCELLED' },
];

test('A: WAITING_OWNER absent skips its dependent SQL', async () => {
  const checks = enumDependentChecks(enumAvailability(absentEnums));
  assert.equal(checks.waitingOwner.output, 'NOT_APPLICABLE_ENUM_ABSENT');
  assert.equal(checks.waitingOwner.sql, undefined);
  const result = await runEnumDependentChecks({ query: async () => assert.fail('query must not run') }, enumAvailability(absentEnums));
  assert.equal(result.waitingOwner, 'NOT_APPLICABLE_ENUM_ABSENT');
});

test('B: WAITING_OWNER present executes its dependent SQL', async () => {
  const availability = enumAvailability([...absentEnums, presentEnums[0]]);
  const calls = [];
  const result = await runEnumDependentChecks({ query: async (sql) => { calls.push(sql); return { rows: [{ count: '2' }] }; } }, availability);
  assert.equal(result.waitingOwner, '2');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /WAITING_OWNER/);
});

test('C: CANCELLED absent skips its dependent SQL', async () => {
  const availability = enumAvailability([...absentEnums, presentEnums[0]]);
  const checks = enumDependentChecks(availability);
  assert.equal(checks.cancelled.output, 'NOT_APPLICABLE_ENUM_ABSENT');
  const calls = [];
  const result = await runEnumDependentChecks({ query: async (sql) => { calls.push(sql); return { rows: [{ count: '0' }] }; } }, availability);
  assert.equal(result.cancelled, 'NOT_APPLICABLE_ENUM_ABSENT');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /WAITING_OWNER/);
});

test('D: both absent lifecycle enums remain physical drift', () => {
  assert.equal(evaluatePhysicalCompatibility({ waitingOwnerPresent: false, cancelledPresent: false, requiredColumnsPresent: true, indexEquivalent: true }), 'PRESENT');
});

test('F: enum absence cannot mark the target schema compatible', () => {
  assert.notEqual(evaluatePhysicalCompatibility({ waitingOwnerPresent: false, cancelledPresent: true, requiredColumnsPresent: true, indexEquivalent: true }), 'NONE');
});

test('E: a present-enum dependent query fails closed', async () => {
  const availability = enumAvailability([...absentEnums, ...presentEnums]);
  await assert.rejects(
    runEnumDependentChecks({ query: async () => { throw new Error('DATABASE_QUERY_FAILURE'); } }, availability),
    /DATABASE_QUERY_FAILURE/,
  );
});

test('migration inventory preserves missing, unexpected, and failed evidence', () => {
  const inventory = evaluateMigrationInventory([
    { migration_name: 'a', finished_at: 'done', rolled_back_at: null, logs: null },
    { migration_name: 'unexpected', finished_at: null, rolled_back_at: null, logs: 'failed' },
  ], ['a', 'b']);
  assert.deepEqual(inventory.missing, ['b']);
  assert.deepEqual(inventory.unexpected, ['unexpected']);
  assert.equal(inventory.failed.length, 1);
});

test('read-only certifier retains its transaction and excludes write SQL', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/e2e/lifecycle-read-only-certification.cjs'), 'utf8');
  assert.match(source, /BEGIN TRANSACTION READ ONLY/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|UPSERT|CREATE|ALTER|DROP|TRUNCATE)\s+(?:INTO|TABLE|INDEX|FROM)\b/i);
});

test('workflow materializes the governed catalog without a direct or write path', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/lifecycle-read-only-certification.yml'), 'utf8');
  assert.match(workflow, /materialize-authorized-migration-catalog\.ts/);
  assert.match(workflow, /PRISMA_MIGRATIONS_PATH/);
  assert.doesNotMatch(workflow, /DIRECT_URL|migrate\s+(?:deploy|resolve|dev)|db\s+push|seed/i);
});
