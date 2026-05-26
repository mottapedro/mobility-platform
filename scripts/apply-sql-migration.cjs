// Generic SQL migration runner.
// Usage:  node scripts/apply-sql-migration.cjs <path/to/migration.sql>
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function run() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/apply-sql-migration.cjs <migration.sql>');
    process.exit(1);
  }
  const file = path.resolve(arg);
  if (!fs.existsSync(file)) {
    console.error('File not found:', file);
    process.exit(1);
  }
  const sql = fs.readFileSync(file, 'utf8');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    console.log('▶ Applying', path.basename(path.dirname(file)), '/', path.basename(file));
    await client.query(sql);
    console.log('✅ Migration applied');
  } catch (e) {
    console.error('❌ Migration error:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}
run();
