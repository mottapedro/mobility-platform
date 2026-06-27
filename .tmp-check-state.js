require('dotenv/config');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    const cols = await pool.query(`SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns WHERE table_name IN ('RideOffer','RideRequest','ReferralRelationship','Settlement','RevenueSplit','OperationalZone','DriverOperationalZone') ORDER BY table_name, column_name`);
    console.log('COLUMNS:', cols.rows);
    const statusNewCount = await pool.query('SELECT count(*) FROM "RideOffer" WHERE "status" IS NULL');
    console.log('RideOffer status null count:', statusNewCount.rows[0].count);
    const hasStatusNew = await pool.query('SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2', ['RideOffer', 'status_new']);
    console.log('RideOffer.status_new exists:', hasStatusNew.rowCount > 0);
    const typeNames = await pool.query(`SELECT typname FROM pg_type WHERE typname IN ('RideOfferStatus_new','RideOfferStatus','RideStatus_new','RideStatus','DispatchCycleStage','DispatchStage') ORDER BY typname`);
    console.log('TYPES FOUND:', typeNames.rows.map(r => r.typname));
    const statuses = await pool.query('SELECT status, count(*) FROM "RideOffer" GROUP BY status ORDER BY status');
    console.log('RideOffer statuses:', statuses.rows);
    const reqStatuses = await pool.query('SELECT status, count(*) FROM "RideRequest" GROUP BY status ORDER BY status');
    console.log('RideRequest statuses:', reqStatuses.rows);
    const rrStatuses = await pool.query('SELECT count(*) FROM "RideOffer" WHERE status = $1', ['PENDING']);
    console.log('RideOffer PENDING count:', rrStatuses.rows[0].count);
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
})();