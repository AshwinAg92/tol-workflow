const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const { TEAM } = require("./config");

// Real managed Postgres (Railway's own database service) instead of a SQLite
// file on disk — this survives redeploys reliably, unlike an app-local file
// or a Railway Volume (which we found doesn't reliably attach on this project).
// DATABASE_URL is provided automatically by Railway's Postgres plugin.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
    ? { rejectUnauthorized: false }
    : false,
});

async function setup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      event_type TEXT NOT NULL,
      city TEXT,
      date TEXT,
      budget INTEGER,
      stage TEXT NOT NULL DEFAULT 'New',
      quote_amount INTEGER,
      final_amount INTEGER,
      advance INTEGER DEFAULT 0,
      assigned_to TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      venue TEXT,
      occasion TEXT,
      guest_range TEXT,
      details TEXT,
      how_heard TEXT,
      whatsapp_optin INTEGER DEFAULT 0,
      alt_date TEXT
    );

    CREATE TABLE IF NOT EXISTS team (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      phone TEXT,
      email TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id),
      title TEXT NOT NULL,
      due_date TEXT,
      assigned_to TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id),
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      notes TEXT,
      uploaded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES team(id),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      access_level TEXT NOT NULL DEFAULT 'staff',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_assignments (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id),
      team_id TEXT REFERENCES team(id),
      status TEXT NOT NULL DEFAULT 'pending',
      paid INTEGER NOT NULL DEFAULT 0,
      fee_amount INTEGER,
      created_at TEXT NOT NULL,
      responded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS event_messages (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id),
      author_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id),
      subject TEXT,
      body TEXT NOT NULL,
      amount INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id),
      head TEXT NOT NULL,
      amount INTEGER NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Migration: "Quoted" is no longer a distinct stage — a lead moves straight
  // to "Follow-up" once quoted. Move any existing Quoted leads forward so
  // nothing gets stuck on a stage that no longer exists in the UI.
  await pool.query(`UPDATE leads SET stage = 'Follow-up' WHERE stage = 'Quoted'`);

  // One-time seed: only runs if tables are empty, so restarting the server never wipes real data.
  const teamCount = (await pool.query("SELECT COUNT(*) AS c FROM team")).rows[0].c;
  if (Number(teamCount) === 0) {
    for (const m of TEAM) {
      await pool.query("INSERT INTO team (id, name, role) VALUES ($1, $2, $3)", [m.id, m.name, m.role]);
    }
  }

  const leadCount = (await pool.query("SELECT COUNT(*) AS c FROM leads")).rows[0].c;
  if (Number(leadCount) === 0) {
    const now = new Date().toISOString();
    const sample = [
      { id: uuid(), name: "Priya & Raj Sharma", phone: "+91 98765 43210", email: "priya.raj@example.com", event_type: "pheras", city: "Siliguri", date: "2026-09-14", budget: 150000, stage: "Confirmed", quote_amount: 145000, advance: 50000, assigned_to: "t2" },
      { id: uuid(), name: "Anand Bhajan Sangeet Committee", phone: "+91 90000 11223", email: "committee@anandsangeet.org", event_type: "club", city: "Guwahati", date: "2026-08-22", budget: 200000, stage: "Follow-up", quote_amount: 185000, advance: 0, assigned_to: "t1" },
      { id: uuid(), name: "Meera Foundation", phone: "+91 99887 65432", email: "events@meerafoundation.in", event_type: "jam", city: "Kolkata", date: "2026-10-05", budget: 90000, stage: "Follow-up", quote_amount: 85000, advance: 0, assigned_to: "t2" },
      { id: uuid(), name: "Kapoor Family (Naming Ceremony)", phone: "+91 91234 56789", email: "kapoorfamily@example.com", event_type: "pheras", city: "Siliguri", date: "2026-09-01", budget: 60000, stage: "New", quote_amount: null, advance: 0, assigned_to: null },
      { id: uuid(), name: "Sunrise Housing Society", phone: "+91 98111 22334", email: "secretary@sunrisehs.in", event_type: "jam", city: "Siliguri", date: "2026-07-30", budget: 70000, stage: "Completed", quote_amount: 68000, advance: 68000, assigned_to: "t3" },
      { id: uuid(), name: "Shanti Path Trust", phone: "+91 96543 21098", email: "trust@shantipath.org", event_type: "satsang", city: "Kolkata", date: "2026-08-10", budget: 55000, stage: "Follow-up", quote_amount: 55000, advance: 0, assigned_to: "t1" },
      { id: uuid(), name: "Choudhury Family", phone: "+91 95432 10987", email: "choudhury.family@example.com", event_type: "shraddhanjali", city: "Siliguri", date: "2026-09-20", budget: 50000, stage: "New", quote_amount: null, advance: 0, assigned_to: null },
    ];
    for (const l of sample) {
      await pool.query(`
        INSERT INTO leads (id, name, phone, email, event_type, city, date, budget, stage, quote_amount, advance, assigned_to, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [l.id, l.name, l.phone, l.email, l.event_type, l.city, l.date, l.budget, l.stage, l.quote_amount, l.advance, l.assigned_to, now]);
    }

    const confirmedLead = sample.find((l) => l.stage === "Confirmed");
    const tasks = [
      { title: "Confirm venue booking", due: "2026-08-20", assignee: "t3", done: 1 },
      { title: "Finalise Musical Pheras playlist", due: "2026-09-05", assignee: "t1", done: 0 },
      { title: "Send final headcount to caterer", due: "2026-09-10", assignee: "t2", done: 0 },
    ];
    for (const t of tasks) {
      await pool.query(`
        INSERT INTO tasks (id, lead_id, title, due_date, assigned_to, done, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [uuid(), confirmedLead.id, t.title, t.due, t.assignee, t.done, now]);
    }
  }

  // One-time seed: create the first login (admin) account if none exist yet.
  // Username/password come from env vars so Ashwin can set his own; falls back
  // to a default that MUST be changed via the Team tab after first login.
  const userCount = (await pool.query("SELECT COUNT(*) AS c FROM users")).rows[0].c;
  if (Number(userCount) === 0) {
    const username = process.env.ADMIN_USERNAME || "ashwin";
    const password = process.env.ADMIN_PASSWORD || "changeme123";
    const passwordHash = bcrypt.hashSync(password, 10);
    const firstTeamMember = (await pool.query("SELECT id FROM team LIMIT 1")).rows[0];
    await pool.query(`
      INSERT INTO users (id, team_id, username, password_hash, access_level, created_at)
      VALUES ($1, $2, $3, $4, 'admin', $5)
    `, [uuid(), firstTeamMember ? firstTeamMember.id : null, username, passwordHash, new Date().toISOString()]);
    console.log(`Seeded initial admin login — username: "${username}". Set ADMIN_USERNAME/ADMIN_PASSWORD env vars to control this, or change the password after logging in.`);
  }
}

const ready = setup().catch((err) => {
  console.error("Database setup failed:", err);
  process.exit(1);
});

module.exports = { pool, ready };
