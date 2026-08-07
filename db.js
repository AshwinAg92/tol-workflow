const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const { TEAM, PACKAGES, PRICING } = require("./config");

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

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id),
      amount INTEGER NOT NULL,
      payment_date TEXT NOT NULL,
      payment_mode TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES team(id),
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_notifications (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      assignment_id TEXT,
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

  // Real migrations for columns added AFTER the tables already existed in
  // production — CREATE TABLE IF NOT EXISTS is a no-op for existing tables,
  // so any new column must be added explicitly here or it silently never
  // exists in the live database (this bit us with final_amount and alt_date).
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS final_amount INTEGER`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS alt_date TEXT`);
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS team_id TEXT REFERENCES team(id)`);
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_date TEXT`);
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_mode TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS advance_date TEXT`);
  await pool.query(`ALTER TABLE team ADD COLUMN IF NOT EXISTS specialty TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions TEXT`);
  await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS lead_id TEXT REFERENCES leads(id)`);
  await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS from_team_id TEXT REFERENCES team(id)`);
  await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'info'`);
  await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'`);
  // team_id nullable already — NULL means "for admin" rather than a specific performer.
  await pool.query(`ALTER TABLE event_assignments ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_performer INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS event_time TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS soundcheck_time TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_seed INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS pcs TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS whatsapp_number TEXT`);
  await pool.query(`UPDATE leads SET event_type = 'jam_pheras_both' WHERE event_type = 'both'`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS duration TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS combo_group_id TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_combo_primary INTEGER NOT NULL DEFAULT 0`);
  // Reimbursements: managers can submit these for artists without full Accounts
  // access, but they only become real committed expenses once an admin approves
  // them (with payment details) — approved defaults to 1 so every expense created
  // the normal (admin-only) way is unaffected by this gate.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'expense'`);
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS approved INTEGER NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS requested_by TEXT`);
  // Documents used to live as files on the container's local disk, which Railway
  // wipes on every redeploy — silently losing every upload. They now live as
  // bytes directly in Postgres instead, which is what the app already relies on
  // for everything else surviving redeploys. stored_name is no longer written to.
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`);
  await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS mime_type TEXT`);
  await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_data BYTEA`);
  await pool.query(`ALTER TABLE documents ALTER COLUMN stored_name DROP NOT NULL`);
  // Managers now share this feed with admin (artist accept/decline, cancellation
  // requests, event chat, confirmed events) — but new sales-lead alerts are an
  // admin-only concern, so every row is tagged with who it's for. Existing rows
  // default to 'coordination' since they were all manager-relevant event
  // activity before this column existed.
  await pool.query(`ALTER TABLE admin_notifications ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'coordination'`);
  // Backfill: notifications created before the audience column existed default to
  // 'coordination' (fine for artist-response/cancellation ones), but any that are
  // actually new-lead alerts need reclassifying to 'admin' so they stop showing to
  // managers. Idempotent — only touches rows still mistagged as coordination.
  await pool.query(`UPDATE admin_notifications SET audience = 'admin' WHERE message LIKE 'New query:%' AND audience = 'coordination'`);
  const demoLeadNames = ["Priya & Raj Sharma", "Anand Bhajan Sangeet Committee", "Meera Foundation", "Kapoor Family (Naming Ceremony)", "Sunrise Housing Society", "Shanti Path Trust", "Choudhury Family"];
  const seedFlaggedCount = (await pool.query("SELECT COUNT(*) AS c FROM leads WHERE is_seed = 1")).rows[0].c;
  if (Number(seedFlaggedCount) === 0) {
    // Backfill for databases seeded before is_seed existed. Guarded to run only
    // once (no lead flagged yet) so it can never later mislabel a real lead that
    // happens to share one of these names as demo data.
    await pool.query("UPDATE leads SET is_seed = 1 WHERE name = ANY($1::text[])", [demoLeadNames]);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sticky_notes (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      content TEXT,
      updated_at TEXT
    );
  `);

  // Content management for the public marketing site — lets the admin edit
  // FAQs, testimonials, press mentions, public team bios, cities performed,
  // service blurbs, hero banners, and stat overrides without touching code.
  // JSONB keeps each block's shape flexible without a table-per-content-type.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_content (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TEXT
    );
  `);
  // Gallery images live in Postgres (bytea) for the same reason documents do —
  // Railway's container disk is wiped on every redeploy.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_gallery_images (
      id TEXT PRIMARY KEY,
      caption TEXT,
      mime_type TEXT,
      file_data BYTEA,
      sort_order INTEGER NOT NULL DEFAULT 0,
      uploaded_at TEXT NOT NULL
    );
  `);
  // 'category' lets one image store serve both the public Gallery and the
  // Press clippings strip — same reliable Postgres-bytea storage, just tagged
  // by where it's meant to show up.
  await pool.query(`ALTER TABLE site_gallery_images ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'gallery'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS temp_artists (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id),
      name TEXT NOT NULL,
      description TEXT,
      phone TEXT,
      created_at TEXT NOT NULL
    );
  `);
  await pool.query(`ALTER TABLE temp_artists ADD COLUMN IF NOT EXISTS expense_id TEXT REFERENCES expenses(id) ON DELETE SET NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      actor TEXT,
      created_at TEXT NOT NULL
    );
  `);
  await pool.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_templates (
      key TEXT PRIMARY KEY,
      template TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const defaultTemplates = {
    followup: "Hi {firstName}, just following up on your enquiry with Together, Out Loud for {experience}{dateClause}. Let us know if you have any questions or would like to go ahead — happy to help!",
    tentative_followup: "Hi {firstName}, following up on your {experience}{dateClause} — we've tentatively held this date for you with Together, Out Loud. Let us know if you'd like to go ahead so we can lock it in for you!",
    confirmed: "Hi {firstName}, wonderful news — your event with Together, Out Loud ({experience}) on {date}{cityClause} is now confirmed!{amountLine}\n\nWe look forward to creating a memorable experience with you. — Together, Out Loud",
    document_share: "Hi! Sharing the {label} for your event with Together, Out Loud: {link}",
  };
  for (const [key, template] of Object.entries(defaultTemplates)) {
    await pool.query(
      `INSERT INTO message_templates (key, template, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      [key, template, new Date().toISOString()]
    );
  }

  // One quotation template per package/experience — same content Ashwin already had,
  // just split out so each experience can be worded differently going forward.
  const quoteBody = (sessionConditions, includeDuration = true, includeFormat = true) => `🎶 *QUOTATION — {formatUpper}*
_Together, Out Loud_

Hi {firstName}! Thank you for considering us for your event — here are the details of our offering. 💛

📍 *Location:* {location}
📅 *Date:* {date}
👥 *Guests:* {guests}
${includeDuration ? "⏱️ *Duration:* {duration}\n" : ""}
*PERFORMANCE DETAILS*
🎸 Pcs (No. of Musicians): {setPieces}
${includeFormat ? "🎤 Format: {formatType}\n" : ""}💰 *Performance Charges: {amountLine}*

*SESSION CONDITIONS*
${sessionConditions}

*EXCLUSIONS*
• Stage Setup
• Lights & Sound
• Travel, Accommodation (from previous city of performance — informed 2 months prior)
• Food for the Team (all meals)
• Airport/Station Transfers

*TERMS*
• An advance payment is required to confirm and block the date — booking is confirmed only upon receipt.
• This quotation is valid for 7 days from the date of issue; charges are subject to revision after.
• Strictly no food or beverages during the session.

We'd love to make your event a truly memorable, soul-stirring experience. 🎶✨

Warmly,
*Together, Out Loud*
📷 Instagram: https://www.instagram.com/togetheroutloudclub`;
  const onePheraCondition = `1️⃣ No food, alcohol, or beverages to be consumed or served during the session.`;
  const twoConditions = `1️⃣ No food, alcohol, or beverages to be consumed or served during the session.\n2️⃣ Session duration will be 75 to 90 minutes.`;
  for (const pkg of PACKAGES) {
    const isPheras = pkg.id === "pheras";
    await pool.query(
      `INSERT INTO message_templates (key, template, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      [`quotation_${pkg.id}`, quoteBody(isPheras ? onePheraCondition : twoConditions, !isPheras, !isPheras), new Date().toISOString()]
    );
  }

  // One-time fix: Musical Pheras' quotation template shouldn't state a fixed
  // duration -- a pheras ceremony runs as long as the ceremony itself takes,
  // not a fixed 75-90 minute session. Strip that line from the live template
  // if it's still there, without touching anything already customized further.
  const pherasDurationFixFlag = (await pool.query("SELECT 1 FROM message_templates WHERE key = 'pheras_duration_removed'")).rows[0];
  if (!pherasDurationFixFlag) {
    await pool.query(`
      UPDATE message_templates
      SET template = REPLACE(template, '⏱️ *Duration:* {duration}\n', ''), updated_at = $1
      WHERE key = 'quotation_pheras'
    `, [new Date().toISOString()]);
    await pool.query(
      `INSERT INTO message_templates (key, template, updated_at) VALUES ('pheras_duration_removed', '1', $1) ON CONFLICT (key) DO NOTHING`,
      [new Date().toISOString()]
    );
  }

  // Follow-up one-time fix: also strip the Private/Public Format line from
  // Musical Pheras -- separate flag since the duration fix above already ran
  // and consumed its own flag on an earlier deploy.
  const pherasFormatFixFlag = (await pool.query("SELECT 1 FROM message_templates WHERE key = 'pheras_format_removed'")).rows[0];
  if (!pherasFormatFixFlag) {
    await pool.query(`
      UPDATE message_templates
      SET template = REPLACE(template, '🎤 Format: {formatType}\n', ''), updated_at = $1
      WHERE key = 'quotation_pheras'
    `, [new Date().toISOString()]);
    await pool.query(
      `INSERT INTO message_templates (key, template, updated_at) VALUES ('pheras_format_removed', '1', $1) ON CONFLICT (key) DO NOTHING`,
      [new Date().toISOString()]
    );
  }

  // One-time fix: quotation templates seeded before this greeted with a bare
  // "Hi!" and no name. Add {firstName} to any template still using the
  // original wording, without touching anything already customized further.
  const greetingFixFlag = (await pool.query("SELECT 1 FROM message_templates WHERE key = 'quote_greeting_firstname_applied'")).rows[0];
  if (!greetingFixFlag) {
    await pool.query(`
      UPDATE message_templates
      SET template = REPLACE(template, 'Hi! Thank you for considering us', 'Hi {firstName}! Thank you for considering us'),
          updated_at = $1
      WHERE key LIKE 'quotation_%' AND template LIKE 'Hi! Thank you for considering us%'
    `, [new Date().toISOString()]);
    await pool.query(
      `INSERT INTO message_templates (key, template, updated_at) VALUES ('quote_greeting_firstname_applied', '1', $1) ON CONFLICT (key) DO NOTHING`,
      [new Date().toISOString()]
    );
  }

  await pool.query(
    `INSERT INTO message_templates (key, template, updated_at) VALUES ('pricing_matrix', $1, $2) ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(PRICING), new Date().toISOString()]
  );

  // One-time cleanup: activity_log had no lead_id link before this column
  // existed, so entries logged against the demo leads were never removed by
  // "Clear demo data" (which could only scope by lead_id). This purges any
  // pre-existing rows that mention a demo lead by name, exactly once — guarded
  // by a flag rather than re-run on every boot, so it can never later misfire
  // against a real lead that happens to share one of these names.
  const cleanupFlag = (await pool.query("SELECT 1 FROM message_templates WHERE key = 'activity_demo_cleanup_done'")).rows[0];
  if (!cleanupFlag) {
    for (const demoName of demoLeadNames) {
      await pool.query("DELETE FROM activity_log WHERE message LIKE $1", [`%${demoName}%`]);
    }
    await pool.query(
      `INSERT INTO message_templates (key, template, updated_at) VALUES ('activity_demo_cleanup_done', '1', $1) ON CONFLICT (key) DO NOTHING`,
      [new Date().toISOString()]
    );
  }

  // One-time upgrade: the "confirmed" client message template gained several
  // new auto-filled fields (location, occasion, pcs, duration, fee, advance,
  // outstanding). Push the new default into place once for anyone still on
  // the original seed text — but never touch it again after this, so a
  // deliberate later edit in Settings is never overwritten.
  const confirmedTplFlag = (await pool.query("SELECT 1 FROM message_templates WHERE key = 'confirmed_template_v2_applied'")).rows[0];
  if (!confirmedTplFlag) {
    const newConfirmedDefault = "Hi {firstName}, wonderful news — your event with Together, Out Loud ({experience}) on {date}{cityClause} is now confirmed!{amountLine}\n\nWe are pleased to confirm our booking for: {clientName}\nLocation: {location}\nDate: {date}\nOccasion: {occasion}\nSet: {pieces} Pieces\nDuration: {duration}\nPerformance Fee: ₹{performanceFee}/-\nAdvance: ₹{advance}/-\nOutstanding: ₹{outstanding}\n\nAs discussed, we request your support in arranging the travel, accommodation, meals, local transfers, and venue technical requirements.\nWe look forward to creating a soulful and memorable musical experience with you and your guests.\n\nWarm regards,\nTogether, Out Loud";
    await pool.query(`
      INSERT INTO message_templates (key, template, updated_at) VALUES ('confirmed', $1, $2)
      ON CONFLICT (key) DO UPDATE SET template = $1, updated_at = $2
    `, [newConfirmedDefault, new Date().toISOString()]);
    await pool.query(
      `INSERT INTO message_templates (key, template, updated_at) VALUES ('confirmed_template_v2_applied', '1', $1) ON CONFLICT (key) DO NOTHING`,
      [new Date().toISOString()]
    );
  }

  // One-time migration: bring any existing single "advance" amount into the new
  // payments ledger as its first entry, so nothing is lost when moving from a
  // single advance field to a full multi-payment ledger.
  const leadsWithAdvance = (await pool.query(
    `SELECT id, advance, advance_date, created_at FROM leads WHERE advance IS NOT NULL AND advance > 0`
  )).rows;
  for (const l of leadsWithAdvance) {
    const already = (await pool.query("SELECT id FROM payments WHERE lead_id = $1 LIMIT 1", [l.id])).rows[0];
    if (!already) {
      await pool.query(`
        INSERT INTO payments (id, lead_id, amount, payment_date, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [uuid(), l.id, l.advance, l.advance_date || l.created_at.slice(0, 10), new Date().toISOString()]);
    }
  }

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
        INSERT INTO leads (id, name, phone, email, event_type, city, date, budget, stage, quote_amount, advance, assigned_to, created_at, is_seed)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1)
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
