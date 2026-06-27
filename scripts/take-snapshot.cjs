require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const backupDir = path.join(__dirname, '../backups');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

const backupFile = path.join(backupDir, 'pre-reconciliation.sql');

try {
  console.log(`Starting pg_dump to ${backupFile}...`);
  // pg_dump supports connection strings directly
  execSync(`pg_dump "${databaseUrl}" -f "${backupFile}"`, { stdio: 'inherit' });
  console.log("✅ Backup completed successfully.");
} catch (error) {
  console.error("❌ Backup failed:", error.message);
  process.exit(1);
}
