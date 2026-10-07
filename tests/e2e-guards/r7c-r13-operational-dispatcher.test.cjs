'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const dispatcher = require('../../scripts/gates/r7c-r13-operational-dispatcher.cjs');

const DATABASE_URL = 'postgresql://ephemeral:secret@127.0.0.1:54321/mobility';
const CHILD_SUCCESS_FD3 = `${dispatcher.CHILD_MATERIALIZER_BOUNDARIES
  .map((boundary) => JSON.stringify({ type: 'BOUNDARY', boundary })).join('\n')}\n`;
const withChildFd3 = (result, fd3 = CHILD_SUCCESS_FD3) => ({
  ...result,
  output: [null, result.stdout || '', result.stderr || '', fd3],
});
const CHILD_SUCCESS_PARENT_EVENTS = [
  'CHILD_DIAGNOSTIC_SCHEMA_VALID',
  ...dispatcher.CHILD_MATERIALIZER_BOUNDARIES.map((boundary) => `CHILD_${boundary}`),
];

function materializerSpawn(extra = () => ({ status: 0, error: null }), onMaterializer = () => {}) {
  return (executable, args, options) => {
    if (args[1]?.endsWith('materialize-authorized-migration-catalog.ts')) {
      onMaterializer({ executable, args, options });
      const outputDir = args[args.indexOf('--output-dir') + 1];
      fs.mkdirSync(path.join(outputDir, 'catalog', dispatcher.BASELINE_MIGRATION), { recursive: true });
      fs.copyFileSync(
        path.join(__dirname, '..', '..', 'prisma', 'migrations', dispatcher.BASELINE_MIGRATION, 'migration.sql'),
        path.join(outputDir, 'catalog', dispatcher.BASELINE_MIGRATION, 'migration.sql'),
      );
      const stdout = [
        `AUTHORIZED_CATALOG_PATH=${path.join(outputDir, 'catalog')}`,
        'AUTHORIZED_CATALOG_COUNT=57',
        `AUTHORIZED_CATALOG_FINGERPRINT=${dispatcher.AUTHORIZED_CATALOG_FINGERPRINT}`,
      ].join('\n');
      return withChildFd3({
        status: 0,
        error: null,
        stdout,
        stderr: '',
      });
    }
    return extra(executable, args, options);
  };
}

function fakeClient(queryResult) {
  const calls = [];
  let connected = 0;
  let ended = 0;
  return {
    calls,
    get connected() { return connected; },
    get ended() { return ended; },
    client: {
      async connect() { connected += 1; },
      async query(sql) { calls.push(sql); return queryResult(sql); },
      async end() { ended += 1; },
    },
  };
}

test('dispatcher exposes exactly the five governed operation IDs', () => {
  assert.deepEqual(dispatcher.OPERATIONS, [
    'targetIdentity', 'emptyState', 'migrationTable', 'baseline', 'baselineLedger',
  ]);
});

test('command descriptors are internally fixed and immutable', () => {
  const commands = dispatcher.buildCommandSet();
  assert.deepEqual(Object.keys(commands), dispatcher.OPERATIONS);
  for (const operation of dispatcher.OPERATIONS) {
    assert.equal(commands[operation].executable, process.execPath);
    assert.deepEqual(commands[operation].args, [
      path.join(path.resolve(__dirname, '..', '..'), 'scripts', 'gates', 'r7c-r13-operational-dispatcher.cjs'),
      operation,
    ]);
    assert.equal(Object.isFrozen(commands[operation]), true);
    assert.equal(Object.isFrozen(commands[operation].args), true);
  }
  assert.equal(Object.isFrozen(commands), true);
});

test('missing or non-PostgreSQL URL is rejected before client construction', async () => {
  let created = 0;
  const deps = { env: {}, createClient() { created += 1; throw new Error('unexpected'); } };
  await assert.rejects(() => dispatcher.runOperation('targetIdentity', deps), /DATABASE_URL_REQUIRED/);
  await assert.rejects(() => dispatcher.runOperation('targetIdentity', {
    ...deps, env: { DATABASE_URL: 'https://example.invalid/mobility' },
  }), /DATABASE_URL_INVALID/);
  await assert.rejects(() => dispatcher.runOperation('targetIdentity', {
    ...deps, env: { DATABASE_URL: 'postgresql://user:secret@db.example.invalid:5432/mobility' },
  }), /NONLOCAL_ENDPOINT_REJECTED/);
  await assert.rejects(() => dispatcher.runOperation('targetIdentity', {
    ...deps, env: { DATABASE_URL: 'postgresql://user:secret@127.0.0.1:5432/mobility?host=db.example.invalid' },
  }), /DATABASE_URL_OVERRIDE_PARAMETER_REJECTED/);
  assert.equal(created, 0);
});

test('invalid operations fail before database client construction', async () => {
  let created = 0;
  await assert.rejects(() => dispatcher.runOperation('arbitrary', {
    env: { DATABASE_URL }, createClient() { created += 1; },
  }), /INVALID_OPERATION/);
  assert.equal(created, 0);
});

test('target identity requires PostgreSQL 15, mobility and a TCP endpoint', async () => {
  const fake = fakeClient(async () => ({ rows: [{
    database_name: 'mobility', server_version_num: 150008, server_address: '172.18.0.2', server_port: 5432,
  }] }));
  const result = await dispatcher.runOperation('targetIdentity', {
    env: { DATABASE_URL }, createClient: () => fake.client, spawnSync: materializerSpawn(),
  });
  assert.deepEqual(result, {
    databaseName: 'mobility', postgresMajor: 15, serverAddress: '172.18.0.2', serverPort: 5432,
  });
  assert.equal(fake.connected, 1);
  assert.equal(fake.ended, 1);

  await assert.rejects(() => dispatcher.runOperation('targetIdentity', {
    env: { DATABASE_URL }, spawnSync: materializerSpawn(), createClient: () => fakeClient(async () => ({ rows: [{
      database_name: 'mobility', server_version_num: 160000, server_address: '172.18.0.2', server_port: 5432,
    }] })).client,
  }), /POSTGRES_VERSION_MISMATCH/);
});

test('empty-state and migration-table operations emit only strict 0/1 facts', async () => {
  const empty = fakeClient(async () => ({ rows: [{ nonempty: 0 }] }));
  assert.equal(await dispatcher.runOperation('emptyState', {
    env: { DATABASE_URL }, createClient: () => empty.client, spawnSync: materializerSpawn(),
  }), '0');
  assert.match(empty.calls[0], /pg_namespace/);
  assert.match(empty.calls[0], /pg_class/);

  const ledger = fakeClient(async () => ({ rows: [{ present: 0 }] }));
  assert.equal(await dispatcher.runOperation('migrationTable', {
    env: { DATABASE_URL }, createClient: () => ledger.client, spawnSync: materializerSpawn(),
  }), '0');
  assert.match(ledger.calls[0], /public\._prisma_migrations/);
});

test('empty-state rejects unrecognized output and always closes the client', async () => {
  const fake = fakeClient(async () => ({ rows: [{ nonempty: null }] }));
  await assert.rejects(() => dispatcher.runOperation('emptyState', {
    env: { DATABASE_URL }, createClient: () => fake.client, spawnSync: materializerSpawn(),
  }), /EMPTY_STATE_RESULT_INVALID/);
  assert.equal(fake.ended, 1);
});

test('baseline is pinned to the authorized SQL bytes before connecting', async () => {
  const file = path.join(__dirname, '..', '..', 'prisma', 'migrations', dispatcher.BASELINE_MIGRATION, 'migration.sql');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(actual, dispatcher.BASELINE_SQL_SHA256);

  let queries = 0;
  const fake = fakeClient(async (sql) => { queries += 1; assert.equal(sql, fs.readFileSync(file, 'utf8')); return { rows: [] }; });
  const result = await dispatcher.runOperation('baseline', {
    env: { DATABASE_URL }, createClient: () => fake.client, spawnSync: materializerSpawn(),
  });
  assert.deepEqual(result, { baseline: dispatcher.BASELINE_MIGRATION, sha256: dispatcher.BASELINE_SQL_SHA256 });
  assert.equal(queries, 1);
  assert.equal(fake.ended, 1);
});

test('baseline ledger uses only the fixed Prisma resolve invocation', async () => {
  let invocation;
  let materializerInvocation;
  const result = await dispatcher.runOperation('baselineLedger', {
    env: {
      DATABASE_URL,
      NODE_OPTIONS: '--require unexpected.cjs',
      NODE_PATH: 'unexpected-modules',
      PGOPTIONS: '-c search_path=unexpected',
      PRISMA_SCHEMA_ENGINE_BINARY: 'unexpected-engine',
      PATH: 'preserved-path',
    },
    spawnSync: materializerSpawn((executable, args, options) => {
      invocation = { executable, args, options };
      return { status: 0, error: null };
    }, (call) => { materializerInvocation = call; }),
  });
  assert.deepEqual(result, { migration: dispatcher.BASELINE_MIGRATION, prismaVersion: '7.8.0' });
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args.slice(1), [
    'migrate', 'resolve', '--config',
    path.join(path.resolve(__dirname, '..', '..'), 'scripts', 'prisma.bootstrap.ts'),
    '--applied', dispatcher.BASELINE_MIGRATION,
  ]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.DATABASE_URL, DATABASE_URL);
  assert.equal(invocation.options.env.PATH, 'preserved-path');
  assert.equal(path.basename(invocation.options.env.PRISMA_MIGRATIONS_PATH), 'catalog');
  assert.equal(path.basename(path.dirname(invocation.options.env.PRISMA_MIGRATIONS_PATH)).startsWith('r7c-r13-authorized-catalog-'), true);
  assert.equal(invocation.options.env.NODE_OPTIONS, undefined);
  assert.equal(invocation.options.env.PGOPTIONS, undefined);
  assert.equal(invocation.options.env.PRISMA_SCHEMA_ENGINE_BINARY, undefined);
  assert.equal(materializerInvocation.executable, process.execPath);
  assert.deepEqual(materializerInvocation.args.slice(1), [
    path.join(path.resolve(__dirname, '..', '..'), 'scripts', 'materialize-authorized-migration-catalog.ts'),
    '--output-dir',
    materializerInvocation.args[materializerInvocation.args.indexOf('--output-dir') + 1],
    '--verify-fingerprint',
  ]);
  assert.equal(materializerInvocation.options.env.DATABASE_URL, undefined);
  assert.equal(materializerInvocation.options.shell, false);
});

test('baseline ledger reports only a sanitized failure code', async () => {
  await assert.rejects(() => dispatcher.runOperation('baselineLedger', {
    env: { DATABASE_URL },
    spawnSync: materializerSpawn(() => ({ status: 1, error: new Error(`failed for ${DATABASE_URL}`) })),
  }), /^Error: E: BASELINE_LEDGER_REGISTRATION_FAILED$/);
});

test('catalog materialization mismatch fails before any database client is created', async () => {
  let clientCreated = 0;
  let tempRemoved = false;
  await assert.rejects(() => dispatcher.runOperation('targetIdentity', {
    env: { DATABASE_URL },
    createClient() { clientCreated += 1; throw new Error('must not connect'); },
    spawnSync() { return { status: 1, error: new Error('catalog mismatch'), stdout: '', stderr: '' }; },
    rmSync(target, options) { tempRemoved = true; fs.rmSync(target, options); },
  }), /AUTHORIZED_CATALOG_MATERIALIZATION_FAILED/);
  assert.equal(clientCreated, 0);
  assert.equal(tempRemoved, true);
});

test('catalog count or fingerprint mismatch fails before client construction', async () => {
  let clientCreated = 0;
  await assert.rejects(() => dispatcher.runOperation('targetIdentity', {
    env: { DATABASE_URL },
    createClient() { clientCreated += 1; throw new Error('must not connect'); },
    spawnSync(executable, args) {
      if (!args[1]?.endsWith('materialize-authorized-migration-catalog.ts')) return { status: 0, error: null };
      return withChildFd3({
        status: 0,
        error: null,
        stdout: [
          `AUTHORIZED_CATALOG_PATH=${path.join(args[args.indexOf('--output-dir') + 1], 'catalog')}`,
          'AUTHORIZED_CATALOG_COUNT=56',
          `AUTHORIZED_CATALOG_FINGERPRINT=${dispatcher.AUTHORIZED_CATALOG_FINGERPRINT}`,
        ].join('\n'),
      });
    },
  }), /AUTHORIZED_CATALOG_IDENTITY_MISMATCH/);
  assert.equal(clientCreated, 0);
});

test('CLI accepts exactly one operation and never loads dotenv', async () => {
  await assert.rejects(() => dispatcher.main(['targetIdentity', 'extra'], { emitEvent: () => true }), /ONE_FIXED_OPERATION_REQUIRED/);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'gates', 'r7c-r13-operational-dispatcher.cjs'), 'utf8');
  assert.equal(/dotenv|execSync|execFileSync|shell\s*:\s*true/.test(source), false);
});

test('bounded diagnostic classifier preserves the generic protocol', () => {
  assert.deepEqual(dispatcher.classifyDispatchError({ name: 'error', code: '28P01', message: 'secret' }, 'targetIdentity'), {
    protocol: 'E: DISPATCH_OPERATION_FAILED', operation: 'targetIdentity', category: 'AUTHENTICATION_FAILURE', code: '28P01', syscall: 'UNKNOWN',
  });
  assert.equal(dispatcher.classifyDispatchError({ name: 'Error', code: 'ECONNREFUSED', message: 'postgresql://user:password@host' }, 'targetIdentity').category, 'CONNECTION_FAILURE');
  assert.equal(dispatcher.classifyDispatchError({ code: '3D000' }, 'targetIdentity').category, 'DATABASE_NOT_FOUND');
  assert.equal(dispatcher.classifyDispatchError({ code: 'ENOTFOUND' }, 'targetIdentity').category, 'NAME_RESOLUTION_FAILURE');
  assert.equal(dispatcher.classifyDispatchError({ code: 'CERT_HAS_EXPIRED', message: 'password=secret' }, 'targetIdentity').category, 'TLS_TRANSPORT_FAILURE');
  assert.equal(dispatcher.classifyDispatchError(new Error('DATABASE_URL=postgresql://x:secret@host'), 'targetIdentity').category, 'UNKNOWN');
});

test('diagnostic classifier emits no raw error fields', () => {
  const error = Object.assign(new Error('DATABASE_URL=postgresql://user:password@host'), {
    code: 'ECONNREFUSED',
    syscall: 'connect',
    stack: 'SECRET_STACK',
    connectionString: 'SECRET_CONNECTION_STRING',
    cause: { password: 'SECRET_PASSWORD' },
  });
  const serialized = JSON.stringify(dispatcher.classifyDispatchError(error, 'targetIdentity'));
  assert.doesNotMatch(serialized, /DATABASE_URL|password|SECRET_|connectionString|stack|cause|postgresql:/i);
  assert.match(serialized, /DISPATCH_OPERATION_FAILED/);
});

test('successful dispatcher output contract remains unchanged', () => {
  assert.deepEqual(dispatcher.classifyDispatchError({ code: '42P01' }, 'targetIdentity').category, 'QUERY_FAILURE');
  assert.deepEqual(dispatcher.DIAGNOSTIC_CATEGORIES, [
    'AUTHENTICATION_FAILURE', 'CONNECTION_FAILURE', 'DATABASE_NOT_FOUND',
    'NAME_RESOLUTION_FAILURE', 'TLS_TRANSPORT_FAILURE', 'QUERY_FAILURE',
    'MODULE_RUNTIME_FAILURE', 'UNKNOWN',
  ]);
});

test('diagnostic event vocabulary is closed and fixed', () => {
  assert.equal(dispatcher.DIAGNOSTIC_EVENTS.length, 46);
  assert.deepEqual(dispatcher.DIAGNOSTIC_EVENTS.slice(0, 13), [
    'DISPATCHER_MODULE_LOADED', 'DISPATCHER_MAIN_ENTERED', 'TARGETIDENTITY_ENTERED',
    'PG_CLIENT_CONSTRUCTION_REACHED', 'PG_CONNECT_ATTEMPTED', 'PG_CONNECT_SUCCEEDED',
    'TARGETIDENTITY_QUERY_ATTEMPTED', 'TARGETIDENTITY_QUERY_SUCCEEDED', 'MAIN_CATCH_ENTERED',
    'GENERIC_PROTOCOL_EMISSION_ATTEMPTED', 'GENERIC_PROTOCOL_EMISSION_COMPLETED',
    'BOUNDED_DIAGNOSTIC_EMISSION_ATTEMPTED', 'BOUNDED_DIAGNOSTIC_EMISSION_COMPLETED',
  ]);
  assert.equal(dispatcher.emitBoundaryEvent('ARBITRARY_EVENT', () => { throw new Error('must not write'); }), false);
  const writes = [];
  assert.equal(dispatcher.emitBoundaryEvent('DISPATCHER_MODULE_LOADED', (_fd, bytes) => writes.push(bytes)), true);
  assert.deepEqual(writes[0], Buffer.from('{"event":"DISPATCHER_MODULE_LOADED"}\n'));
});

test('fd3 failure has a reserved exit classification', () => {
  const previous = process.exitCode;
  process.exitCode = undefined;
  assert.equal(dispatcher.emitBoundaryEvent('DISPATCHER_MAIN_ENTERED', () => { throw new Error('secret'); }), false);
  assert.equal(process.exitCode, dispatcher.FD3_FAILURE_EXIT_CODE);
  process.exitCode = previous;
});

test('target identity boundary order distinguishes connection and query success', async () => {
  const events = [];
  const client = { connect: async () => {}, end: async () => {}, query: async () => ({ rows: [{ database_name: 'mobility', server_version_num: 150000, server_address: '127.0.0.1', server_port: 5432 }] }) };
  const result = await dispatcher.runOperation('targetIdentity', { env: { DATABASE_URL }, createClient: () => client, spawnSync: materializerSpawn(), emitEvent: (event) => { events.push(event); return true; } });
  assert.equal(result.databaseName, 'mobility');
  assert.deepEqual(events.slice(-6), ['PG_CLIENT_CONSTRUCTION_REACHED', 'PG_CONNECT_ATTEMPTED', 'PG_CONNECT_SUCCEEDED', 'TARGETIDENTITY_ENTERED', 'TARGETIDENTITY_QUERY_ATTEMPTED', 'TARGETIDENTITY_QUERY_SUCCEEDED']);
});

const MATERIALIZER_EVENTS = [
  'AUTHORIZED_CATALOG_MATERIALIZATION_ENTERED',
  'MATERIALIZER_PROCESS_CREATE_ATTEMPTED',
  'MATERIALIZER_PROCESS_CREATED',
  'MATERIALIZER_PROCESS_COMPLETED',
  'MATERIALIZER_OUTPUT_VALIDATION_ENTERED',
  'MATERIALIZER_OUTPUT_VALIDATED',
  'AUTHORIZED_CATALOG_IDENTITY_VERIFICATION_ENTERED',
  'AUTHORIZED_CATALOG_IDENTITY_VERIFIED',
  'AUTHORIZED_CATALOG_MATERIALIZATION_COMPLETED',
];

async function materializerFailure(spawnResult, expectedCategory, expectedEvents, overrides = {}) {
  const events = [];
  let caught;
  try {
    await dispatcher.runOperation('targetIdentity', {
      env: { DATABASE_URL },
      spawnSync: typeof spawnResult === 'function' ? spawnResult : () => spawnResult,
      createClient() { throw new Error('database must not be reached'); },
      emitEvent(event) { events.push(event); return true; },
      ...overrides,
    });
  } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.materializerDiagnostic.category, expectedCategory);
  assert.deepEqual(events, expectedEvents);
  return caught;
}

test('materializer diagnostic taxonomy and event extension are closed', () => {
  assert.deepEqual(dispatcher.MATERIALIZER_FAILURE_CATEGORIES, [
    'MATERIALIZER_TEMP_ROOT_FAILURE', 'MATERIALIZER_PROCESS_CREATION_FAILED',
    'MATERIALIZER_NONZERO_EXIT', 'MATERIALIZER_SIGNALLED', 'MATERIALIZER_OUTPUT_MISSING',
    'MATERIALIZER_OUTPUT_INVALID', 'MATERIALIZER_CATALOG_COUNT_MISMATCH',
    'MATERIALIZER_CATALOG_IDENTITY_MISMATCH', 'MATERIALIZER_CLEANUP_FAILURE',
  ]);
  assert.deepEqual(dispatcher.DIAGNOSTIC_EVENTS.slice(13, 22), MATERIALIZER_EVENTS);
});

test('child materializer fd3 is created and valid boundaries are projected', async () => {
  let options;
  const events = [];
  const spawn = materializerSpawn(() => ({ status: 0, error: null }), (call) => { options = call.options; });
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'r13-f13-fd3-'));
  try {
    await dispatcher.runOperation('targetIdentity', {
      env: { DATABASE_URL }, spawnSync: spawn,
      createClient: () => fakeClient(async () => ({ rows: [{ database_name: 'mobility', server_version_num: 150000, server_address: '127.0.0.1', server_port: 5432 }] })).client,
      emitEvent(event) { events.push(event); return true; }, tmpDir: () => root,
    });
  } catch {}
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'pipe']);
  assert.ok(events.includes('CHILD_DIAGNOSTIC_SCHEMA_VALID'));
  assert.ok(events.includes('CHILD_MATERIALIZER_MODULE_ENTERED'));
});

test('child protocol accepts one bounded diagnostic and projects only fixed facts', () => {
  const raw = [
    { type: 'BOUNDARY', boundary: 'MATERIALIZER_MODULE_ENTERED' },
    { type: 'DIAGNOSTIC', component: dispatcher.CHILD_MATERIALIZER_COMPONENT, category: 'MATERIALIZER_SOURCE_CATALOG_UNAVAILABLE', boundary: 'MATERIALIZER_MODULE_ENTERED' },
  ].map(JSON.stringify).join('\n') + '\n';
  const protocol = dispatcher.parseChildMaterializerProtocol(raw);
  const events = [];
  dispatcher.projectChildMaterializerProtocol(protocol, (event) => { events.push(event); return true; });
  assert.equal(protocol.diagnostic.category, 'MATERIALIZER_SOURCE_CATALOG_UNAVAILABLE');
  assert.deepEqual(events, [
    'CHILD_DIAGNOSTIC_SCHEMA_VALID', 'CHILD_MATERIALIZER_MODULE_ENTERED',
    'CHILD_DIAGNOSTIC_PRESENT', 'CHILD_DIAGNOSTIC_CATEGORY_VALID',
    'CHILD_MATERIALIZER_SOURCE_CATALOG_UNAVAILABLE',
  ]);
});

test('child protocol rejects schema, vocabulary, component, extras, multiplicity, and ordering violations', () => {
  const parse = (records) => dispatcher.parseChildMaterializerProtocol(`${records.map(JSON.stringify).join('\n')}\n`);
  assert.throws(() => parse([{ type: 'UNKNOWN', boundary: 'MATERIALIZER_MODULE_ENTERED' }]), /CHILD_PROTOCOL_INVALID/);
  assert.throws(() => parse([{ type: 'BOUNDARY', boundary: 'UNKNOWN' }]), /CHILD_PROTOCOL_INVALID/);
  assert.throws(() => parse([{ type: 'BOUNDARY', boundary: 'MATERIALIZER_CLI_ENTERED' }]), /CHILD_PROTOCOL_INVALID/);
  assert.throws(() => parse([{ type: 'BOUNDARY', boundary: 'MATERIALIZER_MODULE_ENTERED', extra: true }]), /CHILD_PROTOCOL_INVALID/);
  const first = { type: 'BOUNDARY', boundary: 'MATERIALIZER_MODULE_ENTERED' };
  const diagnostic = { type: 'DIAGNOSTIC', component: dispatcher.CHILD_MATERIALIZER_COMPONENT, category: 'MATERIALIZER_SOURCE_CATALOG_UNAVAILABLE', boundary: 'MATERIALIZER_MODULE_ENTERED' };
  assert.throws(() => parse([first, { ...diagnostic, component: 'wrong' }]), /CHILD_PROTOCOL_INVALID/);
  assert.throws(() => parse([first, { ...diagnostic, category: 'UNKNOWN' }]), /CHILD_PROTOCOL_INVALID/);
  assert.throws(() => parse([first, { ...diagnostic, extra: true }]), /CHILD_PROTOCOL_INVALID/);
  assert.throws(() => parse([first, diagnostic, diagnostic]), /CHILD_PROTOCOL_INVALID/);
});

test('nonzero exit without child diagnostic remains observable and ignores stdout/stderr semantics', async () => {
  const raw = `${JSON.stringify({ type: 'BOUNDARY', boundary: 'MATERIALIZER_MODULE_ENTERED' })}\n`;
  const error = await materializerFailure(
    { error: null, status: 1, signal: null, stdout: 'MATERIALIZER_FINGERPRINT_MISMATCH', stderr: 'MATERIALIZER_SOURCE_CATALOG_INVALID', output: [null, 'ignored', 'ignored', raw] },
    'MATERIALIZER_NONZERO_EXIT',
    [...MATERIALIZER_EVENTS.slice(0, 4), 'CHILD_DIAGNOSTIC_SCHEMA_VALID', 'CHILD_MATERIALIZER_MODULE_ENTERED'],
  );
  assert.equal(error.materializerDiagnostic.exitCode, 1);
});

test('materializer process creation failure is bounded before creation success', async () => {
  const error = await materializerFailure(
    { error: new Error(`secret ${DATABASE_URL}`), status: null, signal: null },
    'MATERIALIZER_PROCESS_CREATION_FAILED',
    MATERIALIZER_EVENTS.slice(0, 2),
  );
  assert.deepEqual(error.materializerDiagnostic, {
    operation: 'authorizedCatalogMaterialization', category: 'MATERIALIZER_PROCESS_CREATION_FAILED',
    processCreated: false, exitCode: null, signal: null,
  });
  assert.doesNotMatch(JSON.stringify(error.materializerDiagnostic), /secret|postgresql:|DATABASE_URL/i);
});

test('materializer nonzero exit and signal are distinct bounded failures', async () => {
  const completed = [...MATERIALIZER_EVENTS.slice(0, 4), 'CHILD_DIAGNOSTIC_SCHEMA_VALID'];
  const nonzero = await materializerFailure(
    { error: null, status: 9, signal: null, stdout: '', stderr: 'secret' },
    'MATERIALIZER_NONZERO_EXIT', completed,
  );
  assert.equal(nonzero.materializerDiagnostic.processCreated, true);
  assert.equal(nonzero.materializerDiagnostic.exitCode, 9);
  const signalled = await materializerFailure(
    { error: null, status: null, signal: 'SIGTERM', stdout: '', stderr: 'secret' },
    'MATERIALIZER_SIGNALLED', completed,
  );
  assert.equal(signalled.materializerDiagnostic.signal, 'SIGTERM');
});

test('output validation distinguishes missing and malformed output', async () => {
  const entered = [...MATERIALIZER_EVENTS.slice(0, 4), ...CHILD_SUCCESS_PARENT_EVENTS, MATERIALIZER_EVENTS[4]];
  await materializerFailure(
    withChildFd3({ error: null, status: 0, signal: null, stdout: '', stderr: '' }),
    'MATERIALIZER_OUTPUT_MISSING', entered,
  );
  await materializerFailure(
    withChildFd3({
      error: null, status: 0, signal: null, stderr: '',
      stdout: 'AUTHORIZED_CATALOG_PATH=x\nAUTHORIZED_CATALOG_PATH=y\nAUTHORIZED_CATALOG_COUNT=57\nAUTHORIZED_CATALOG_FINGERPRINT=x',
    }),
    'MATERIALIZER_OUTPUT_INVALID', entered,
  );
});

test('identity validation distinguishes count and catalog identity mismatch', async () => {
  const identityEntered = [...MATERIALIZER_EVENTS.slice(0, 4), ...CHILD_SUCCESS_PARENT_EVENTS, ...MATERIALIZER_EVENTS.slice(4, 7)];
  await materializerFailure(
    (executable, args, options) => {
      const result = materializerSpawn()(executable, args, options);
      return { ...result, stdout: result.stdout.replace('AUTHORIZED_CATALOG_COUNT=57', 'AUTHORIZED_CATALOG_COUNT=56') };
    },
    'MATERIALIZER_CATALOG_COUNT_MISMATCH', identityEntered,
  );
  await materializerFailure(
    (executable, args, options) => {
      const result = materializerSpawn()(executable, args, options);
      return { ...result, stdout: result.stdout.replace(dispatcher.AUTHORIZED_CATALOG_FINGERPRINT, '0'.repeat(64)) };
    },
    'MATERIALIZER_CATALOG_IDENTITY_MISMATCH', identityEntered,
  );
});

test('full materialization emits all boundaries before database construction', async () => {
  const events = [];
  const fake = fakeClient(async () => ({ rows: [{
    database_name: 'mobility', server_version_num: 150000, server_address: '127.0.0.1', server_port: 5432,
  }] }));
  await dispatcher.runOperation('targetIdentity', {
    env: { DATABASE_URL }, createClient: () => fake.client,
    spawnSync: materializerSpawn(), emitEvent(event) { events.push(event); return true; },
  });
  assert.deepEqual(events.slice(0, 4), MATERIALIZER_EVENTS.slice(0, 4));
  assert.deepEqual(events.slice(4, 4 + CHILD_SUCCESS_PARENT_EVENTS.length), CHILD_SUCCESS_PARENT_EVENTS);
  assert.deepEqual(events.slice(4 + CHILD_SUCCESS_PARENT_EVENTS.length, 9 + CHILD_SUCCESS_PARENT_EVENTS.length), MATERIALIZER_EVENTS.slice(4));
  assert.equal(events[9 + CHILD_SUCCESS_PARENT_EVENTS.length], 'PG_CLIENT_CONSTRUCTION_REACHED');
});

test('cleanup failure preserves an established primary materializer diagnostic', async () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'r13-f11-cleanup-'));
  let caught;
  try {
    await dispatcher.runOperation('targetIdentity', {
      env: { DATABASE_URL }, tmpDir: () => root,
      spawnSync: () => ({ error: null, status: 7, signal: null, stdout: '', stderr: 'secret' }),
      rmSync() { throw new Error('cleanup secret'); },
      emitEvent: () => true,
    });
  } catch (error) { caught = error; }
  fs.rmSync(root, { recursive: true, force: true });
  assert.match(caught.message, /TEMP_CLEANUP_FAILED_AFTER_OPERATION_FAILURE/);
  assert.equal(caught.materializerDiagnostic.category, 'MATERIALIZER_NONZERO_EXIT');
  assert.equal(caught.materializerDiagnostic.exitCode, 7);
});

test('cleanup-only and temporary-root failures are bounded', async () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'r13-f11-cleanup-only-'));
  let cleanupError;
  try {
    await dispatcher.runOperation('targetIdentity', {
      env: { DATABASE_URL }, tmpDir: () => root, spawnSync: materializerSpawn(),
      createClient: () => fakeClient(async () => ({ rows: [{ database_name: 'mobility', server_version_num: 150000, server_address: '127.0.0.1', server_port: 5432 }] })).client,
      rmSync() { throw new Error('cleanup secret'); }, emitEvent: () => true,
    });
  } catch (error) { cleanupError = error; }
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(cleanupError.materializerDiagnostic.category, 'MATERIALIZER_CLEANUP_FAILURE');

  let tempError;
  try {
    await dispatcher.runOperation('targetIdentity', {
      env: { DATABASE_URL }, tmpDir: () => path.resolve(__dirname, '..', '..'), emitEvent: () => true,
    });
  } catch (error) { tempError = error; }
  assert.equal(tempError.materializerDiagnostic.category, 'MATERIALIZER_TEMP_ROOT_FAILURE');
});
