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
  evaluatePromotionEvidence,
  pendingEffectContracts,
  targetIdentity,
  verifyCertificationArtifact,
  collectPromotionEvidence,
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

const { execFileSync } = require('node:child_process');
const governedModel = JSON.parse(execFileSync(process.execPath, [
  path.resolve('node_modules/tsx/dist/cli.mjs'), '-e',
  "import {AUTHORIZED_MIGRATIONS,HISTORICAL_MIGRATIONS,POST_CUTOFF_MIGRATIONS} from './scripts/materialize-authorized-migration-catalog.ts'; console.log(JSON.stringify({authorized:AUTHORIZED_MIGRATIONS,historical:HISTORICAL_MIGRATIONS,postCutoff:POST_CUTOFF_MIGRATIONS}));",
], { encoding: 'utf8' }));

function evidenceFixture() {
  const pending = pendingEffectContracts.map((entry) => entry.migration);
  return {
    artifactVerified: true, identityValid: true, model: structuredClone(governedModel),
    rows: governedModel.authorized.filter((name) => !pending.includes(name)).map((migration_name) => ({ migration_name, finished_at: '2026-09-14', rolled_back_at: null, logs: null })),
    effects: Object.fromEntries(pendingEffectContracts.flatMap((entry) => entry.effects.map((name) => [name, false]))),
    compatibility: Object.fromEntries(pending.map((name) => [name, { compatible: 'YES', blocker: 'NONE' }])),
    unrelatedDrift: [],
  };
}

test('completion A: actual governed 51 + five pending produces complete evidence', () => {
  const input = evidenceFixture();
  assert.equal(input.rows.length, 51);
  const result = evaluatePromotionEvidence(input);
  assert.equal(result.safe, true);
  assert.equal(result.outputs.MIGRATE_DEPLOY_EXPECTED_PENDING_COUNT, 5);
  assert.equal(result.outputs.TARGET_EXPECTED_PENDING_PHYSICAL_EFFECTS.length, 6);
  assert.equal(result.outputs.TARGET_UNEXPLAINED_PHYSICAL_DRIFT, 'NONE');
  assert.equal(result.outputs.MIGRATE_DEPLOY_AUTHORITY, 'DENIED');
});

test('completion B: unexpected history blocks readiness', () => {
  const input = evidenceFixture();
  input.rows.push({ migration_name: 'unexpected', finished_at: 'done' });
  assert.equal(evaluatePromotionEvidence(input).safe, false);
});

test('completion C: superseded Passenger history blocks readiness', () => {
  const input = evidenceFixture();
  input.rows.push({ migration_name: '20260518000000_passenger_codes_not_null_future', finished_at: 'done' });
  assert.equal(evaluatePromotionEvidence(input).safe, false);
});

test('completion D: duplicate pending offers block data compatibility', () => {
  const input = evidenceFixture();
  input.compatibility[pendingEffectContracts[4].migration] = { compatible: 'NO', blocker: 'DUPLICATE_PENDING' };
  const result = evaluatePromotionEvidence(input);
  assert.equal(result.safe, false);
  assert.equal(result.matrix[4].BLOCKER, 'DUPLICATE_PENDING');
});

test('completion E: unrelated physical drift remains explicit', () => {
  const input = evidenceFixture();
  input.unrelatedDrift.push('OwnershipSnapshot:MISSING');
  const result = evaluatePromotionEvidence(input);
  assert.equal(result.safe, false);
  assert.deepEqual(result.outputs.TARGET_UNEXPLAINED_PHYSICAL_DRIFT, input.unrelatedDrift);
});

test('completion F: failed artifact verification blocks readiness', () => {
  const input = evidenceFixture();
  input.artifactVerified = false;
  assert.equal(evaluatePromotionEvidence(input).safe, false);
});

test('completion G: wrong identity blocks readiness and does not certify production exclusion', () => {
  const input = evidenceFixture();
  const identity = targetIdentity({ mode: 'session', projectRef: 'wrong-project' }, { database_name: 'postgres', server_version_num: '170005' });
  input.identityValid = identity.valid;
  assert.equal(identity.outputs.TARGET_IS_PRODUCTION, 'UNKNOWN');
  assert.equal(evaluatePromotionEvidence(input).safe, false);
});

test('completion H: same five names in invalid governed order blocks readiness', () => {
  const input = evidenceFixture();
  input.model.authorized.reverse();
  const result = evaluatePromotionEvidence(input);
  assert.equal(result.safe, false);
  assert.equal(result.outputs.TARGET_PENDING_ORDER_VALID, 'INCONCLUSIVE');
});

test('unfinished, rolled-back, failed and duplicate history never certify', () => {
  for (const change of [{ finished_at: null }, { rolled_back_at: 'done' }, { logs: 'failure' }]) {
    const input = evidenceFixture();
    Object.assign(input.rows[0], change);
    assert.equal(evaluatePromotionEvidence(input).safe, false);
  }
  const input = evidenceFixture();
  input.rows.push(input.rows[0]);
  assert.equal(evaluatePromotionEvidence(input).safe, false);
});

test('artifact verifier rejects an absent artifact without a database connection', () => {
  assert.throws(() => verifyCertificationArtifact(path.join(__dirname, '__absent_catalog__', 'catalog')), /AUTHORIZED_ARTIFACT_VERIFICATION_FAILED/);
});

test('artifact wiring invokes the governed verifier before target connection', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/e2e/lifecycle-read-only-certification.cjs'), 'utf8');
  assert.match(source, /scripts\/e2e\/verify-authorized-migration-artifact\.cjs/);
  const main = source.slice(source.indexOf('async function main()'));
  assert.ok(main.indexOf('verifyCertificationArtifact(') < main.indexOf('client.connect()'));
  assert.match(source, /current_setting\('transaction_read_only'\)/);
  assert.match(source, /rejectUnauthorized: true/);
});

test('collector derives five compatibility checks from SQL responses and blocks real duplicate count', async () => {
  const fixture = evidenceFixture();
  const queries = [];
  const client = { query: async (sql) => {
    queries.push(sql);
    if (sql.includes('FROM public."Passenger"')) return { rows: [{ total: '10', referral_null: '5', slug_null: '3' }] };
    if (sql.includes('FROM pg_class')) return { rows: [] };
    throw new Error('UNEXPECTED_QUERY');
  } };
  const facts = {
    artifact: { verified: true, model: fixture.model }, identityValid: true,
    migrationRows: fixture.rows, snapshotPresent: true, duplicatePending: 0,
    columnRows: [
      ...['currentDispatchStage', 'rootDriverId', 'selectedDriverId', 'currentCandidateDriverId', 'excludedDriverIds'].map((column_name) => ({ table_name: 'RideRequest', column_name })),
      ...['referralCode', 'publicSlug'].map((column_name) => ({ table_name: 'Passenger', column_name, is_nullable: 'YES' })),
    ],
    availability: enumAvailability([
      ...['PENDING', 'MATCHING', 'WAITING_DRIVER', 'WAITING_REFERRAL', 'WAITING_PARTNER', 'WAITING_GENERAL', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'PAID'].map((enum_value) => ({ enum_name: 'RideStatus', enum_value })),
      ...['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED'].map((enum_value) => ({ enum_name: 'RideOfferStatus', enum_value })),
    ]),
  };
  const result = await collectPromotionEvidence(client, facts);
  assert.equal(result.safe, true);
  assert.equal(result.matrix[0].COLUMN_PRESENT, false);
  assert.equal(result.matrix[4].DUPLICATE_PENDING_RIDE_COUNT, 0);
  assert.equal(queries.length, 2);
  assert.ok(queries.every((sql) => sql.trimStart().startsWith('SELECT')));
  assert.ok(!queries.some((sql) => sql.includes('GROUP BY "creationCorrelationId"')));
  const blocked = await collectPromotionEvidence(client, { ...facts, duplicatePending: 1 });
  assert.equal(blocked.safe, false);
  assert.equal(blocked.matrix[4].TARGET_COMPATIBLE, 'NO');
});
