const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const { TEAM } = require("./config");

// IMPORTANT: this file must live on a persistent Railway Volume, not the app's
// own project folder — Railway rebuilds the container filesystem from scratch
// on every deploy, so anything not on a mounted Volume gets wiped each time.
// Set DB_PATH to the Volume's mount path (e.g. /data/tol.db) in Railway's
// Variables tab. Falls back to a local file for running this on your own machine.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "tol.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
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
    advance INTEGER DEFAULT 0,
    assigned_to TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    title TEXT NOT NULL,
    due_date TEXT,
    assigned_to TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    notes TEXT,
    uploaded_at TEXT NOT NULL,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    team_id TEXT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    access_level TEXT NOT NULL DEFAULT 'staff',
    created_at TEXT NOT NULL,
    FOREIGN KEY (team_id) REFERENCES team(id)
  );
`);

// One-time migration: add new columns to the leads table if they don't exist yet.
// Safe to run every time the server starts — it only adds what's missing, never touches existing data.
const existingCols = db.prepare("PRAGMA table_info(leads)").all().map((c) => c.name);
const newCols = [
  ["venue", "TEXT"],
  ["occasion", "TEXT"],
  ["guest_range", "TEXT"],
  ["details", "TEXT"],
  ["how_heard", "TEXT"],
  ["whatsapp_optin", "INTEGER DEFAULT 0"],
];
newCols.forEach(([col, type]) => {
  if (!existingCols.includes(col)) {
    db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${type}`);
  }
});

// One-time seed: only runs if tables are empty, so restarting the server never wipes real data.
const leadCount = db.prepare("SELECT COUNT(*) AS c FROM leads").get().c;
const teamCount = db.prepare("SELECT COUNT(*) AS c FROM team").get().c;

if (teamCount === 0) {
  const insertTeam = db.prepare("INSERT INTO team (id, name, role) VALUES (?, ?, ?)");
  TEAM.forEach((m) => insertTeam.run(m.id, m.name, m.role));
}

if (leadCount === 0) {
  const insertLead = db.prepare(`
    INSERT INTO leads (id, name, phone, email, event_type, city, date, budget, stage, quote_amount, advance, assigned_to, created_at)
    VALUES (@id, @name, @phone, @email, @event_type, @city, @date, @budget, @stage, @quote_amount, @advance, @assigned_to, @created_at)
  `);
  const now = new Date().toISOString();
  const sample = [
    { id: uuid(), name: "Priya & Raj Sharma", phone: "+91 98765 43210", email: "priya.raj@example.com", event_type: "pheras", city: "Siliguri", date: "2026-09-14", budget: 150000, stage: "Confirmed", quote_amount: 145000, advance: 50000, assigned_to: "t2", created_at: now },
    { id: uuid(), name: "Anand Bhajan Sangeet Committee", phone: "+91 90000 11223", email: "committee@anandsangeet.org", event_type: "club", city: "Guwahati", date: "2026-08-22", budget: 200000, stage: "Quoted", quote_amount: 185000, advance: 0, assigned_to: "t1", created_at: now },
    { id: uuid(), name: "Meera Foundation", phone: "+91 99887 65432", email: "events@meerafoundation.in", event_type: "jam", city: "Kolkata", date: "2026-10-05", budget: 90000, stage: "Follow-up", quote_amount: 85000, advance: 0, assigned_to: "t2", created_at: now },
    { id: uuid(), name: "Kapoor Family (Naming Ceremony)", phone: "+91 91234 56789", email: "kapoorfamily@example.com", event_type: "pheras", city: "Siliguri", date: "2026-09-01", budget: 60000, stage: "New", quote_amount: null, advance: 0, assigned_to: null, created_at: now },
    { id: uuid(), name: "Sunrise Housing Society", phone: "+91 98111 22334", email: "secretary@sunrisehs.in", event_type: "jam", city: "Siliguri", date: "2026-07-30", budget: 70000, stage: "Completed", quote_amount: 68000, advance: 68000, assigned_to: "t3", created_at: now },
    { id: uuid(), name: "Shanti Path Trust", phone: "+91 96543 21098", email: "trust@shantipath.org", event_type: "satsang", city: "Kolkata", date: "2026-08-10", budget: 55000, stage: "Quoted", quote_amount: 55000, advance: 0, assigned_to: "t1", created_at: now },
    { id: uuid(), name: "Choudhury Family", phone: "+91 95432 10987", email: "choudhury.family@example.com", event_type: "shraddhanjali", city: "Siliguri", date: "2026-09-20", budget: 50000, stage: "New", quote_amount: null, advance: 0, assigned_to: null, created_at: now },
  ];
  sample.forEach((l) => insertLead.run(l));

  // A few sample tasks tied to the confirmed booking, so Task Management isn't empty on first look.
  const confirmedLead = sample.find((l) => l.stage === "Confirmed");
  const insertTask = db.prepare(`
    INSERT INTO tasks (id, lead_id, title, due_date, assigned_to, done, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertTask.run(uuid(), confirmedLead.id, "Confirm venue booking", "2026-08-20", "t3", 1, now);
  insertTask.run(uuid(), confirmedLead.id, "Finalise Musical Pheras playlist", "2026-09-05", "t1", 0, now);
  insertTask.run(uuid(), confirmedLead.id, "Send final headcount to caterer", "2026-09-10", "t2", 0, now);
}

// One-time seed: create the first login (admin) account if none exist yet.
// Username/password come from env vars so Ashwin can set his own; falls back
// to a default that MUST be changed via the Team tab after first login.
const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
if (userCount === 0) {
  const username = process.env.ADMIN_USERNAME || "ashwin";
  const password = process.env.ADMIN_PASSWORD || "changeme123";
  const passwordHash = bcrypt.hashSync(password, 10);
  const firstTeamMember = db.prepare("SELECT id FROM team LIMIT 1").get();
  db.prepare(`
    INSERT INTO users (id, team_id, username, password_hash, access_level, created_at)
    VALUES (?, ?, ?, ?, 'admin', ?)
  `).run(uuid(), firstTeamMember ? firstTeamMember.id : null, username, passwordHash, new Date().toISOString());
  console.log(`Seeded initial admin login — username: "${username}". Set ADMIN_USERNAME/ADMIN_PASSWORD env vars to control this, or change the password after logging in.`);
}

module.exports = db;
