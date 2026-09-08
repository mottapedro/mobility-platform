'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const cli = path.resolve('node_modules/tsx/dist/cli.mjs');
const expression = `import { materializeAuthorizedMigrationCatalog, calculateAuthorizedCatalogFingerprint } from './scripts/materialize-authorized-migration-catalog.ts'; const r=materializeAuthorizedMigrationCatalog({targetPath: process.argv[1]}); process.stdout.write(calculateAuthorizedCatalogFingerprint(r.path));`;

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-fingerprint-test-'));
try {
  const canonical = execFileSync(process.execPath, [cli, '-e', expression, path.join(temp, 'lf')], { encoding: 'utf8' }).trim();
  const crlfRoot = path.join(temp, 'crlf');
  fs.cpSync(path.join(temp, 'lf'), crlfRoot, { recursive: true });
  for (const entry of fs.readdirSync(crlfRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(crlfRoot, entry.name, 'migration.sql');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
  }
  const crossPlatform = execFileSync(process.execPath, [cli, '-e', `import { calculateAuthorizedCatalogFingerprint } from './scripts/materialize-authorized-migration-catalog.ts'; process.stdout.write(calculateAuthorizedCatalogFingerprint(process.argv[1]));`, crlfRoot], { encoding: 'utf8' }).trim();
  assert.equal(crossPlatform, canonical);
  const mutated = path.join(crlfRoot, '20260101000000_init_baseline', 'migration.sql');
  fs.appendFileSync(mutated, '-- content mutation\n', 'utf8');
  const changed = execFileSync(process.execPath, [cli, '-e', `import { calculateAuthorizedCatalogFingerprint } from './scripts/materialize-authorized-migration-catalog.ts'; process.stdout.write(calculateAuthorizedCatalogFingerprint(process.argv[1]));`, crlfRoot], { encoding: 'utf8' }).trim();
  assert.notEqual(changed, canonical);
  console.log('CRLF_INPUT_FINGERPRINT=PASS');
  console.log('CONTENT_MUTATION_FINGERPRINT=PASS');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
