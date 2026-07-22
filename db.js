const Database = require("better-sqlite3");
const path = require("path");
const { v4: uuid } = require("uuid");
const { TEAM } = require("./config");

const db = new Database(path.join(__dirname, "tol.db"));
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
`);

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

module.exports = db;
