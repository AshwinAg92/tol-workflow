#!/usr/bin/env node
// Usage: DATABASE_URL=postgres://... node scripts/restore-backup.js <backup.json.gz> [--replace]
// Start the app once against the target database first so the tables exist.
const fs = require("fs");
const { Pool } = require("pg");
const { decodeBackup, restoreBackup } = require("../backup-core");
(async () => {
  const file = process.argv[2];
  if (!file || !process.env.DATABASE_URL) { console.error("Usage: DATABASE_URL=... node scripts/restore-backup.js <backup.json.gz> [--replace]"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false } });
  const report = await restoreBackup(pool, decodeBackup(fs.readFileSync(file)), { replace: process.argv.includes("--replace") });
  console.log(report);
  await pool.end();
})().catch((e) => { console.error("Restore failed:", e.message); process.exit(1); });
