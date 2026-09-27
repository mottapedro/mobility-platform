'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_RELATIVE_PATH = path.join('governance', 'r7c-r13-historical-execution-manifest.json');
const MANIFEST_SHA256 = 'BE0AC33D95D0AA5D31A2263C9B9F8748D3C3403036C61BCBA864B0CADDCD70A3';
const HISTORICAL_COUNT = 43;
const HISTORICAL_FINGERPRINT = 'e54563bb459e6d20ba2123fc8c18e8414971a4d9b60a1fad28ab0fcf8ae22e9e';
const FULL_CATALOG_COUNT = 57;
const FULL_CATALOG_FINGERPRINT = '8419634934bf3ef9c91c37a0e2a3743b8995cbac9120afcd078d5165a39189aa';
const FOLDER_PATTERN = /^\d{14}_[a-zA-Z0-9_-]+$/;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizedSqlBytes(bytes) {
  return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function fingerprintEntries(entries) {
  const payload = `${entries.map((entry) => `${entry.folderName}\t${entry.normalizedSqlHash}`).join('\n')}\n`;
  return sha256(Buffer.from(payload, 'utf8'));
}

function validateManifestDocument(manifest) {
  if (!manifest || manifest.historicalCount !== HISTORICAL_COUNT
    || manifest.historicalCatalogFingerprint !== HISTORICAL_FINGERPRINT
    || manifest.promotedFullCatalogCount !== FULL_CATALOG_COUNT
    || manifest.promotedFullCatalogFingerprint !== FULL_CATALOG_FINGERPRINT
    || manifest.executionMode !== 'STRICT_HISTORICAL_SEQUENCE'
    || !Array.isArray(manifest.catalog)
    || manifest.catalog.length !== HISTORICAL_COUNT) {
    throw new Error('MANIFEST_CONTRACT_MISMATCH');
  }

  const seen = new Set();
  manifest.catalog.forEach((entry, index) => {
    if (!entry || entry.sequence !== index + 1
      || typeof entry.folderName !== 'string' || !FOLDER_PATTERN.test(entry.folderName)
      || typeof entry.normalizedSqlHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.normalizedSqlHash)
      || seen.has(entry.folderName)) {
      throw new Error(`MANIFEST_ENTRY_INVALID:${index + 1}`);
    }
    seen.add(entry.folderName);
    if (index > 0 && Buffer.compare(Buffer.from(manifest.catalog[index - 1].folderName), Buffer.from(entry.folderName)) >= 0) {
      throw new Error(`MANIFEST_ORDER_INVALID:${index + 1}`);
    }
  });

  if (fingerprintEntries(manifest.catalog) !== HISTORICAL_FINGERPRINT) {
    throw new Error('HISTORICAL_FINGERPRINT_MISMATCH');
  }
  return manifest.catalog.map((entry) => ({ ...entry }));
}

function loadAndVerifyManifest(repositoryRoot) {
  const manifestPath = path.join(repositoryRoot, MANIFEST_RELATIVE_PATH);
  const bytes = fs.readFileSync(manifestPath);
  const actualSha256 = sha256(bytes).toUpperCase();
  if (actualSha256 !== MANIFEST_SHA256) throw new Error('MANIFEST_SHA256_MISMATCH');
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('MANIFEST_JSON_INVALID');
  }
  return {
    manifestSha256: actualSha256,
    entries: validateManifestDocument(manifest),
    historicalCatalogFingerprint: manifest.historicalCatalogFingerprint,
    promotedFullCatalogFingerprint: manifest.promotedFullCatalogFingerprint,
  };
}

function verifyPhysicalArtifacts(repositoryRoot, entries) {
  const migrationsRoot = path.join(repositoryRoot, 'prisma', 'migrations');
  return entries.map((entry) => {
    const folderPath = path.join(migrationsRoot, entry.folderName);
    const sqlPath = path.join(folderPath, 'migration.sql');
    const folderStat = fs.lstatSync(folderPath);
    const sqlStat = fs.lstatSync(sqlPath);
    if (!folderStat.isDirectory() || folderStat.isSymbolicLink() || !sqlStat.isFile() || sqlStat.isSymbolicLink()) {
      throw new Error(`MIGRATION_ARTIFACT_NOT_REGULAR:${entry.folderName}`);
    }
    const actualHash = sha256(normalizedSqlBytes(fs.readFileSync(sqlPath)));
    if (actualHash !== entry.normalizedSqlHash) throw new Error(`MIGRATION_SQL_HASH_MISMATCH:${entry.folderName}`);
    return { ...entry, sqlPath };
  });
}

function loadGovernedHistoricalSet(repositoryRoot) {
  const manifest = loadAndVerifyManifest(repositoryRoot);
  return {
    ...manifest,
    entries: verifyPhysicalArtifacts(repositoryRoot, manifest.entries),
  };
}

module.exports = {
  FULL_CATALOG_COUNT,
  FULL_CATALOG_FINGERPRINT,
  HISTORICAL_COUNT,
  HISTORICAL_FINGERPRINT,
  MANIFEST_RELATIVE_PATH,
  MANIFEST_SHA256,
  fingerprintEntries,
  loadAndVerifyManifest,
  loadGovernedHistoricalSet,
  normalizedSqlBytes,
  validateManifestDocument,
  verifyPhysicalArtifacts,
};
