'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync(require.resolve('../e2e/phase-4b3-network-capability.spec.ts'), 'utf8');

test('4B3 has no global reset or unfiltered cleanup', () => {
  assert.doesNotMatch(source, /\/test\/reset|TRUNCATE|deleteMany\(\s*\{\s*\}\s*\)/i);
  assert.doesNotMatch(source, /rootDriverId:\s*\{\s*in:\s*owned\.driverIds\s*\}/);
});

test('4B3 requires real final certification and target validation', () => {
  assert.match(source, /validateTarget\(process\.env\.DATABASE_URL\)/);
  assert.match(source, /migration-safety-audit\.cjs.*--certify-final/);
  assert.doesNotMatch(source, /M3_2_FINAL_CERTIFIED/);
});

test('4B3 cleanup is inside finally after quiescence and uses owned IDs', () => {
  assert.match(source, /finally\s*\{[\s\S]*quiesceOwnedRuntime\(\)[\s\S]*cleanupOwned\(frozen\)/);
  assert.match(source, /referralRelationship\.deleteMany\(\{\s*where:\s*\{\s*id:\s*\{\s*in:\s*frozen\.referralRelationshipIds/);
  assert.match(source, /prisma\?\.\$disconnect\(\)/);
});

test('4B3 freezes ownership before quiescence and cleanup has no discovery', () => {
  assert.match(source, /captureOwnedDerivedRecords\(\)[\s\S]*freezeOwnership\(\)[\s\S]*quiesceOwnedRuntime\(\)[\s\S]*cleanupOwned\(frozen\)/);
  const cleanup = source.match(/async function cleanupOwned\([\s\S]*?\n}\n\nasync function quiesceOwnedRuntime/)[0];
  assert.doesNotMatch(cleanup, /findMany|findFirst|count\(|owned\.[A-Za-z]+\.push/);
  assert.match(source, /driverReferralIds/);
  assert.match(source, /referralRelationshipIds/);
});

test('4B3 uses per-ride quiescence and never global scheduler reset', () => {
  assert.match(source, /quiesceForRide\(rideId\)/);
  assert.doesNotMatch(source, /cancelAll\(|shutdownAsync\(/);
  assert.match(source, /active !== 0/);
});
