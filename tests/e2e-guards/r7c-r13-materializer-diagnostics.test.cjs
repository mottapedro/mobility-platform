'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const materializer = require('../../scripts/materialize-authorized-migration-catalog.ts');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'materialize-authorized-migration-catalog.ts'), 'utf8');

function capture() {
  const writes = [];
  const diagnostics = materializer.createMaterializerDiagnostics((fd, bytes) => {
    assert.equal(fd, 3);
    writes.push(Buffer.from(bytes));
  });
  return { diagnostics, writes, records: () => writes.map((bytes) => JSON.parse(bytes.toString('utf8'))) };
}

test('01 nonzero child with no diagnostic is representable by an empty fd3 stream', () => {
  assert.deepEqual(capture().records(), []);
});

for (const [number, boundary] of materializer.MATERIALIZER_BOUNDARIES.entries()) {
  test(`${String(number + 2).padStart(2, '0')} emits closed boundary ${boundary}`, () => {
    const observed = capture();
    assert.equal(observed.diagnostics.boundary(boundary), true);
    assert.deepEqual(observed.records(), [{ type: 'BOUNDARY', boundary }]);
  });
}

for (const [offset, category] of materializer.MATERIALIZER_FAILURE_CATEGORIES.entries()) {
  test(`${String(offset + 12).padStart(2, '0')} emits bounded diagnostic ${category}`, () => {
    const observed = capture();
    observed.diagnostics.boundary('MATERIALIZER_MODULE_ENTERED');
    assert.equal(observed.diagnostics.diagnostic(category), true);
    assert.deepEqual(observed.records()[1], {
      type: 'DIAGNOSTIC',
      component: 'authorizedMigrationCatalogMaterializer',
      category,
      boundary: 'MATERIALIZER_MODULE_ENTERED',
    });
    assert.ok(source.indexOf(category) !== source.lastIndexOf(category));
  });
}

test('23 complete success sequence is exact and ordered', () => {
  const observed = capture();
  for (const boundary of materializer.MATERIALIZER_BOUNDARIES) observed.diagnostics.boundary(boundary);
  assert.deepEqual(observed.records().map((record) => record.boundary), materializer.MATERIALIZER_BOUNDARIES);
});

test('24 child diagnostic schema is closed and contains no arbitrary field', () => {
  const observed = capture();
  observed.diagnostics.boundary('MATERIALIZER_MODULE_ENTERED');
  observed.diagnostics.diagnostic('MATERIALIZER_SOURCE_CATALOG_UNAVAILABLE');
  assert.deepEqual(Object.keys(observed.records()[1]).sort(), ['boundary', 'category', 'component', 'type']);
});

test('25 unknown categories and duplicate diagnostics are rejected', () => {
  const observed = capture();
  observed.diagnostics.boundary('MATERIALIZER_MODULE_ENTERED');
  assert.equal(observed.diagnostics.diagnostic('UNKNOWN'), false);
  assert.equal(observed.diagnostics.diagnostic('MATERIALIZER_SOURCE_CATALOG_INVALID'), true);
  assert.equal(observed.diagnostics.diagnostic('MATERIALIZER_SOURCE_CATALOG_INVALID'), false);
});

test('26 diagnostic records contain no raw error, stack, cause, argv, env, or URL', () => {
  const observed = capture();
  observed.diagnostics.boundary('MATERIALIZER_MODULE_ENTERED');
  observed.diagnostics.diagnostic('MATERIALIZER_SOURCE_CATALOG_INVALID');
  const serialized = JSON.stringify(observed.records()[1]);
  assert.doesNotMatch(serialized, /error|stack|cause|argv|process\.env|database_url|postgresql:/i);
});

test('27 stdout and stderr are absent from the semantic diagnostic implementation', () => {
  const implementation = materializer.createMaterializerDiagnostics.toString();
  assert.doesNotMatch(implementation, /stdout|stderr|console|message|stack|cause/);
});

test('28 fd3 write failure does not throw or fabricate a category', () => {
  const diagnostics = materializer.createMaterializerDiagnostics(() => { throw new Error('secret'); });
  assert.equal(diagnostics.boundary('MATERIALIZER_MODULE_ENTERED'), false);
  assert.equal(diagnostics.diagnostic('MATERIALIZER_SOURCE_CATALOG_INVALID'), false);
});

test('29 functional exit semantics remain the original CLI catch assignment', () => {
  assert.match(source, /process\.exitCode = 1;/);
  assert.doesNotMatch(source, /process\.exit\(70\)|MATERIALIZER_RESERVED_EXIT/);
});

test('30 suite is synthetic and does not invoke materialization or database work', () => {
  assert.doesNotMatch(source, /dotenv/);
  assert.equal(materializer.AUTHORIZED_CATALOG_COUNT, 57);
  assert.equal(materializer.HISTORICAL_MIGRATIONS.length, 43);
  assert.equal(materializer.POST_CUTOFF_MIGRATIONS.length, 13);
});
