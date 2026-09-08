'use strict';

const { Client } = require('pg');

function output(name, value) {
  console.log(`${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, `${name.toLowerCase()}=${value}\n`);
}

function parseExecutionResult(argv) {
  const index = argv.indexOf('--execution-result');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('EXECUTION_RESULT_VALUE_REQUIRED');
  return value;
}

function evaluateMode({ mode, executionResult, stateName }) {
  if (mode === '--require-e0') {
    if (stateName === 'E0') {
      return { writeEligible: 'YES', humanInspectionRequired: 'NO', governedFinal: 'NOT_APPLICABLE', exitCode: 0 };
    }
    return { writeEligible: 'NO', humanInspectionRequired: 'YES', governedFinal: 'NO', exitCode: 1 };
  }

  if (mode === '--post-write' || mode === '--require-final') {
    if (executionResult === undefined) {
      return { writeEligible: 'NO', humanInspectionRequired: 'YES', governedFinal: 'NO', exitCode: 1 };
    }
    if (executionResult !== 'success') {
      return { writeEligible: 'NO', humanInspectionRequired: 'YES', governedFinal: 'NO', exitCode: 1 };
    }
    if (mode === '--require-final' && stateName === 'FINAL') {
      return { writeEligible: 'NO', humanInspectionRequired: 'NO', governedFinal: 'YES', exitCode: 0 };
    }
    if (mode === '--post-write' && stateName === 'FINAL') {
      return { writeEligible: 'NO', humanInspectionRequired: 'NO', governedFinal: 'YES', exitCode: 0 };
    }
    return { writeEligible: 'NO', humanInspectionRequired: 'YES', governedFinal: 'NO', exitCode: 1 };
  }

  return { writeEligible: 'NO', humanInspectionRequired: 'YES', governedFinal: 'NO', exitCode: 1 };
}

module.exports = { evaluateMode, parseExecutionResult };

const mode = process.argv[2];
let executionResult;
try {
  executionResult = parseExecutionResult(process.argv);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { ca: process.env.E2E_CA_CERT, rejectUnauthorized: true } });

if (require.main === module && process.exitCode !== 1) (async () => {
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const { rows: [state] } = await client.query(`SELECT
      current_database() AS database,
      current_setting('server_version_num')::int AS version_num,
      current_setting('transaction_read_only') AS read_only,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f','i','I')) AS relations,
      (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e') AS enums,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AS routines,
      to_regclass('public._prisma_migrations')::text AS migrations`);
    const e0 = state.database === 'postgres' && Math.floor(state.version_num / 10000) === 17 && state.read_only === 'on'
      && state.relations === 0 && state.enums === 0 && state.routines === 0 && state.migrations === null;
    const stateName = mode === '--require-e0' ? (e0 ? 'E0' : 'UNKNOWN') : (state.migrations ? 'FINAL' : 'UNKNOWN');
    output('state', stateName);
    const decision = evaluateMode({ mode, executionResult, stateName });
    output('write_eligible', decision.writeEligible);
    output('governed_final', decision.governedFinal);
    output('human_inspection_required', decision.humanInspectionRequired);
    process.exitCode = decision.exitCode;
    await client.query('ROLLBACK');
  } catch (error) {
    output('state', 'UNKNOWN'); output('governed_final', 'NO'); output('human_inspection_required', 'YES'); process.exitCode = 1;
  } finally { await client.end().catch(() => {}); }
})();
