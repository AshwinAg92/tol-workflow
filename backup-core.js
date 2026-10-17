// Full-fidelity backup helpers shared by the server (download / email / automatic snapshots)
// and scripts/restore-backup.js. A backup is gzip(JSON): every table in the public schema,
// every row, with binary columns (uploaded files) as base64 so nothing is lost.
const zlib = require("zlib");

const qi = (n) => '"' + String(n).replace(/"/g, '""') + '"';

async function listTables(pool) {
  const { rows } = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
  return rows.map((r) => r.table_name);
}

function encodeValue(v) {
  if (Buffer.isBuffer(v)) return { $b64: v.toString("base64") };
  if (v instanceof Date) return { $date: v.toISOString() };
  return v;
}

// includeFiles=false drops binary columns (uploaded files) — used for the small automatic snapshots.
async function buildFullBackup(pool, { includeFiles = true } = {}) {
  const out = { format: "tol-backup-v1", created_at: new Date().toISOString(), includeFiles, tables: {} };
  for (const t of await listTables(pool)) {
    const cols = (await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [t])).rows;
    const keep = cols.filter((c) => includeFiles || c.data_type !== "bytea");
    if (!keep.length) continue;
    const { rows } = await pool.query(`SELECT ${keep.map((c) => qi(c.column_name)).join(", ")} FROM ${qi(t)}`);
    out.tables[t] = { columns: keep.map((c) => ({ name: c.column_name, type: c.data_type })), rows: rows.map((r) => { const o = {}; for (const k of Object.keys(r)) o[k] = encodeValue(r[k]); return o; }) };
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify(out)));
}

function decodeBackup(buf) {
  const json = JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
  if (json.format !== "tol-backup-v1") throw new Error("Not a TOL backup file");
  const dec = (v) => (v && typeof v === "object" && !Array.isArray(v) ? ("$b64" in v ? Buffer.from(v.$b64, "base64") : "$date" in v ? new Date(v.$date) : v) : v);
  for (const t of Object.values(json.tables)) t.rows = t.rows.map((r) => { const o = {}; for (const k of Object.keys(r)) o[k] = dec(r[k]); return o; });
  return json;
}

// Restores into an existing database (tables must already exist — start the app once to create them).
// replace=true empties each table first; otherwise existing rows are kept and duplicates skipped.
async function restoreBackup(pool, json, { replace = false } = {}) {
  const client = await pool.connect();
  const report = {};
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica"); // skip FK order problems while loading
    const existing = new Set(await listTables(pool));
    for (const [t, data] of Object.entries(json.tables)) {
      if (!existing.has(t)) { report[t] = "skipped (table missing)"; continue; }
      if (replace) await client.query(`DELETE FROM ${qi(t)}`);
      const live = new Set((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [t])).rows.map((r) => r.column_name));
      const cols = data.columns.map((c) => c.name).filter((c) => live.has(c));
      const jsonCols = new Set(data.columns.filter((c) => /^jsonb?$/.test(c.type)).map((c) => c.name));
      let n = 0;
      for (const row of data.rows) {
        const res = await client.query(`INSERT INTO ${qi(t)} (${cols.map(qi).join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")}) ON CONFLICT DO NOTHING`, cols.map((c) => { const v = row[c] === undefined ? null : row[c]; return v !== null && jsonCols.has(c) ? JSON.stringify(v) : v; }));
        n += res.rowCount;
      }
      report[t] = `${n}/${data.rows.length} rows`;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally { client.release(); }
  return report;
}

// Automatic safety copy taken the first time a NEW version of the app starts — before any
// database changes run — and kept (last 5) inside the database. Skipped silently on a fresh DB.
async function preUpgradeSnapshot(pool) {
  try {
    const sha = process.env.RAILWAY_GIT_COMMIT_SHA || "";
    if (!sha) return;
    await pool.query("CREATE TABLE IF NOT EXISTS data_snapshots (id SERIAL PRIMARY KEY, created_at TEXT NOT NULL, commit_sha TEXT, size_bytes INTEGER, data BYTEA)");
    const hasUsers = (await listTables(pool)).includes("users");
    if (!hasUsers) return;
    const last = (await pool.query("SELECT commit_sha FROM data_snapshots ORDER BY id DESC LIMIT 1")).rows[0];
    if (last && last.commit_sha === sha) return;
    const data = await buildFullBackup(pool, { includeFiles: false });
    await pool.query("INSERT INTO data_snapshots (created_at, commit_sha, size_bytes, data) VALUES ($1, $2, $3, $4)", [new Date().toISOString(), sha, data.length, data]);
    await pool.query("DELETE FROM data_snapshots WHERE id NOT IN (SELECT id FROM data_snapshots ORDER BY id DESC LIMIT 5)");
    console.log(`Pre-upgrade snapshot saved (${Math.round(data.length / 1024)} KB) before starting ${sha.slice(0, 7)}`);
  } catch (err) {
    console.error("Pre-upgrade snapshot failed (continuing startup):", err.message);
  }
}

module.exports = { buildFullBackup, decodeBackup, restoreBackup, preUpgradeSnapshot, listTables };
