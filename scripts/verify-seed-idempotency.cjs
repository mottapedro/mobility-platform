/**
 * Seed Idempotency Proof — disposable DB
 *
 * Executes the Golden Seed twice against a freshly-created disposable local
 * PostgreSQL database (baseline applied first) and proves:
 *   - count(R1) == count(R2) for every deterministic entity;
 *   - natural keys/IDs of R1 == natural keys/IDs of R2;
 *   - no duplicated (driverId, dayOfWeek) DriverAvailability combos;
 *   - RevenuePolicy ROOT_DRIVER_STANDARD (500 bps / OPERATIONAL_REVENUE) exists exactly once;
 *   - OwnershipPolicy ADR-004 default exists exactly once.
 *
 * Usage (from repo root, PowerShell):
 *   node scripts/verify-seed-idempotency.cjs
 *   $env:SEED_IDEMPOTENCY_DATABASE_URL="postgresql://postgres:postgres@localhost:55432/postgres"
 *
 * The disposable database is created and dropped by this script.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require("pg");

const LOCAL_ENV = path.resolve(__dirname, "..", ".env");
const BASELINE_SQL = path.resolve(
  __dirname,
  "..",
  "prisma",
  "migrations",
  "20260101000000_init_baseline",
  "migration.sql"
);
const SEED_SCRIPT = path.resolve(__dirname, "..", "prisma", "seeds", "golden-network-seed.ts");
const DISPOSABLE_DB = "mobility_seed_idem_proof";

function readLocalDbUrl() {
  const raw = fs
    .readFileSync(LOCAL_ENV, "utf-8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("DATABASE_URL="));
  if (!raw) throw new Error("DATABASE_URL not found in .env");
  return raw.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, "");
}

function withDb(dbUrl, dbName) {
  return dbUrl.replace(/\/[^/]+$/, `/${dbName}`);
}

function parseConn(dbUrl) {
  const u = new URL(dbUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    // NOTE: pg uses `database`, not `db`. Using `db` silently defaults to the
    // user database (e.g. `postgres`) — a silent connection to the wrong DB.
    database: u.pathname.slice(1),
  };
}

async function connect(conn) {
  const c = new Client(conn);
  await c.connect();
  return c;
}

async function main() {
  const localUrl = process.env.SEED_IDEMPOTENCY_DATABASE_URL || readLocalDbUrl();
  const adminConn = parseConn(withDb(localUrl, "postgres"));
  const disposableConn = parseConn(withDb(localUrl, DISPOSABLE_DB));

  const sanitize = (u) => u.replace(/\/\/([^:]+):[^@]*@/, "//$1:***@");
  console.log("=== Seed Idempotency Proof (disposable DB) ===");
  console.log(`Local admin: postgres@${adminConn.host}:${adminConn.port} (db postgres)`);
  console.log(`Disposable:  ${DISPOSABLE_DB}`);
  console.log(`seed DATABASE_URL: ${sanitize(withDb(localUrl, DISPOSABLE_DB))}`);

  // 1. Reset disposable DB
  const admin = await connect(adminConn);
  // Terminate any lingering connections (e.g. a previous failed seed subprocess).
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DISPOSABLE_DB}' AND pid <> pg_backend_pid()`
  );
  await admin.query(`DROP DATABASE IF EXISTS "${DISPOSABLE_DB}"`);
  await admin.query(`CREATE DATABASE "${DISPOSABLE_DB}"`);
  await admin.end();
  console.log("  ✅ disposable DB created");

  // 2. Apply baseline
  const db = await connect(disposableConn);
  const baseline = fs.readFileSync(BASELINE_SQL, "utf-8");
  // The local PostgreSQL template DBs may carry a copy of the baseline schema
  // (template pollution). Purge the inherited public schema so the disposable
  // DB is truly empty, then apply the certified baseline on top.
  await db.query(`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.query(`CREATE SCHEMA public`);
  await db.query(baseline);
  const dbTables = await db.query("SELECT count(*)::int AS c FROM pg_tables WHERE schemaname='public'");
  console.log(`  ✅ baseline applied (tables in disposable: ${dbTables.rows[0].c})`);
  await db.end();

  // 3. Run the seed twice via subprocess (identical to npm run seed:golden)
  const runSeed = () => {
    const env = { ...process.env, DATABASE_URL: withDb(localUrl, DISPOSABLE_DB) };
    execFileSync(
      process.execPath,
      [
        path.resolve(__dirname, "..", "node_modules", "ts-node", "dist", "bin.js"),
        "--transpileOnly",
        "-r",
        "tsconfig-paths/register",
        SEED_SCRIPT,
      ],
      { env, stdio: "inherit", encoding: "utf-8" }
    );
  };

  console.log("  --- RUN 1 ---");
  runSeed();
  const r1 = await snapshot(withDb(localUrl, DISPOSABLE_DB));
  console.log("  --- RUN 2 ---");
  runSeed();
  const r2 = await snapshot(withDb(localUrl, DISPOSABLE_DB));

  // 4. Compare
  const entities = [
    "User",
    "Driver",
    "Passenger",
    "Vehicle",
    "DriverAvailability",
    "DriverReferral",
    "ReferralRelationship",
    "RideRequest",
    "RideOffer",
    "DriverSkill",
    "Skill",
    "OwnershipSnapshot",
    "RevenuePolicy",
    "OwnershipPolicy",
  ];
  const table = [];
  let allPass = true;
  for (const e of entities) {
    const c1 = r1.counts[e] ?? 0;
    const c2 = r2.counts[e] ?? 0;
    const ok = c1 === c2;
    if (!ok) allPass = false;
    table.push([e, String(c1), String(c2), ok ? "✅" : "❌"]);
  }

  // Identity comparison (natural keys must be identical across runs)
  const identityKeys = ["User", "Driver", "Passenger", "Vehicle", "DriverAvailability", "RevenuePolicy", "OwnershipPolicy"];
  let identityPass = true;
  const identityTable = [];
  for (const e of identityKeys) {
    const i1 = r1.identities[e];
    const i2 = r2.identities[e];
    const same = JSON.stringify(i1) === JSON.stringify(i2);
    if (!same) {
      identityPass = false;
      allPass = false;
    }
    identityTable.push([e, `${i1.length} keys`, same ? "✅" : "❌"]);
  }

  // Direct D2D graph identity must be stable across runs and exactly equal
  // between the legacy closure table and the V2 relational read model.
  const d2dIdentityKeys = ["DriverReferralD2D", "ReferralRelationshipD2D"];
  for (const e of d2dIdentityKeys) {
    const i1 = r1.identities[e];
    const i2 = r2.identities[e];
    const same = JSON.stringify(i1) === JSON.stringify(i2);
    if (!same) {
      identityPass = false;
      allPass = false;
    }
    identityTable.push([e, `${i1.length} pairs`, same ? "✅" : "❌"]);
  }

  const expectedDirectD2DCount = 13;
  const d2dParityR1 =
    JSON.stringify(r1.identities.DriverReferralD2D) ===
    JSON.stringify(r1.identities.ReferralRelationshipD2D);
  const d2dParityR2 =
    JSON.stringify(r2.identities.DriverReferralD2D) ===
    JSON.stringify(r2.identities.ReferralRelationshipD2D);
  const d2dCountOk =
    r1.identities.DriverReferralD2D.length === expectedDirectD2DCount &&
    r1.identities.ReferralRelationshipD2D.length === expectedDirectD2DCount &&
    r2.identities.DriverReferralD2D.length === expectedDirectD2DCount &&
    r2.identities.ReferralRelationshipD2D.length === expectedDirectD2DCount;
  const d2dParityOk = d2dParityR1 && d2dParityR2 && d2dCountOk;
  if (!d2dParityOk) allPass = false;

  // 5. DriverAvailability duplication check
  const availKeys1 = r1.identities.DriverAvailability.map((k) => k.join("|")).sort();
  const availUnique = new Set(availKeys1).size === availKeys1.length;
  const availTable = [
    ["DriverAvailability(driverId, dayOfWeek) total R1", String(availKeys1.length)],
    ["DriverAvailability(driverId, dayOfWeek) unique R1", String(new Set(availKeys1).size)],
    ["Duplicated DriverAvailability(driverId, dayOfWeek)", String(availKeys1.length - new Set(availKeys1).size)],
  ];

  // 6. Policy validation
  const rp = r1.rows.RevenuePolicy;
  const op = r1.rows.OwnershipPolicy;
  const rpStandard = rp.filter((r) => r.code === "ROOT_DRIVER_STANDARD" && r.version === 1);
  const rpOk =
    rpStandard.length === 1 &&
    rpStandard[0].rootDriverBps === 500 &&
    rpStandard[0].baseType === "OPERATIONAL_REVENUE";
  if (!rpOk) allPass = false;
  const opDefault = op.filter((r) => r.code === "PASSENGER_ROOTDRIVER_DIRECT" && r.version === 1);
  const opOk = opDefault.length === 1 && opDefault[0].resolutionStrategy === "PASSENGER_ROOTDRIVER_DIRECT";
  if (!opOk) allPass = false;

  // 6b. Canonical identity consolidation: Pedro and João must exist exactly once
  // each (mottapedro01@gmail.com / jln@gmail.com), and the legacy duplicate
  // emails must NOT exist.
  const userEmailsR2 = r2.identities.User;
  const canonicalPedro = userEmailsR2.filter((e) => e === "mottapedro01@gmail.com").length;
  const canonicalJoao = userEmailsR2.filter((e) => e === "jln@gmail.com").length;
  const legacyPedro = userEmailsR2.filter((e) => e === "pedro.paulo.motta@mobility.com").length;
  const legacyJoao = userEmailsR2.filter((e) => e === "joao.luiz.brito@mobility.com").length;
  const canonicalOk =
    canonicalPedro === 1 && canonicalJoao === 1 && legacyPedro === 0 && legacyJoao === 0;
  if (!canonicalOk) allPass = false;

  // 6c. Referential integrity after R2: every FK-referenced id must exist in its
  // parent table.
  const fkChecks = [
    ["Driver.userId -> User.id", `SELECT COUNT(*)::int AS c FROM "Driver" d LEFT JOIN "User" u ON u.id = d."userId" WHERE u.id IS NULL`],
    ["Passenger.userId -> User.id", `SELECT COUNT(*)::int AS c FROM "Passenger" p LEFT JOIN "User" u ON u.id = p."userId" WHERE u.id IS NULL`],
    ["Vehicle.driverId -> Driver.id", `SELECT COUNT(*)::int AS c FROM "Vehicle" v LEFT JOIN "Driver" d ON d.id = v."driverId" WHERE d.id IS NULL`],
    ["DriverAvailability.driverId -> Driver.id", `SELECT COUNT(*)::int AS c FROM "DriverAvailability" a LEFT JOIN "Driver" d ON d.id = a."driverId" WHERE d.id IS NULL`],
    ["DriverReferral.referrerDriverId -> Driver.id", `SELECT COUNT(*)::int AS c FROM "DriverReferral" r LEFT JOIN "Driver" d ON d.id = r."referrerDriverId" WHERE d.id IS NULL`],
    ["DriverReferral.referredDriverId -> Driver.id", `SELECT COUNT(*)::int AS c FROM "DriverReferral" r LEFT JOIN "Driver" d ON d.id = r."referredDriverId" WHERE d.id IS NULL`],
    ["RideRequest.passengerId -> Passenger.id", `SELECT COUNT(*)::int AS c FROM "RideRequest" rr LEFT JOIN "Passenger" p ON p.id = rr."passengerId" WHERE p.id IS NULL`],
    ["RideOffer.rideRequestId -> RideRequest.id", `SELECT COUNT(*)::int AS c FROM "RideOffer" o LEFT JOIN "RideRequest" rr ON rr.id = o."rideRequestId" WHERE rr.id IS NULL`],
  ];
  const c2conn = await connect(parseConn(withDb(localUrl, DISPOSABLE_DB)));
  let fkOk = true;
  const fkTable = [];
  for (const [label, sql] of fkChecks) {
    const r = await c2conn.query(sql);
    const orphans = Number(r.rows[0].c);
    const ok = orphans === 0;
    if (!ok) {
      fkOk = false;
      allPass = false;
    }
    fkTable.push([label, String(orphans), ok ? "✅" : "❌"]);
  }
  await c2conn.end();

  // 7. Report
  console.log("\n=== COUNTS ===");
  console.log("Entity                R1        R2");
  for (const [e, c1, c2, ok] of table) {
    console.log(`${e.padEnd(20)} ${c1.padStart(8)} ${c2.padStart(8)}    ${ok}`);
  }
  console.log("\n=== IDENTITY (natural keys R1 == R2) ===");
  for (const [e, n, ok] of identityTable) {
    console.log(`${e.padEnd(20)} ${n.padStart(10)}    ${ok}`);
  }
  console.log("\n=== DriverAvailability duplication ===");
  for (const [label, v] of availTable) {
    console.log(`${label.padEnd(52)} ${v}`);
  }
  console.log("\n=== Direct D2D parity ===");
  console.log(`R1 DriverReferral pairs: ${r1.identities.DriverReferralD2D.length}`);
  console.log(`R1 ReferralRelationship pairs: ${r1.identities.ReferralRelationshipD2D.length}`);
  console.log(`R1 exact pair parity: ${d2dParityR1 ? "✅" : "❌"}`);
  console.log(`R2 DriverReferral pairs: ${r2.identities.DriverReferralD2D.length}`);
  console.log(`R2 ReferralRelationship pairs: ${r2.identities.ReferralRelationshipD2D.length}`);
  console.log(`R2 exact pair parity: ${d2dParityR2 ? "✅" : "❌"}`);
  console.log("\n=== Policies ===");
  console.log(`ROOT_DRIVER_STANDARD v1 count: ${rpStandard.length}  bps=${rpStandard[0]?.rootDriverBps}  baseType=${rpStandard[0]?.baseType}  ${rpOk ? "✅" : "❌"}`);
  console.log(`OwnershipPolicy default count: ${opDefault.length}  strategy=${opDefault[0]?.resolutionStrategy}  ${opOk ? "✅" : "❌"}`);
  console.log(`RevenuePolicy total rows: ${rp.length}  OwnershipPolicy total rows: ${op.length}`);
  console.log("\n=== Canonical identity consolidation ===");
  console.log(`mottapedro01@gmail.com (R2): ${canonicalPedro}   jln@gmail.com (R2): ${canonicalJoao}`);
  console.log(`legacy pedro.paulo.motta@mobility.com: ${legacyPedro}   legacy joao.luiz.brito@mobility.com: ${legacyJoao}   ${canonicalOk ? "✅" : "❌"}`);
  console.log("\n=== Referential integrity after R2 ===");
  for (const [label, orphans, ok] of fkTable) {
    console.log(`${label.padEnd(52)} orphans=${orphans}    ${ok}`);
  }

  // 8. Cleanup
  const admin2 = await connect(adminConn);
  await admin2.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DISPOSABLE_DB}' AND pid <> pg_backend_pid()`
  );
  await admin2.query(`DROP DATABASE IF EXISTS "${DISPOSABLE_DB}"`);
  await admin2.end();
  console.log("\n  ✅ disposable DB dropped");

  if (!allPass || !availUnique || !rpOk || !opOk || !canonicalOk || !fkOk || !d2dParityOk) {
    console.error("\n❌ IDEMPOTENCY PROOF FAILED");
    process.exit(1);
  }
  console.log("\n✅ IDEMPOTENCY PROOF PASSED");
}

async function snapshot(dbUrl) {
  const c = await connect(parseConn(dbUrl));
  const counts = {};
  const identities = {};
  const rows = {};

  const tableNames = [
    "User",
    "Driver",
    "Passenger",
    "Vehicle",
    "DriverAvailability",
    "DriverReferral",
    "ReferralRelationship",
    "RideRequest",
    "RideOffer",
    "DriverSkill",
    "Skill",
    "OwnershipSnapshot",
    "RevenuePolicy",
    "OwnershipPolicy",
  ];

  for (const t of tableNames) {
    const r = await c.query(`SELECT COUNT(*) AS c FROM "${t}"`);
    counts[t] = Number(r.rows[0].c);
  }

  // Natural-key identities
  identities.User = (await c.query(`SELECT email FROM "User" ORDER BY email`)).rows.map((x) => x.email);
  identities.Driver = (await c.query(`SELECT "userId" FROM "Driver" ORDER BY "userId"`)).rows.map((x) => x.userId);
  identities.Passenger = (await c.query(`SELECT "userId" FROM "Passenger" ORDER BY "userId"`)).rows.map((x) => x.userId);
  identities.Vehicle = (await c.query(`SELECT plate FROM "Vehicle" ORDER BY plate`)).rows.map((x) => x.plate);
  identities.DriverAvailability = (
    await c.query(`SELECT "driverId", "dayOfWeek" FROM "DriverAvailability" ORDER BY "driverId", "dayOfWeek"`)
  ).rows.map((x) => [x.driverId, x.dayOfWeek]);
  identities.DriverReferralD2D = (
    await c.query(`
      SELECT referrer_user.email AS "inviterEmail", referred_user.email AS "invitedEmail"
      FROM "DriverReferral" referral
      JOIN "Driver" referrer ON referrer.id = referral."referrerDriverId"
      JOIN "User" referrer_user ON referrer_user.id = referrer."userId"
      JOIN "Driver" referred ON referred.id = referral."referredDriverId"
      JOIN "User" referred_user ON referred_user.id = referred."userId"
      WHERE referral."isDirect" = true
      ORDER BY referrer_user.email, referred_user.email
    `)
  ).rows.map((x) => [x.inviterEmail, x.invitedEmail]);
  identities.ReferralRelationshipD2D = (
    await c.query(`
      SELECT inviter_user.email AS "inviterEmail", invited_user.email AS "invitedEmail"
      FROM "ReferralRelationship" relationship
      JOIN "Driver" inviter ON inviter.id = relationship."inviterId"
      JOIN "User" inviter_user ON inviter_user.id = inviter."userId"
      JOIN "Driver" invited ON invited.id = relationship."invitedId"
      JOIN "User" invited_user ON invited_user.id = invited."userId"
      WHERE relationship."inviterActorType" = 'DRIVER'
        AND relationship."invitedActorType" = 'DRIVER'
        AND relationship."flowType" = 'DRIVER_TO_DRIVER'
      ORDER BY inviter_user.email, invited_user.email
    `)
  ).rows.map((x) => [x.inviterEmail, x.invitedEmail]);
  identities.RevenuePolicy = (
    await c.query(`SELECT code, version FROM "RevenuePolicy" ORDER BY code, version`)
  ).rows.map((x) => [x.code, x.version]);
  identities.OwnershipPolicy = (
    await c.query(`SELECT code, version FROM "OwnershipPolicy" ORDER BY code, version`)
  ).rows.map((x) => [x.code, x.version]);

  rows.RevenuePolicy = (
    await c.query(`SELECT code, version, "rootDriverBps", "baseType" FROM "RevenuePolicy"`)
  ).rows;
  rows.OwnershipPolicy = (
    await c.query(`SELECT code, version, "resolutionStrategy" FROM "OwnershipPolicy"`)
  ).rows;

  await c.end();
  return { counts, identities, rows };
}

main().catch((e) => {
  console.error("PROOF ERROR:", e);
  process.exit(1);
});
