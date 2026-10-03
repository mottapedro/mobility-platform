'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { __test } = require('../../scripts/gates/r13-targetidentity-capture.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-f6i-'));
const node = process.execPath;
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function run(code, name, expectedCode = 0) {
  const dir = path.join(root, name);
  const result = await __test.captureChild({ executable: node, args: ['-e', code], env: { DATABASE_URL: 'postgresql://secret:password@localhost/mobility' }, evidenceRoot: dir });
  const out = fs.readFileSync(path.join(dir, 'stdout.bin')); const err = fs.readFileSync(path.join(dir, 'stderr.bin')); const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'execution-manifest.json')));
  assert.equal(result.evidenceState, 'EVIDENCE_COMPLETE'); assert.equal(manifest.stdoutByteCount, out.length); assert.equal(manifest.stderrByteCount, err.length); assert.equal(manifest.stdoutSha256, hash(out)); assert.equal(manifest.stderrSha256, hash(err)); assert.equal(manifest.exitCode, expectedCode); assert.equal(manifest.databaseUrlPresent, true); assert.equal(JSON.stringify(manifest).includes('password'), false); return { out, err, manifest };
}

(async () => {
  const both = await run("process.stdout.write('OUT'); process.stderr.write('ERR')", 'both'); assert.deepEqual(both.out, Buffer.from('OUT')); assert.deepEqual(both.err, Buffer.from('ERR'));
  const empty = await run('', 'empty'); assert.equal(empty.out.length, 0); assert.equal(empty.err.length, 0);
  const nonzero = await run("process.stdout.write('x'); process.exit(7)", 'nonzero', 7); assert.equal(nonzero.manifest.processCreated, true);
  const failed = await __test.captureChild({ executable: path.join(root, 'missing-executable'), args: [], env: {}, evidenceRoot: path.join(root, 'creation-failure') }); assert.equal(failed.processCreated, false); assert.equal(failed.exitCode, null); assert.equal(failed.evidenceState, 'EVIDENCE_COMPLETE');
  assert.throws(() => require('../../scripts/gates/r13-targetidentity-capture.cjs').captureTargetIdentity({ executable: 'x' }), /CLOSED_CAPTURE_INTERFACE/);
  fs.rmSync(root, { recursive: true, force: true }); console.log('21 passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
