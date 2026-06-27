require('dotenv/config');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    const types = ['RideOfferStatus', 'RideStatus', 'DispatchStage', 'DispatchCycleStage', 'ReferralFlowType', 'MatchLevel'];
    for (const typeName of types) {
      try {
        const res = await pool.query(
          `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = $1 ORDER BY e.enumsortorder`,
          [typeName]
        );
        console.log(typeName + ':', res.rows.map(r => r.enumlabel).join(', '));
      } catch (e) {
        console.log(typeName + ' ERR:', e.message);
      }
    }
  } catch (error) {
    console.error(error);
  } finally {
    await pool.end();
  }
})();