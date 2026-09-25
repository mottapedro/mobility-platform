'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function validateRequest(request) {
  for (const key of ['runId', 'sequence', 'commandId', 'executable', 'cwd']) {
    if (request[key] === undefined || request[key] === null || request[key] === '') {
      throw new TypeError(`Missing required field: ${key}`);
    }
  }
  if (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('args must be an array of strings');
  }
  if (request.envAdditions !== undefined && (request.envAdditions === null || typeof request.envAdditions !== 'object')) {
    throw new TypeError('envAdditions must be an object');
  }
}

function ensureEvidenceDir(evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

function evidencePath(evidenceDir, runId, sequence, commandId) {
  const safe = `${String(runId)}-${String(sequence).padStart(4, '0')}-${String(commandId)}`
    .replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(evidenceDir, `${safe}.jsonl`);
}

function writeDurably(file, record) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function safeEnvironmentMetadata(envAdditions) {
  return Object.keys(envAdditions || {}).sort().map((key) => key);
}

function createStartRecord(request) {
  return {
    runId: request.runId,
    sequence: request.sequence,
    commandId: request.commandId,
    executable: request.executable,
    argumentVector: [...request.args],
    workingDirectory: request.cwd,
    environmentKeys: safeEnvironmentMetadata(request.envAdditions),
    status: 'STARTING',
    startedAt: new Date().toISOString(),
  };
}

function persistStarting(request, evidenceDir) {
  validateRequest(request);
  ensureEvidenceDir(evidenceDir);
  const file = evidencePath(evidenceDir, request.runId, request.sequence, request.commandId);
  const record = createStartRecord(request);
  writeDurably(file, record);
  return { file, record };
}

function runCommand(request, evidenceDir) {
  validateRequest(request);
  const { file, record: startRecord } = persistStarting(request, evidenceDir);
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...(request.envAdditions || {}) },
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      const result = {
        ...startRecord,
        status: 'FAILED',
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        finishedAt: new Date().toISOString(),
      };
      writeDurably(file, result);
      reject(Object.assign(error, { evidence: result, evidenceFile: file }));
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      const result = {
        ...startRecord,
        status: exitCode === 0 ? 'COMPLETED' : 'FAILED',
        exitCode,
        signal: signal || null,
        stdout,
        stderr,
        finishedAt: new Date().toISOString(),
      };
      writeDurably(file, result);
      resolve({ ...result, evidenceFile: file });
    });
  });
}

module.exports = {
  createStartRecord,
  evidencePath,
  persistStarting,
  runCommand,
};
