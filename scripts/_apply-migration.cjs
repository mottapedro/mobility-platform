require('dotenv').config();
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
async function run() {
  await client.connect();
  await client.query('ALTER TABLE "RideRequest" ADD COLUMN IF NOT EXISTS "operationalCutoffAt" TIMESTAMP(3)');
  const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='RideRequest' AND column_name='operationalCutoffAt'`);
  console.log('Column rows:', res.rowCount, JSON.stringify(res.rows));
  await client.end();
}
run().catch(e => { console.error('ERR:', e.message); process.exit(1); });
