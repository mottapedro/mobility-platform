'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateTarget, PROJECT_REF } = require('../../scripts/e2e/supabase-target.cjs');
const direct = `postgresql://postgres:fake-password@db.${PROJECT_REF}.supabase.co:5432/postgres`;
const session = `postgresql://postgres.${PROJECT_REF}:fake-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
test('accepts exact E2E direct and session destinations with verified SSL', () => {
  assert.equal(validateTarget(direct).mode, 'direct');
  assert.equal(validateTarget(session + '?sslmode=verify-full&schema=public').mode, 'session');
});
for (const [name, value] of Object.entries({
  missing: undefined,
  hmlDirect: direct.replace(PROJECT_REF, 'kvjwtuugfkqsajlfknud'),
  hmlSession: session.replace(PROJECT_REF, 'kvjwtuugfkqsajlfknud'),
  lookalikeHost: direct.replace('.supabase.co', '.supabase.co.attacker.invalid'),
  transactionPooler: session.replace(':5432/', ':6543/'),
  noExplicitPort: direct.replace(':5432/', '/'),
  otherDatabase: direct.replace('/postgres', '/other'),
  missingPassword: direct.replace(':fake-password', ''),
  sslDisabled: direct + '?sslmode=disable',
  optionsOverride: direct + '?options=-c%20default_transaction_read_only%3Doff',
  otherRegion: session.replace('us-east-1', 'sa-east-1'),
  localhost: 'postgresql://postgres:fake-password@localhost:5432/postgres',
  render: 'postgresql://postgres:fake-password@dpg-example.render.com:5432/postgres',
})) test(`rejects ${name}`, () => assert.throws(() => validateTarget(value), /E2E_TARGET_REJECTED/));
