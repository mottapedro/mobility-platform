'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const dispatcher = require('../../scripts/gates/r7c-r13-operational-dispatcher.cjs');

const DATABASE_URL = 'postgresql://ephemeral:secret@127.0.0.1:54321/mobility';

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
      return {
        status: 0,
        error: null,
        stdout: [
          `AUTHORIZED_CATALOG_PATH=${path.join(outputDir, 'catalog')}`,
          'AUTHORIZED_CATALOG_COUNT=57',
          `AUTHORIZED_CATALOG_FINGERPRINT=${dispatcher.AUTHORIZED_CATALOG_FINGERPRINT}`,
        ].join('\n'),
      };
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
      return {
        status: 0,
        error: null,
        stdout: [
          `AUTHORIZED_CATALOG_PATH=${path.join(args[args.indexOf('--output-dir') + 1], 'catalog')}`,
          'AUTHORIZED_CATALOG_COUNT=56',
          `AUTHORIZED_CATALOG_FINGERPRINT=${dispatcher.AUTHORIZED_CATALOG_FINGERPRINT}`,
        ].join('\n'),
      };
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
  assert.equal(dispatcher.DIAGNOSTIC_EVENTS.length, 13);
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
