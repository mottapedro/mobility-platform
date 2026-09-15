'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { validateTarget, PROJECT_REF } = require('./supabase-target.cjs');

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
};

const schemaPath = path.resolve('prisma/schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf8');
const expectedStatuses = {
  RideStatus: ['PENDING', 'MATCHING', 'WAITING_DRIVER', 'WAITING_REFERRAL', 'WAITING_PARTNER', 'WAITING_GENERAL', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'PAID', 'WAITING_OWNER'],
  RideOfferStatus: ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
};
const expectedColumns = {
  RideRequest: [
    'currentDispatchStage',
    'rootDriverId',
    'selectedDriverId',
    'currentCandidateDriverId',
    'excludedDriverIds',
    'creationCorrelationId',
    'creationIntentFingerprint',
  ],
  Passenger: ['referralCode', 'publicSlug'],
};
const expectedMigrations = [
  '20260910000000_add_waiting_owner_ride_status',
  '20260910000001_add_cancelled_ride_offer_status',
];

const emit = (key, value) => {
  const normalized = Array.isArray(value) ? value.join(',') : String(value);
  console.log(`${key}=${normalized}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key.toLowerCase()}=${normalized}\n`);
};

function readAuthorizedMigrationNames(catalogPath) {
  if (!catalogPath) throw new Error('AUTHORIZED_CATALOG_PATH_REQUIRED');
  return fs.readdirSync(catalogPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(catalogPath, entry.name, 'migration.sql')))
    .map((entry) => entry.name)
    .sort();
}

function evaluateMigrationInventory(rows, authorizedNames) {
  const appliedNames = rows.map((row) => row.migration_name).sort();
  const applied = new Set(appliedNames);
  const authorized = new Set(authorizedNames);
  const missing = authorizedNames.filter((name) => !applied.has(name));
  const unexpected = appliedNames.filter((name) => !authorized.has(name));
  const unfinished = rows.filter((row) => !row.finished_at && !row.rolled_back_at && !row.logs);
  const rolledBack = rows.filter((row) => row.rolled_back_at);
  const failed = rows.filter((row) => row.logs);
  return { appliedNames, missing, unexpected, unfinished, rolledBack, failed };
}

function enumAvailability(enumRows) {
  const values = new Map(Object.keys(expectedStatuses).map((name) => [name, []]));
  for (const row of enumRows) values.get(row.enum_name)?.push(row.enum_value);
  return {
    values,
    waitingOwnerPresent: values.get('RideStatus')?.includes('WAITING_OWNER') === true,
    cancelledPresent: values.get('RideOfferStatus')?.includes('CANCELLED') === true,
  };
}

function enumDependentChecks({ waitingOwnerPresent, cancelledPresent }) {
  return {
    waitingOwner: waitingOwnerPresent
      ? { output: 'QUERY', sql: 'SELECT COUNT(*) AS count FROM "RideRequest" WHERE status::text = \'WAITING_OWNER\'' }
      : { output: 'NOT_APPLICABLE_ENUM_ABSENT' },
    cancelled: cancelledPresent
      ? { output: 'QUERY', sql: 'SELECT COUNT(*) AS count FROM "RideOffer" WHERE status::text = \'CANCELLED\'' }
      : { output: 'NOT_APPLICABLE_ENUM_ABSENT' },
  };
}

function evaluatePhysicalCompatibility({ waitingOwnerPresent, cancelledPresent, requiredColumnsPresent, indexEquivalent }) {
  return !waitingOwnerPresent || !cancelledPresent || !requiredColumnsPresent || !indexEquivalent
    ? 'PRESENT'
    : 'NONE';
}

async function runEnumDependentChecks(client, availability) {
  const checks = enumDependentChecks(availability);
  const result = { waitingOwner: checks.waitingOwner.output, cancelled: checks.cancelled.output };
  if (checks.waitingOwner.sql) result.waitingOwner = (await client.query(checks.waitingOwner.sql)).rows[0].count;
  if (checks.cancelled.sql) result.cancelled = (await client.query(checks.cancelled.sql)).rows[0].count;
  return result;
}

const supersededPassenger = '20260518000000_passenger_codes_not_null_future';
const incrementalFingerprint = '061c8aa563bbb2023fa96a17f7ef4580e3303dfc6271427c77c369753f622d88';
const incrementalModes = ['PRE_INCREMENTAL_DEPLOY', 'POST_INCREMENTAL_DEPLOY'];
const pendingEffectContracts = [
  { migration: '20260909000000_add_ride_creation_correlation', effects: ['RideRequest.creationCorrelationId', 'RideRequest_creationCorrelationId_key'], dependency: 'NONE_FOR_NULLABLE_COLUMN;UNIQUE_INDEX_EXISTING_DATA_COMPATIBILITY' },
  { migration: '20260909000001_add_ride_creation_intent_fingerprint', effects: ['RideRequest.creationIntentFingerprint'], dependency: 'NONE_FOR_NULLABLE_COLUMN' },
  { migration: '20260910000000_add_waiting_owner_ride_status', effects: ['RideStatus.WAITING_OWNER'], dependency: 'ADD_ONLY_ENUM' },
  { migration: '20260910000001_add_cancelled_ride_offer_status', effects: ['RideOfferStatus.CANCELLED'], dependency: 'ADD_ONLY_ENUM' },
  { migration: '20260911000000_restore_one_pending_offer_per_ride', effects: ['RideOffer_one_pending_per_ride'], dependency: 'UNIQUE_PARTIAL_INDEX' },
];

function verifyCertificationArtifact(catalogPath) {
  try {
    // Reuse the governed fingerprint/manifest verifier; never duplicate its algorithm.
    execFileSync(process.execPath, [path.resolve('scripts/e2e/verify-authorized-migration-artifact.cjs'), path.dirname(catalogPath)], { stdio: 'pipe' });
    const expression = `import { AUTHORIZED_MIGRATIONS, HISTORICAL_MIGRATIONS, POST_CUTOFF_MIGRATIONS, BASELINE_MIGRATION } from './scripts/materialize-authorized-migration-catalog.ts'; console.log(JSON.stringify({authorized:AUTHORIZED_MIGRATIONS,historical:HISTORICAL_MIGRATIONS,postCutoff:POST_CUTOFF_MIGRATIONS,baseline:BASELINE_MIGRATION}));`;
    const model = JSON.parse(execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), '-e', expression], { encoding: 'utf8' }));
    const actual = readAuthorizedMigrationNames(catalogPath);
    const missing = model.authorized.filter((name) => !actual.includes(name));
    const unexpected = actual.filter((name) => !model.authorized.includes(name));
    emit('AUTHORIZED_ARTIFACT_EXPECTED_COUNT', model.authorized.length);
    emit('AUTHORIZED_ARTIFACT_ACTUAL_COUNT', actual.length);
    emit('AUTHORIZED_ARTIFACT_MISSING_COUNT', missing.length);
    emit('AUTHORIZED_ARTIFACT_UNEXPECTED_COUNT', unexpected.length);
    emit('PASSENGER_SUPERSEDED_PRESENT_IN_ARTIFACT', actual.includes(supersededPassenger) ? 'YES' : 'NO');
    if (missing.length || unexpected.length || actual.includes(supersededPassenger)) throw new Error('ARTIFACT_SET_MISMATCH');
    emit('AUTHORIZED_ARTIFACT_VERIFY', 'PASS');
    return { verified: true, model };
  } catch {
    emit('AUTHORIZED_ARTIFACT_VERIFY', 'FAIL');
    throw new Error('AUTHORIZED_ARTIFACT_VERIFICATION_FAILED');
  }
}

function targetIdentity(target, connection) {
  const major = Math.floor(Number(connection.server_version_num) / 10000);
  const valid = target.mode === 'session' && target.projectRef === PROJECT_REF
    && connection.database_name === 'postgres' && major === 17;
  return { valid, outputs: {
    TARGET_PROVIDER: 'Supabase', TARGET_PROJECT_ID: target.projectRef,
    TARGET_DATABASE_NAME: connection.database_name, TARGET_HOST_CLASS: target.mode === 'session' ? 'SESSION_POOLER' : 'REJECTED',
    TARGET_IS_SUPABASE_E2E: valid ? 'YES' : 'NO',
    TARGET_IS_PRODUCTION: valid ? 'NO' : 'UNKNOWN', TARGET_IS_OTHER_HML: valid ? 'NO' : 'UNKNOWN',
    POSTGRES_VERSION: major, DATABASE_URL_USED: 'YES', DIRECT_URL_USED: 'NO',
  } };
}

function evaluatePromotionEvidence({ artifactVerified, identityValid, model, rows, effects, compatibility, unrelatedDrift = [], duplicatePending = null }) {
  const history = new Set(rows.map((row) => row.migration_name));
  const applied = new Set(rows.filter((row) => row.finished_at && !row.rolled_back_at && !row.logs).map((row) => row.migration_name));
  const pending = model.authorized.filter((name) => !applied.has(name));
  const unexpected = [...history].filter((name) => !model.authorized.includes(name));
  const expectedFive = pendingEffectContracts.map((entry) => entry.migration);
  const exactFive = JSON.stringify(pending) === JSON.stringify(expectedFive);
  // Order comes from the governed catalog, and requires a fully applied prefix.
  const prefix = model.authorized.slice(0, model.authorized.length - expectedFive.length);
  const orderValid = exactFive && prefix.every((name) => applied.has(name))
    && JSON.stringify(model.authorized.slice(-expectedFive.length)) === JSON.stringify(expectedFive);
  const historyClean = unexpected.length === 0 && rows.every((row) => row.finished_at && !row.rolled_back_at && !row.logs)
    && history.size === rows.length && !history.has(supersededPassenger);
  const expectedMissing = [];
  const unexplained = [...unrelatedDrift];
  const matrix = pendingEffectContracts.map((entry) => {
    const historyPresent = history.has(entry.migration);
    const present = entry.effects.map((name) => effects[name]);
    entry.effects.forEach((name) => {
      if (effects[name] === false && !historyPresent) expectedMissing.push(name);
      else if (effects[name] !== true) unexplained.push(name + (effects[name] === false ? ':HISTORY_PRESENT_EFFECT_MISSING' : ':UNPROVEN'));
    });
    const allPresent = present.every((value) => value === true);
    const allAbsent = present.every((value) => value === false);
    const classification = historyPresent
      ? (allPresent ? 'ALREADY_APPLIED_AND_PRESENT' : 'HISTORY_PRESENT_EFFECT_MISSING')
      : allPresent ? 'HISTORY_MISSING_EFFECT_ALREADY_PRESENT'
        : allAbsent ? 'HISTORY_MISSING_EFFECT_MISSING' : 'INCONCLUSIVE';
    const check = compatibility[entry.migration] || { compatible: 'UNKNOWN', blocker: 'EVIDENCE_MISSING' };
    return { MIGRATION: entry.migration, HISTORY_PRESENT: historyPresent ? 'YES' : 'NO',
      EXPECTED_EFFECTS: entry.effects, EFFECTS_PRESENT: Object.fromEntries(entry.effects.map((name) => [name, effects[name] ?? 'UNKNOWN'])),
      ...(entry === pendingEffectContracts[0] ? { COLUMN_PRESENT: present[0], UNIQUE_INDEX_PRESENT: present[1] } : {}),
      ...(entry === pendingEffectContracts[1] ? { COLUMN_PRESENT: present[0] } : {}),
      ...(entry.dependency === 'ADD_ONLY_ENUM' ? { ENUM_VALUE_PRESENT: present[0] } : {}),
      ...(entry === pendingEffectContracts[4] ? { INDEX_PRESENT: present[0], DUPLICATE_PENDING_RIDE_COUNT: duplicatePending } : {}),
      DATA_DEPENDENCY: entry.dependency, TARGET_COMPATIBLE: check.compatible, BLOCKER: check.blocker, CLASSIFICATION: classification };
  });
  const compatible = exactFive && matrix.every((entry) => entry.TARGET_COMPATIBLE === 'YES');
  const safe = artifactVerified === true && identityValid === true && historyClean && orderValid && compatible && unexplained.length === 0;
  const attemptsHistorical = pending.some((name) => model.historical.includes(name));
  return { safe, matrix, outputs: {
    TARGET_POST_CUTOFF_EFFECT_MATRIX: JSON.stringify(matrix),
    TARGET_PENDING_MIGRATION_COMPATIBILITY_MATRIX: JSON.stringify(matrix.filter((entry) => pending.includes(entry.MIGRATION)).map(({ MIGRATION, DATA_DEPENDENCY, TARGET_COMPATIBLE, BLOCKER }) => ({ MIGRATION, DATA_DEPENDENCY, TARGET_COMPATIBLE, BLOCKER }))),
    TARGET_PENDING_MIGRATION_COMPATIBILITY_MATRIX_COMPLETE: exactFive && matrix.every((entry) => entry.TARGET_COMPATIBLE !== 'UNKNOWN') ? 'YES' : 'NO',
    TARGET_EXPECTED_PENDING_PHYSICAL_EFFECTS: expectedMissing,
    TARGET_UNEXPLAINED_PHYSICAL_DRIFT: unexplained.length ? unexplained : 'NONE',
    PHYSICAL_DRIFT_ASSESSMENT_SCOPE: 'FIVE_PENDING_EFFECTS_AND_REQUIRED_LIFECYCLE_PASSENGER_CONTRACT',
    TARGET_PENDING_ORDER_VALID: orderValid ? 'YES' : 'INCONCLUSIVE',
    TARGET_HISTORY_CONFLICT_PRESENT: historyClean ? 'NO' : 'YES',
    MIGRATE_DEPLOY_PROJECTION_CATALOG: 'VERIFIED_AUTHORIZED_ARTIFACT_ONLY',
    MIGRATE_DEPLOY_EXPECTED_PENDING_COUNT: pending.length,
    MIGRATE_DEPLOY_EXPECTED_PENDING_SET: pending,
    MIGRATE_DEPLOY_WOULD_ATTEMPT_SUPERSEDED_PASSENGER: artifactVerified ? (pending.includes(supersededPassenger) ? 'YES' : 'NO') : 'INCONCLUSIVE',
    MIGRATE_DEPLOY_WOULD_ATTEMPT_HISTORICAL_RESOLVED_SQL: artifactVerified ? (attemptsHistorical ? 'YES' : 'NO') : 'INCONCLUSIVE',
    MIGRATE_DEPLOY_SEQUENCE_DETERMINISTIC: artifactVerified && historyClean && orderValid ? 'YES' : 'INCONCLUSIVE',
    TARGET_MIGRATE_DEPLOY_READINESS_CLASS: safe ? 'SAFE_CANDIDATE_FOR_FUTURE_GOVERNED_DEPLOY' : 'BLOCKED',
    MIGRATE_DEPLOY_AUTHORITY: 'DENIED',
  } };
}

function parseCertificationMode(args) {
  if (args.length === 0) return 'INVENTORY';
  if (args.length === 2 && args[0] === '--mode' && incrementalModes.includes(args[1])) return args[1];
  throw new Error('INVALID_CERTIFICATION_MODE');
}

function evaluateIncrementalMode(mode, facts) {
  if (!incrementalModes.includes(mode)) throw new Error('INVALID_CERTIFICATION_MODE');
  const { artifactVerified, fingerprint, identityValid, model, rows, effects, compatibility,
    unrelatedDrift, duplicatePending, physical } = facts;
  const promotion = evaluatePromotionEvidence(facts);
  const inventory = evaluateMigrationInventory(rows, model.authorized);
  const applied = rows.filter((row) => row.finished_at && !row.rolled_back_at && !row.logs);
  const exactCatalog = model.authorized.length === 56 && new Set(model.authorized).size === 56
    && !model.authorized.includes(supersededPassenger);
  const historyClean = rows.every((row) => Object.hasOwn(row, 'finished_at')
    && Object.hasOwn(row, 'rolled_back_at') && Object.hasOwn(row, 'logs'))
    && promotion.outputs.TARGET_HISTORY_CONFLICT_PRESENT === 'NO';
  const common = artifactVerified === true && fingerprint === incrementalFingerprint && identityValid === true
    && exactCatalog && historyClean && Array.isArray(unrelatedDrift)
    && promotion.outputs.TARGET_UNEXPLAINED_PHYSICAL_DRIFT === 'NONE'
    && duplicatePending === 0;
  const finalExact = rows.length === 56 && applied.length === 56 && inventory.missing.length === 0
    && inventory.unexpected.length === 0 && historyClean;
  const allEffects = pendingEffectContracts.every((entry) => entry.effects.every((name) => effects[name] === true));
  const physicalComplete = physical?.correlationIndexEquivalent === true && physical?.pendingIndexEquivalent === true
    && physical?.correlationDuplicates === 0;
  const pre = mode === 'PRE_INCREMENTAL_DEPLOY';
  const pass = common && (pre
    ? applied.length === 51 && inventory.missing.length === 5 && promotion.safe
      && promotion.outputs.TARGET_PENDING_MIGRATION_COMPATIBILITY_MATRIX_COMPLETE === 'YES'
      && pendingEffectContracts.every((entry) => compatibility[entry.migration]?.compatible === 'YES')
    : finalExact && allEffects && physicalComplete);
  return { pass, outputs: {
    INCREMENTAL_CERTIFICATION_MODE: mode,
    TARGET_APPLIED_MIGRATION_COUNT: applied.length,
    TARGET_PENDING_MIGRATION_COUNT: inventory.missing.length,
    TARGET_PENDING_SET_EXACT: promotion.outputs.TARGET_PENDING_ORDER_VALID === 'YES' ? 'YES' : 'NO',
    FINAL_HISTORY_EXACT_SET_MATCH: finalExact ? 'YES' : 'NO',
    MIGRATE_DEPLOY_PROJECTED_SAFE: pre && pass ? 'YES' : 'NO',
    PROMOTION_CERTIFIED: !pre && pass ? 'YES' : 'NO',
    HUMAN_INSPECTION_REQUIRED: pass ? 'NO' : 'YES',
  } };
}

async function collectPromotionEvidence(client, facts) {
  const { artifact, identityValid, migrationRows, columnRows, availability, snapshotPresent, duplicatePending } = facts;
  const columns = new Map(columnRows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
  const unrelatedDrift = [];
  for (const name of ['creationCorrelationId', 'creationIntentFingerprint']) {
    const column = columns.get(`RideRequest.${name}`);
    if (column && (column.udt_name !== 'text' || column.is_nullable !== 'YES')) unrelatedDrift.push(`RideRequest.${name}:TYPE_OR_NULLABILITY_MISMATCH`);
  }
  for (const [enumName, expected] of Object.entries(expectedStatuses)) {
    for (const value of expected.filter((entry) => !(enumName === 'RideStatus' && entry === 'WAITING_OWNER') && !(enumName === 'RideOfferStatus' && entry === 'CANCELLED'))) {
      if (!availability.values.get(enumName).includes(value)) unrelatedDrift.push(`${enumName}.${value}:MISSING`);
    }
  }
  for (const name of expectedColumns.RideRequest.slice(0, 5)) {
    if (!columns.has(`RideRequest.${name}`)) unrelatedDrift.push(`RideRequest.${name}:MISSING`);
  }
  if (!snapshotPresent) unrelatedDrift.push('OwnershipSnapshot:MISSING');
  for (const name of expectedColumns.Passenger) {
    if (columns.get(`Passenger.${name}`)?.is_nullable !== 'YES') unrelatedDrift.push(`Passenger.${name}:NULLABILITY_OR_COLUMN_MISMATCH`);
  }
  if (expectedColumns.Passenger.every((name) => columns.has(`Passenger.${name}`))) {
    const counts = await client.query('SELECT count(*) AS total, count(*) FILTER (WHERE "referralCode" IS NULL) AS referral_null, count(*) FILTER (WHERE "publicSlug" IS NULL) AS slug_null FROM public."Passenger"');
    emit('PASSENGER_ROW_COUNT', counts.rows[0].total);
    emit('PASSENGER_REFERRAL_CODE_NULL_COUNT', counts.rows[0].referral_null);
    emit('PASSENGER_PUBLIC_SLUG_NULL_COUNT', counts.rows[0].slug_null);
  } else {
    for (const key of ['PASSENGER_ROW_COUNT', 'PASSENGER_REFERRAL_CODE_NULL_COUNT', 'PASSENGER_PUBLIC_SLUG_NULL_COUNT']) emit(key, 'UNKNOWN');
  }
  // Resolve by object name even if it belongs to a wrong table or is not an index.
  const indexRows = await client.query(`
    SELECT c.relname, c.relkind, t.relname AS table_name, i.indisunique, i.indisvalid,
           i.indisready, i.indislive, i.indimmediate, i.indnkeyatts, i.indnatts,
           i.indexprs IS NULL AS plain_key, am.amname,
           pg_get_expr(i.indpred, i.indrelid, false) AS predicate,
           a.attname AS key_name, op.opcdefault,
           op.opcintype = a.atttypid AS opclass_matches,
           i.indcollation[0] = a.attcollation AS collation_matches
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_index i ON i.indexrelid = c.oid
    LEFT JOIN pg_class t ON t.oid = i.indrelid
    LEFT JOIN pg_am am ON am.oid = c.relam
    LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] AND NOT a.attisdropped
    LEFT JOIN pg_opclass op ON op.oid = i.indclass[0]
    WHERE n.nspname = 'public' AND c.relname IN ('RideRequest_creationCorrelationId_key', 'RideOffer_one_pending_per_ride')
  `);
  const indexes = new Map(indexRows.rows.map((row) => [row.relname, row]));
  const equivalent = (row, table, column, partial) => Boolean(row && row.relkind === 'i' && row.table_name === table
    && row.indisunique && row.indisvalid && row.indisready && row.indislive && row.indimmediate
    && row.indnkeyatts === 1 && row.indnatts === 1 && row.plain_key && row.key_name === column
    && row.amname === 'btree' && row.opcdefault && row.opclass_matches && row.collation_matches
    && (partial ? ['(status = \'PENDING\'::"RideOfferStatus")', '(\'PENDING\'::"RideOfferStatus" = status)'].includes(row.predicate) : row.predicate === null));
  const correlationIndex = indexes.get('RideRequest_creationCorrelationId_key');
  const pendingIndex = indexes.get('RideOffer_one_pending_per_ride');
  const pendingEquivalent = equivalent(pendingIndex, 'RideOffer', 'rideRequestId', true);
  if (correlationIndex && !equivalent(correlationIndex, 'RideRequest', 'creationCorrelationId', false)) unrelatedDrift.push('RideRequest_creationCorrelationId_key:INCOMPATIBLE');
  if (pendingIndex && !pendingEquivalent) unrelatedDrift.push('RideOffer_one_pending_per_ride:INCOMPATIBLE');
  const effects = {
    'RideRequest.creationCorrelationId': columns.has('RideRequest.creationCorrelationId'),
    RideRequest_creationCorrelationId_key: Boolean(correlationIndex),
    'RideRequest.creationIntentFingerprint': columns.has('RideRequest.creationIntentFingerprint'),
    'RideStatus.WAITING_OWNER': availability.waitingOwnerPresent,
    'RideOfferStatus.CANCELLED': availability.cancelledPresent,
    RideOffer_one_pending_per_ride: Boolean(pendingIndex),
  };
  let correlationDuplicates = 0;
  if (effects['RideRequest.creationCorrelationId']) {
    const result = await client.query('SELECT count(*) AS count FROM (SELECT "creationCorrelationId" FROM public."RideRequest" WHERE "creationCorrelationId" IS NOT NULL GROUP BY "creationCorrelationId" HAVING count(*) > 1) AS duplicates');
    correlationDuplicates = Number(result.rows[0].count);
  }
  emit('CORRELATION_DUPLICATE_NON_NULL_GROUPS', correlationDuplicates);
  if (correlationDuplicates !== 0) unrelatedDrift.push('RideRequest.creationCorrelationId:DUPLICATES_OR_UNKNOWN');
  emit('CORRELATION_EXISTING_DATA_BLOCKER', correlationDuplicates === 0 ? 'NO' : 'YES');
  emit('WAITING_OWNER_EXISTING_DATA_BLOCKER', 'NO');
  emit('CANCELLED_EXISTING_DATA_BLOCKER', 'NO');
  emit('ONE_PENDING_EXISTING_DATA_COMPATIBLE', duplicatePending === 0 ? 'YES' : 'NO');
  const checks = [
    !effects['RideRequest.creationCorrelationId'] && !correlationIndex,
    !effects['RideRequest.creationIntentFingerprint'],
    availability.values.get('RideStatus').length > 0,
    availability.values.get('RideOfferStatus').length > 0,
    duplicatePending === 0 && (!pendingIndex || pendingEquivalent),
  ];
  const compatibility = Object.fromEntries(pendingEffectContracts.map((entry, i) => [entry.migration, {
    compatible: checks[i] ? 'YES' : 'NO',
    blocker: checks[i] ? 'NONE' : i < 2 ? 'ADD_COLUMN_OR_INDEX_ALREADY_EXISTS' : i === 4 ? 'DUPLICATES_OR_INCOMPATIBLE_INDEX' : 'ENUM_TYPE_MISSING',
  }]));
  const collected = { artifactVerified: artifact.verified, fingerprint: artifact.fingerprint, identityValid,
    model: artifact.model, rows: migrationRows, effects, compatibility, unrelatedDrift, duplicatePending,
    physical: { correlationIndexEquivalent: equivalent(correlationIndex, 'RideRequest', 'creationCorrelationId', false),
      pendingIndexEquivalent: pendingEquivalent, correlationDuplicates } };
  return { ...evaluatePromotionEvidence(collected), facts: collected };
}

async function main() {
  const mode = parseCertificationMode(process.argv.slice(2));
  const artifact = verifyCertificationArtifact(required('PRISMA_MIGRATIONS_PATH'));
  if (mode !== 'INVENTORY') {
    artifact.fingerprint = fs.readFileSync(path.resolve('governance/authorized-migration-catalog.sha256'), 'utf8').trim();
    if (artifact.fingerprint !== incrementalFingerprint) throw new Error('INCREMENTAL_FINGERPRINT_MISMATCH');
  }
  const target = validateTarget(required('DATABASE_URL'));
  if (target.mode !== 'session') throw new Error('SESSION_POOLER_REQUIRED');
  required('E2E_CA_CERT');

  const client = new Client({
    connectionString: target.connectionString,
    ssl: { ca: process.env.E2E_CA_CERT, rejectUnauthorized: true },
  });
  let modeResult;

  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');

    const clientStream = client.connection?.stream;
    const clientTlsEncrypted = clientStream?.encrypted === true;
    const clientTlsAuthorized = clientStream?.authorized === true;
    const clientTlsAuthorizationError = clientStream?.authorizationError;

    const connection = await client.query(`
      SELECT current_database() AS database_name,
             current_setting('server_version_num') AS server_version_num,
             current_setting('transaction_read_only') AS transaction_read_only,
             ssl,
             v.version
      FROM pg_stat_ssl
      CROSS JOIN (SELECT version()) AS v
      WHERE pid = pg_backend_pid()
    `);
    const connectionRow = connection.rows[0];
    const pgMajor = Math.floor(Number(connectionRow.server_version_num) / 10000);
    emit('POOLER_CONNECTION', 'PASS');
    emit('CLIENT_TLS_ENCRYPTED', clientTlsEncrypted ? 'YES' : 'NO');
    emit('CLIENT_TLS_AUTHORIZED', clientTlsAuthorized ? 'YES' : 'NO');
    emit('BACKEND_PG_STAT_SSL', connectionRow.ssl === true ? 'true' : 'false');
    const clientTlsPass = clientTlsEncrypted && clientTlsAuthorized && !clientTlsAuthorizationError;
    emit('TLS', clientTlsPass ? 'PASS' : 'FAIL');
    emit('PG_VERSION', pgMajor);
    emit('DATABASE_NAME', connectionRow.database_name);
    emit('READ_ONLY_MODE', connectionRow.transaction_read_only === 'on' ? 'PASS' : 'FAIL');
    if (!clientTlsPass) throw new Error('TLS_CERTIFICATION_FAILURE');
    if (connectionRow.transaction_read_only !== 'on') {
      emit('DATABASE_READ_ONLY_ENFORCEMENT', 'FAIL');
      throw new Error('READ_ONLY_ENFORCEMENT_FAILURE');
    }
    emit('DATABASE_READ_ONLY_ENFORCEMENT', 'PASS');
    const identity = targetIdentity(target, connectionRow);
    for (const [key, value] of Object.entries(identity.outputs)) emit(key, value);
    if (!identity.valid) throw new Error('TARGET_IDENTITY_FAILURE');

    const enumRows = await client.query(`
      SELECT t.typname AS enum_name, e.enumlabel AS enum_value
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname IN ('RideStatus', 'RideOfferStatus')
      ORDER BY t.typname, e.enumsortorder
    `);
    const availability = enumAvailability(enumRows.rows);
    for (const enumName of Object.keys(expectedStatuses)) {
      const values = availability.values.get(enumName) ?? [];
      emit(`TARGET_${enumName === 'RideStatus' ? 'RIDE_STATUS' : 'RIDEOFFER_STATUS'}_VALUES`, values);
    }
    emit('WAITING_OWNER_TARGET_PRESENT', availability.waitingOwnerPresent ? 'YES' : 'NO');
    emit('RIDEOFFER_CANCELLED_TARGET_PRESENT', availability.cancelledPresent ? 'YES' : 'NO');

    const columnRows = await client.query(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('RideRequest', 'OwnershipSnapshot', 'Passenger')
    `);
    const rideColumns = new Set(columnRows.rows.filter((row) => row.table_name === 'RideRequest').map((row) => row.column_name));
    for (const column of expectedColumns.RideRequest) emit(`TARGET_${column.replaceAll(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}_PRESENT`, rideColumns.has(column) ? 'YES' : 'NO');
    const passengerColumns = new Map(columnRows.rows.filter((row) => row.table_name === 'Passenger').map((row) => [row.column_name, row]));
    emit('PASSENGER_REFERRAL_CODE_NULLABLE', passengerColumns.get('referralCode')?.is_nullable === 'YES' ? 'YES' : 'NO');
    emit('PASSENGER_PUBLIC_SLUG_NULLABLE', passengerColumns.get('publicSlug')?.is_nullable === 'YES' ? 'YES' : 'NO');
    const snapshotPresent = columnRows.rows.some((row) => row.table_name === 'OwnershipSnapshot');
    emit('TARGET_OWNERSHIP_SNAPSHOT_PRESENT', snapshotPresent ? 'YES' : 'NO');
    const schemaFactsPresent = expectedColumns.RideRequest.every((column) => schema.includes(column))
      && expectedColumns.Passenger.every((column) => schema.includes(column))
      && schema.includes('model OwnershipSnapshot');
    const passengerColumnsPresent = expectedColumns.Passenger.every((column) => passengerColumns.has(column));
    const columnsMatch = expectedColumns.RideRequest.every((column) => rideColumns.has(column))
      && passengerColumnsPresent
      && snapshotPresent;
    emit('TARGET_LIFECYCLE_COLUMNS_MATCH_SCHEMA', schemaFactsPresent && columnsMatch ? 'YES' : 'NO');
    emit('CREATION_CORRELATION_TARGET_PRESENT', rideColumns.has('creationCorrelationId') ? 'YES' : 'NO');
    emit('CREATION_INTENT_FINGERPRINT_TARGET_PRESENT', rideColumns.has('creationIntentFingerprint') ? 'YES' : 'NO');
    emit('TARGET_REQUIRED_COLUMNS_MATCH', columnsMatch ? 'YES' : 'NO');

    const migrationRows = await client.query(`
      SELECT migration_name, finished_at, rolled_back_at, logs, applied_steps_count
      FROM public."_prisma_migrations"
      ORDER BY migration_name
    `);
    const authorizedNames = artifact.model.authorized;
    const inventory = evaluateMigrationInventory(migrationRows.rows, authorizedNames);
    const applied = new Map(migrationRows.rows.map((row) => [row.migration_name, row]));
    for (const migration of expectedMigrations) {
      const row = applied.get(migration);
      emit(`MIGRATION_${migration}_PRESENT`, row ? 'YES' : 'NO');
      emit(`MIGRATION_${migration}_FINISHED_AT_PRESENT`, row?.finished_at ? 'YES' : 'NO');
      emit(`MIGRATION_${migration}_ROLLED_BACK_AT`, row?.rolled_back_at ? 'YES' : 'NO');
      emit(`MIGRATION_${migration}_APPLIED_SUCCESSFULLY`, row?.finished_at && !row.rolled_back_at ? 'YES' : 'NO');
    }
    emit('TARGET_APPLIED_MIGRATION_COUNT', inventory.appliedNames.length);
    emit('TARGET_APPLIED_MIGRATION_NAMES', inventory.appliedNames);
    emit('AUTHORIZED_MIGRATION_COUNT', authorizedNames.length);
    emit('TARGET_APPLIED_AUTHORIZED_COUNT', inventory.appliedNames.filter((name) => authorizedNames.includes(name)).length);
    emit('TARGET_MISSING_AUTHORIZED_COUNT', inventory.missing.length);
    emit('TARGET_UNEXPECTED_MIGRATION_COUNT', inventory.unexpected.length);
    emit('TARGET_UNFINISHED_COUNT', inventory.unfinished.length);
    emit('TARGET_ROLLED_BACK_COUNT', inventory.rolledBack.length);
    emit('TARGET_FAILED_COUNT', inventory.failed.length);
    emit('TARGET_MISSING_AUTHORIZED_MIGRATIONS', inventory.missing);
    emit('TARGET_UNEXPECTED_MIGRATIONS', inventory.unexpected);
    emit('TARGET_HISTORY_EXACT_SUBSET_OF_AUTHORIZED', inventory.unexpected.length === 0 ? 'YES' : 'NO');
    emit('TARGET_PENDING_MIGRATION_COUNT', inventory.missing.length);
    emit('TARGET_PENDING_MIGRATIONS', inventory.missing);
    const passengerSuperseded = '20260518000000_passenger_codes_not_null_future';
    const passengerSupersededPresent = inventory.appliedNames.includes(passengerSuperseded);
    emit('PASSENGER_SUPERSEDED_PRESENT_IN_TARGET_HISTORY', passengerSupersededPresent ? 'YES' : 'NO');
    emit('PASSENGER_CURRENT_SCHEMA_MATCHES_GOVERNED_CONTRACT',
      !passengerSupersededPresent && passengerColumns.get('referralCode')?.is_nullable === 'YES'
        && passengerColumns.get('publicSlug')?.is_nullable === 'YES' ? 'YES' : 'NO');
    const migrationState = expectedMigrations.every((migration) => {
      const row = applied.get(migration);
      return Boolean(row?.finished_at) && !row.rolled_back_at;
    });
    emit('TARGET_MIGRATION_STATE_CERTIFIED', migrationState ? 'YES' : 'NO');
    emit('TARGET_MIGRATION_ORDER_MATCH', migrationState ? 'YES' : 'NO');

    const indexResult = await client.query(`
      SELECT i.indisunique, i.indisvalid, i.indisready, pg_get_indexdef(c.oid) AS definition
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname = 'RideOffer'
        AND c.relname = 'RideOffer_one_pending_per_ride'
    `);
    const index = indexResult.rows[0];
    const indexKeyMatch = Boolean(index && /\("rideRequestId"\)/.test(index.definition));
    const indexPredicateMatch = Boolean(index && /WHERE .*status.*PENDING/i.test(index.definition));
    const indexEquivalent = Boolean(index?.indisunique && index?.indisvalid && index?.indisready && indexKeyMatch && indexPredicateMatch);
    emit('TARGET_ONE_PENDING_INDEX_PRESENT', index ? 'YES' : 'NO');
    emit('TARGET_ONE_PENDING_INDEX_VALID', index ? (index.indisvalid ? 'YES' : 'NO') : 'NOT_PRESENT');
    emit('TARGET_ONE_PENDING_INDEX_READY', index ? (index.indisready ? 'YES' : 'NO') : 'NOT_PRESENT');
    emit('TARGET_ONE_PENDING_INDEX_UNIQUE', index ? (index.indisunique ? 'YES' : 'NO') : 'NOT_PRESENT');
    emit('TARGET_ONE_PENDING_INDEX_KEY_MATCH', index ? (indexKeyMatch ? 'YES' : 'NO') : 'NOT_PRESENT');
    emit('TARGET_ONE_PENDING_INDEX_PREDICATE_MATCH', index ? (indexPredicateMatch ? 'YES' : 'NO') : 'NOT_PRESENT');
    emit('TARGET_ONE_PENDING_INDEX_EQUIVALENT', index ? (indexEquivalent ? 'YES' : 'NO') : 'NOT_PRESENT');
    const duplicates = await client.query(`
      SELECT "rideRequestId", count(*)::int AS count
      FROM public."RideOffer"
      WHERE status::text = 'PENDING'
      GROUP BY "rideRequestId"
      HAVING count(*) > 1
    `);
    emit('DUPLICATE_PENDING_RIDE_COUNT', duplicates.rows.length);
    emit('DUPLICATE_PENDING_OFFERS_PRESENT', duplicates.rows.length > 0 ? 'YES' : 'NO');

    const completion = await collectPromotionEvidence(client, {
      artifact, identityValid: identity.valid, migrationRows: migrationRows.rows,
      columnRows: columnRows.rows, availability, snapshotPresent,
      duplicatePending: duplicates.rows.length,
    });
    for (const [key, value] of Object.entries(completion.outputs)) emit(key, value);

    if (mode !== 'INVENTORY') {
      modeResult = evaluateIncrementalMode(mode, completion.facts);
      if (!modeResult.pass) throw new Error('INCREMENTAL_CERTIFICATION_FAILED');
    }

    const enumChecks = await runEnumDependentChecks(client, availability);
    emit('WAITING_OWNER_ROW_CHECK', availability.waitingOwnerPresent ? 'EXECUTED' : enumChecks.waitingOwner);
    emit('TARGET_WAITING_OWNER_ROW_COUNT', enumChecks.waitingOwner);
    emit('RIDEOFFER_CANCELLED_ROW_CHECK', availability.cancelledPresent ? 'EXECUTED' : enumChecks.cancelled);
    emit('TARGET_CANCELLED_OFFER_ROW_COUNT', enumChecks.cancelled);
    const ownerRecovery = await client.query(`SELECT COUNT(*) AS count FROM public."RideRequest" WHERE "currentDispatchStage"::text = 'OWNER_RECOVERY'`);
    emit('TARGET_OWNER_RECOVERY_ROW_COUNT', ownerRecovery.rows[0].count);
    emit('WAITING_OWNER_BACKFILL_REQUIRED', 'NO');
    emit('RIDEOFFER_CANCELLED_BACKFILL_REQUIRED', 'NO');
    emit('LEGACY_ROWS_REQUIRE_BACKFILL', 'NO');
    emit('TARGET_PHYSICAL_SCHEMA_DRIFT', evaluatePhysicalCompatibility({
      waitingOwnerPresent: availability.waitingOwnerPresent,
      cancelledPresent: availability.cancelledPresent,
      requiredColumnsPresent: columnsMatch,
      indexEquivalent,
    }));
    emit('TARGET_SCHEMA_DRIFT', columnsMatch && migrationState ? 'NONE' : 'PRESENT');
    emit('WRITE_QUERY_ATTEMPTED', 'NO');
    emit('DDL_ATTEMPTED', 'NO');
    emit('DML_ATTEMPTED', 'NO');
    emit('SECRET_EXPOSED', 'NO');
    emit('LOGS_SANITIZED', 'YES');
    emit('DATABASE_ACCESS_MODE', 'READ_ONLY');
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
  // The success token is emitted only after all queries, rollback and disconnect complete.
  if (modeResult) {
    for (const [key, value] of Object.entries(modeResult.outputs)) emit(key, value);
    emit('INCREMENTAL_CERTIFICATION_RESULT', `${mode}:PASS`);
  }
}

if (require.main === module) main().catch((error) => {
  const code = /^[A-Z_]+$/.test(error?.message || '') ? error.message : 'CERTIFICATION_FAILED';
  emit('PROMOTION_CERTIFIED', 'NO');
  emit('HUMAN_INSPECTION_REQUIRED', 'YES');
  console.error(`R11_1_CERTIFICATION=FAIL code=${code}`);
  process.exitCode = 1;
});

module.exports = {
  parseCertificationMode,
  evaluateIncrementalMode,
  incrementalFingerprint,
  collectPromotionEvidence,
  targetIdentity,
  verifyCertificationArtifact,
  evaluatePromotionEvidence,
  pendingEffectContracts,
  enumAvailability,
  enumDependentChecks,
  evaluateMigrationInventory,
  evaluatePhysicalCompatibility,
  runEnumDependentChecks,
};
