'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runCommand, persistStarting, evidencePath } = require('../../scripts/gates/diagnostic-process-runner.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-runner-'));
}

function childRequest(dir, overrides = {}) {
  return {
    runId: 'test-run',
    sequence: 1,
    commandId: 'command-1',
    executable: process.execPath,
    args: ['-e', "process.stdout.write('STDOUT_OK'); process.stderr.write('STDERR_OK'); process.exit(7)"],
    cwd: dir,
    ...overrides,
  };
}

async function execute(dir, overrides = {}) {
  return runCommand(childRequest(dir, overrides), dir);
}

test('T01_STDOUT_CAPTURE', async () => {
  const result = await execute(tempDir());
  assert.equal(result.stdout, 'STDOUT_OK');
});

test('T02_STDERR_CAPTURE', async () => {
  const result = await execute(tempDir());
  assert.equal(result.stderr, 'STDERR_OK');
});

test('T03_EXIT_CODE_CAPTURE', async () => {
  const result = await execute(tempDir());
  assert.equal(result.exitCode, 7);
  assert.equal(result.status, 'FAILED');
});

test('T04_MULTI_COMMAND_ORDER', async () => {
  const dir = tempDir();
  const results = await Promise.all([1, 2, 3].map((n) => execute(dir, {
    sequence: n,
    commandId: `command-${n}`,
    args: ['-e', `process.stdout.write('COMMAND_${n}')`],
  })));
  assert.deepEqual(results.map((result) => result.sequence), [1, 2, 3]);
});

test('T05_NO_FILE_COLLISION', async () => {
  const dir = tempDir();
  const results = await Promise.all([1, 2].map((n) => execute(dir, { sequence: n, commandId: `unique-${n}` })));
  assert.notEqual(results[0].evidenceFile, results[1].evidenceFile);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).length, 2);
});

test('T06_WRITE_BEFORE_EXECUTE', async () => {
  const dir = tempDir();
  const request = childRequest(dir);
  const originalSpawn = require('node:child_process').spawn;
  assert.equal(typeof originalSpawn, 'function');
  const persisted = persistStarting(request, dir);
  const first = JSON.parse(fs.readFileSync(persisted.file, 'utf8').split('\n')[0]);
  assert.equal(first.status, 'STARTING');
});

test('T07_FAILURE_EVIDENCE_SURVIVES_WRAPPER_ABORT', () => {
  const dir = tempDir();
  const request = childRequest(dir, { commandId: 'aborted-command' });
  const persisted = persistStarting(request, dir);
  const lines = fs.readFileSync(persisted.file, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  assert.equal(lines.length, 1);
  assert.equal(first.status, 'STARTING');
  assert.equal(first.commandId, 'aborted-command');
});

test('T08_ARGUMENT_VECTOR_PRESERVED', async () => {
  const result = await execute(tempDir(), { args: ['-e', 'process.stdout.write(process.argv[1])', '--', 'ARG_OK'] });
  assert.deepEqual(result.argumentVector, ['-e', 'process.stdout.write(process.argv[1])', '--', 'ARG_OK']);
});

test('T09_WORKING_DIRECTORY_PRESERVED', async () => {
  const dir = tempDir();
  const result = await execute(dir, { args: ['-e', 'process.stdout.write(process.cwd())'] });
  assert.equal(result.workingDirectory, dir);
  assert.equal(result.stdout, dir);
});

test('T10_SECRET_NOT_SERIALIZED', async () => {
  const dir = tempDir();
  const result = await execute(dir, { envAdditions: { SYNTHETIC_SECRET: 'DO_NOT_SERIALIZE' } });
  const evidence = fs.readFileSync(result.evidenceFile, 'utf8');
  assert.equal(evidence.includes('DO_NOT_SERIALIZE'), false);
  assert.equal(evidence.includes('SYNTHETIC_SECRET'), true);
});
