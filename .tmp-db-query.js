require('dotenv/config');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;");
    console.log('TABLES');
    console.log(JSON.stringify(tables.rows, null, 2));
    const columns = await pool.query("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name IN ('RideRequest','RideOffer','ReferralRelationship','Settlement','RevenueSplit','OperationalZone','DriverOperationalZone') ORDER BY table_name, ordinal_position;");
    console.log('COLUMNS');
    console.log(JSON.stringify(columns.rows, null, 2));
    const migrations = await pool.query("SELECT * FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST LIMIT 50;");
    console.log('MIGRATIONS');
    console.log(JSON.stringify(migrations.rows, null, 2));
    const migrationColumns = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '_prisma_migrations' ORDER BY ordinal_position;");
    console.log('MIGRATION_COLUMNS');
    console.log(JSON.stringify(migrationColumns.rows, null, 2));
  } catch (error) {
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
