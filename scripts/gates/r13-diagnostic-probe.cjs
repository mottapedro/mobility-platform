'use strict';

const fs = require('node:fs');
const preloaderWrapper = require('./r13-preloader-wrapper.cjs');

function main() {
  const nonce = process.env.R13_PRELOADER_NONCE || (() => {
    const idx = process.argv.indexOf('--nonce');
    return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : 'diagnostic-probe-nonce';
  })();

  const diagnostics = preloaderWrapper.createPreloaderDiagnostics(fs.writeSync, nonce);

  // Phase 1: Wrapper entered
  diagnostics.boundary('PRELOADER_WRAPPER_ENTERED', {
    pid: process.pid,
    ppid: process.ppid,
  });

  // Phase 2: Process identity established
  diagnostics.boundary('PRELOADER_IDENTITY_ESTABLISHED', {
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    nodeVersion: process.version,
    platform: process.platform,
  });

  // Phase 3: Channels established (validate fd4 and test fd3)
  try {
    fs.fstatSync(3);
    diagnostics.boundary('PRELOADER_CHANNELS_ESTABLISHED');
  } catch (error) {
    diagnostics.diagnostic('C03', {
      reason: error.code || 'FD3_UNAVAILABLE',
    });
    process.exit(70);
  }

  // Phase 4: Loader initialization (pure CJS probe, no tsx compiler needed)
  diagnostics.boundary('PRELOADER_LOADER_INITIALIZATION_STARTED');
  diagnostics.boundary('PRELOADER_LOADER_INITIALIZATION_COMPLETED');

  // Phase 5: Target execution
  diagnostics.boundary('PRELOADER_TARGET_EXECUTION_ENTERED');

  // Emit diagnostic probe boundaries to fd3
  try {
    fs.writeSync(3, Buffer.from(JSON.stringify({ type: 'BOUNDARY', boundary: 'DIAGNOSTIC_PROBE_ENTERED' }) + '\n'));
    fs.writeSync(3, Buffer.from(JSON.stringify({ type: 'BOUNDARY', boundary: 'DIAGNOSTIC_PROBE_COMPLETED' }) + '\n'));
  } catch {
    // fd3 write failed
  }

  diagnostics.boundary('PRELOADER_TARGET_EXECUTION_COMPLETED');

  process.stdout.write('DIAGNOSTIC_PROBE_OK\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { main };
