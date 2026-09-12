'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const artifact = process.argv[2];
if (!artifact) throw new Error('CATALOG_ARTIFACT_PATH_REQUIRED');

function parseManifest(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => line.split('=')));
}

function fingerprint(catalog) {
  const expression = `import { calculateAuthorizedCatalogFingerprint } from './scripts/materialize-authorized-migration-catalog.ts'; process.stdout.write(calculateAuthorizedCatalogFingerprint(process.argv[1]));`;
  const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
  return execFileSync(process.execPath, [tsxCli, '-e', expression, catalog], { encoding: 'utf8' }).trim();
}

const manifest = parseManifest(path.join(artifact, 'manifest'));
const actual = fingerprint(path.join(artifact, 'catalog'));
const expected = fs.readFileSync(path.resolve('governance/authorized-migration-catalog.sha256'), 'utf8').trim();
if (manifest.commit_sha !== (process.env.GITHUB_SHA || 'UNSET')) throw new Error('CATALOG_COMMIT_MISMATCH');
if (manifest.catalog_count !== '56') throw new Error('CATALOG_COUNT_MISMATCH');
if (actual !== manifest.fingerprint || actual !== expected) throw new Error('CATALOG_FINGERPRINT_MISMATCH');
console.log(`AUTHORIZED_CATALOG_FINGERPRINT=${actual}`);
console.log('EXECUTED_CATALOG_ARTIFACT=VERIFIED');
