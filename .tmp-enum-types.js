require('dotenv/config');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    const res = await pool.query(`SELECT typname, typtype, typcategory, oid FROM pg_type WHERE typname ILIKE '%rideofferstatus%' OR typname ILIKE '%ridestatus%' OR typname ILIKE '%dispatchcyclestage%' OR typname ILIKE '%referralflowtype%' OR typname ILIKE '%dispatchstage%' OR typname ILIKE '%matchlevel%' ORDER BY typname`);
    console.log('TYPES', res.rows);
    const enumTypes = ['RideOfferStatus','RideStatus','DispatchCycleStage','ReferralFlowType','DispatchStage','MatchLevel'];
    for (const typeName of enumTypes) {
      try {
        const res2 = await pool.query(`SELECT enumlabel FROM pg_enum WHERE enumtypid = $1::regtype ORDER BY enumsortorder`, [typeName]);
        console.log(typeName, res2.rows.map(r => r.enumlabel).join(', '));
      } catch (e) {
        console.log('FAILED', typeName, e.message);
      }
    }
    const typeNames = await pool.query(`SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns WHERE table_name IN ('RideRequest','RideOffer') ORDER BY table_name, column_name`);
    console.log('COLUMN TYPES', typeNames.rows);
  } catch (error) {
    console.error(error);
  } finally {
    await pool.end();
  }
})();