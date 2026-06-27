require('dotenv/config');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    const statuses = await pool.query('SELECT status, count(*) FROM "RideOffer" GROUP BY status ORDER BY status');
    console.log('RideOffer statuses:', statuses.rows);
    const nullCount = await pool.query('SELECT count(*) FROM "RideOffer" WHERE status IS NULL');
    console.log('RideOffer null status rows:', nullCount.rows[0].count);
    const total = await pool.query('SELECT count(*) FROM "RideOffer"');
    console.log('RideOffer total rows:', total.rows[0].count);
    const distinct = await pool.query('SELECT DISTINCT status::text AS status_text FROM "RideOffer" ORDER BY status_text');
    console.log('RideOffer distinct text statuses:', distinct.rows.map(r => r.status_text));
    const d = await pool.query('SELECT enumlabel FROM pg_enum WHERE enumtypid = ' +
      '(SELECT oid FROM pg_type WHERE typname = $1) ORDER BY enumsortorder', ['RideOfferStatus']);
    console.log('RideOfferStatus enum values:', d.rows.map(r => r.enumlabel));
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
})();