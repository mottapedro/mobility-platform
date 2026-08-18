require('dotenv/config');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    const types = ['RideOfferStatus', 'RideStatus', 'DispatchCycleStage', 'ReferralFlowType', 'MatchLevel'];
    for (const type of types) {
      try {
        const res = await pool.query(`SELECT enumlabel FROM pg_enum WHERE enumtypid = $1::regtype ORDER BY enumsortorder`, [type]);
        console.log('TYPE', type, res.rows.map(r => r.enumlabel).join(', '));
      } catch (e) {
        console.log('TYPE ERR', type, e.message);
      }
    }

    const rows = await pool.query('SELECT status, count(*) FROM "RideOffer" GROUP BY status ORDER BY status');
    console.log('RideOffer status counts:', rows.rows);
    const rr = await pool.query('SELECT status, count(*) FROM "RideRequest" GROUP BY status ORDER BY status');
    console.log('RideRequest status counts:', rr.rows);
    const cols = await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('RideRequest','RideOffer','ReferralRelationship','Settlement','RevenueSplit','OperationalZone','DriverOperationalZone') ORDER BY table_name, column_name");
    console.log('columns:', cols.rows);
  } catch (error) {
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();