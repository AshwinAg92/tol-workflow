try { require("dotenv").config(); } catch (e) { /* .env is optional */ }
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { v4: uuid } = require("uuid");
const { pool, ready } = require("./db");
const { STAGES, PACKAGES, ADDONS, PRICING, TEAM, EXPERIENCES, OCCASIONS, GUEST_RANGES, HOW_HEARD } = require("./config");

// ---------- Auth ----------
// Simple signed-cookie sessions (no extra session-store dependency needed).
// SESSION_SECRET should be set in Railway's Variables tab in production —
// falls back to a fixed dev value so local runs still work.
const SESSION_SECRET = process.env.SESSION_SECRET || "tol-dev-secret-change-me";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function signValue(value) {
  const h = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
  return `${value}.${h}`;
}
function unsignValue(signed) {
  const idx = signed.lastIndexOf(".");
  if (idx === -1) return null;
  const value = signed.slice(0, idx);
  const h = signed.slice(idx + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
  if (h.length !== expected.length) return null;
  try {
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(expected)) ? value : null;
  } catch {
    return null;
  }
}
async function getSessionUser(req) {
  const token = parseCookies(req)["tol_session"];
  if (!token) return null;
  const value = unsignValue(token);
  if (!value) return null;
  try {
    const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    const { rows } = await pool.query(
      "SELECT id, username, access_level, team_id FROM users WHERE id = $1",
      [payload.uid]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}
function setSessionCookie(res, userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_MAX_AGE_MS })).toString("base64url");
  const token = signValue(payload);
  res.setHeader("Set-Cookie", `tol_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `tol_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}
async function requireAuth(req, res, next) {
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.access_level !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}

const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${uuid()}-${file.originalname}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

const packageName = (id) => PACKAGES.find((p) => p.id === id)?.name || id;

// ---------- Auth routes ----------
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password are required" });
  const { rows } = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Incorrect username or password" });
  }
  setSessionCookie(res, user.id);
  res.json({ id: user.id, username: user.username, accessLevel: user.access_level });
});

app.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

app.get("/api/auth/me", async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json({ id: user.id, username: user.username, accessLevel: user.access_level });
});

// ---------- User accounts (admin only) — add teammates with their own login ----------
app.get("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT users.id, users.username, users.access_level, users.team_id, team.name AS team_name, team.role AS team_role
    FROM users LEFT JOIN team ON team.id = users.team_id
    ORDER BY users.created_at ASC
  `);
  res.json(rows);
});

app.post("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const { name, roleTitle, phone, specialty, username, password, accessLevel, existingTeamId } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password are required" });
  if (!existingTeamId && !name) return res.status(400).json({ error: "Name is required for a new team member" });
  if (!["admin", "staff", "performer"].includes(accessLevel)) return res.status(400).json({ error: "accessLevel must be 'admin', 'staff', or 'performer'" });
  const existingUser = (await pool.query("SELECT id FROM users WHERE username = $1", [username])).rows[0];
  if (existingUser) return res.status(400).json({ error: "That username is already taken" });

  let teamId = existingTeamId;
  if (teamId) {
    const member = (await pool.query("SELECT id FROM team WHERE id = $1", [teamId])).rows[0];
    if (!member) return res.status(400).json({ error: "That team member no longer exists" });
    const alreadyHasLogin = (await pool.query("SELECT id FROM users WHERE team_id = $1", [teamId])).rows[0];
    if (alreadyHasLogin) return res.status(400).json({ error: "That team member already has a login" });
  } else {
    teamId = uuid();
    await pool.query("INSERT INTO team (id, name, role, phone, specialty) VALUES ($1, $2, $3, $4, $5)", [teamId, name, roleTitle || null, phone || null, specialty || null]);
  }
  const userId = uuid();
  const passwordHash = bcrypt.hashSync(password, 10);
  await pool.query(`
    INSERT INTO users (id, team_id, username, password_hash, access_level, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [userId, teamId, username, passwordHash, accessLevel, new Date().toISOString()]);

  res.status(201).json({ id: userId, username, accessLevel, teamId, name });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't remove your own login while logged in as it" });
  await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// Update an existing login — username, access level, and/or password (leave password blank to keep it unchanged).
app.patch("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const user = (await pool.query("SELECT * FROM users WHERE id = $1", [req.params.id])).rows[0];
  if (!user) return res.status(404).json({ error: "Login not found" });
  const { username, password, accessLevel } = req.body;

  if (username && username !== user.username) {
    const existing = (await pool.query("SELECT id FROM users WHERE username = $1 AND id != $2", [username, user.id])).rows[0];
    if (existing) return res.status(400).json({ error: "That username is already taken" });
  }
  if (accessLevel && !["admin", "staff", "performer"].includes(accessLevel)) {
    return res.status(400).json({ error: "accessLevel must be 'admin', 'staff', or 'performer'" });
  }

  await pool.query(`
    UPDATE users SET
      username = $1,
      access_level = $2,
      password_hash = $3
    WHERE id = $4
  `, [
    username || user.username,
    accessLevel || user.access_level,
    password ? bcrypt.hashSync(password, 10) : user.password_hash,
    user.id,
  ]);
  res.json({ id: user.id, username: username || user.username, accessLevel: accessLevel || user.access_level });
});

// Update a team member's own details (name, role/title, phone, email) — admin only.
app.patch("/api/team/:id", requireAuth, requireAdmin, async (req, res) => {
  const member = (await pool.query("SELECT * FROM team WHERE id = $1", [req.params.id])).rows[0];
  if (!member) return res.status(404).json({ error: "Team member not found" });
  const { name, role, phone, email, specialty } = req.body;
  await pool.query(`UPDATE team SET name = $1, role = $2, phone = $3, email = $4, specialty = $5 WHERE id = $6`, [
    name || member.name,
    role !== undefined ? role : member.role,
    phone !== undefined ? phone : member.phone,
    email !== undefined ? email : member.email,
    specialty !== undefined ? specialty : member.specialty,
    member.id,
  ]);
  res.json((await pool.query("SELECT * FROM team WHERE id = $1", [member.id])).rows[0]);
});

// Remove a team member entirely — also removes any login tied to them.
app.delete("/api/team/:id", requireAuth, requireAdmin, async (req, res) => {
  const linkedUser = (await pool.query("SELECT id FROM users WHERE team_id = $1", [req.params.id])).rows[0];
  if (linkedUser && linkedUser.id === req.user.id) {
    return res.status(400).json({ error: "You can't remove your own team entry while logged in as it" });
  }
  const activeEvents = (await pool.query(`
    SELECT leads.name, leads.date FROM event_assignments
    JOIN leads ON leads.id = event_assignments.lead_id
    WHERE event_assignments.team_id = $1 AND leads.stage = 'Confirmed'
  `, [req.params.id])).rows;
  if (activeEvents.length > 0) {
    const list = activeEvents.map((e) => `${e.name} (${e.date})`).join(", ");
    return res.status(400).json({ error: `Can't remove — they're on ${activeEvents.length} active confirmed event${activeEvents.length > 1 ? "s" : ""}: ${list}. Reassign or wait until those are completed/cancelled first.` });
  }
  // Unlink (not delete) financial/assignment records so history is preserved,
  // then remove the login and the team member themselves. Deleting the team
  // row directly would otherwise fail — expenses/event_assignments reference it.
  await pool.query("UPDATE expenses SET team_id = NULL WHERE team_id = $1", [req.params.id]);
  await pool.query("DELETE FROM event_assignments WHERE team_id = $1", [req.params.id]);
  await pool.query("DELETE FROM notifications WHERE team_id = $1", [req.params.id]);
  await pool.query("UPDATE tasks SET assigned_to = NULL WHERE assigned_to = $1", [req.params.id]);
  await pool.query("UPDATE leads SET assigned_to = NULL WHERE assigned_to = $1", [req.params.id]);
  await pool.query("DELETE FROM users WHERE team_id = $1", [req.params.id]);
  await pool.query("DELETE FROM team WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// ---------- Config (so the frontend never hardcodes pricing) ----------
app.get("/api/config", (req, res) => {
  res.json({
    stages: STAGES,
    packages: PACKAGES,
    addons: ADDONS,
    pricing: PRICING,
    experiences: EXPERIENCES,
    occasions: OCCASIONS,
    guestRanges: GUEST_RANGES,
    howHeard: HOW_HEARD,
  });
});

// ---------- Leads ----------
app.get("/api/leads", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM leads ORDER BY created_at DESC");
  res.json(rows);
});

// Public lead-capture endpoint — this is the form link you'd share with a new query.
// Public — lets the enquiry form warn a customer their date is already booked
// and offer to submit anyway with a flexible alternative date.
app.get("/api/availability", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });
  const row = (await pool.query("SELECT name FROM leads WHERE date = $1 AND stage = 'Confirmed' LIMIT 1", [date])).rows[0];
  res.json({ booked: !!row });
});

app.post("/api/leads", async (req, res) => {
  const {
    name, phone, email, eventType, city, date, budget, notes,
    venue, occasion, guestRange, details, howHeard, whatsappOptin, altDate,
  } = req.body;
  if (!name || !eventType || !date) {
    return res.status(400).json({ error: "name, eventType, and date are required" });
  }
  const id = uuid();
  await pool.query(`
    INSERT INTO leads (
      id, name, phone, email, event_type, city, date, budget, stage, advance, notes, created_at,
      venue, occasion, guest_range, details, how_heard, whatsapp_optin, alt_date
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'New', 0, $9, $10, $11, $12, $13, $14, $15, $16, $17)
  `, [
    id, name, phone || null, email || null, eventType, city || null, date, budget || null, notes || null, new Date().toISOString(),
    venue || null, occasion || null, guestRange || null,
    details || null, howHeard || null, whatsappOptin ? 1 : 0, altDate || null,
  ]);
  const created = (await pool.query("SELECT * FROM leads WHERE id = $1", [id])).rows[0];
  res.status(201).json(created);
  // New leads show up immediately in the Leads tab and dashboard "new leads"
  // count — no email/notification needed, the team works off the app directly.
});

app.patch("/api/leads/:id", requireAuth, async (req, res) => {
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  if (req.body.advanceDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (req.body.advanceDate > today) return res.status(400).json({ error: "Advance received date can't be in the future" });
  }

  const fields = ["stage", "assigned_to", "advance", "advance_date", "quote_amount", "final_amount", "notes"];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    const key = f === "assigned_to" ? "assignedTo" : f === "quote_amount" ? "quoteAmount" : f === "final_amount" ? "finalAmount" : f === "advance_date" ? "advanceDate" : f;
    if (req.body[key] !== undefined) {
      values.push(req.body[key]);
      updates.push(`${f} = $${values.length}`);
    }
  });
  if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });

  values.push(req.params.id);
  await pool.query(`UPDATE leads SET ${updates.join(", ")} WHERE id = $${values.length}`, values);

  // If this event just got cancelled, tell everyone who was assigned to it.
  if (req.body.stage === "Cancelled" && lead.stage !== "Cancelled") {
    const assigned = (await pool.query("SELECT team_id FROM event_assignments WHERE lead_id = $1", [req.params.id])).rows;
    const now = new Date().toISOString();
    for (const a of assigned) {
      await pool.query(`
        INSERT INTO notifications (id, team_id, message, created_at)
        VALUES ($1, $2, $3, $4)
      `, [uuid(), a.team_id, `Event cancelled: ${lead.name} on ${lead.date}${lead.city ? ` in ${lead.city}` : ""} — no longer happening.`, now]);
    }
  }

  res.json((await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0]);
});

// ---------- Quotation ----------
// The quote text is built and edited entirely in the browser (so Ashwin can
// change wording, amount, or anything else himself without needing a code
// change). This endpoint just records the amount + stage, and turns the
// final text into a WhatsApp link and a mailto link.
app.post("/api/leads/:id/quote", requireAuth, async (req, res) => {
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const { amount, subject, body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Quote text is required" });

  const numericAmount = amount !== undefined && amount !== null && amount !== "" ? Number(amount) : null;
  const finalSubject = subject && subject.trim() ? subject : "Quotation — Together, Out Loud";

  const newStage = (lead.stage === "New") ? "Follow-up" : lead.stage;
  await pool.query("UPDATE leads SET quote_amount = $1, stage = $2 WHERE id = $3", [numericAmount, newStage, lead.id]);
  await pool.query(`
    INSERT INTO quotes (id, lead_id, subject, body, amount, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [uuid(), lead.id, finalSubject, body, numericAmount, new Date().toISOString()]);

  // WhatsApp click-to-chat needs just digits (country code + number, no + or spaces).
  const digitsOnly = (lead.phone || "").replace(/\D/g, "");
  const whatsapp = digitsOnly
    ? { link: `https://wa.me/${digitsOnly}?text=${encodeURIComponent(body)}` }
    : { link: null, reason: "No phone number on file for this lead" };

  // mailto: opens whatever email app/account is already logged in on the
  // staff member's device, pre-filled — no SMTP/API involved, so it always works.
  const mailto = lead.email
    ? { link: `mailto:${lead.email}?subject=${encodeURIComponent(finalSubject)}&body=${encodeURIComponent(body)}` }
    : { link: null, reason: "No email on file for this lead" };

  res.json({
    lead: (await pool.query("SELECT * FROM leads WHERE id = $1", [lead.id])).rows[0],
    whatsapp,
    mailto,
  });
});

// History of every quote ever sent, newest first — so Ashwin can see what's gone to whom.
app.get("/api/quotes", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT quotes.*, leads.name AS lead_name, leads.phone AS lead_phone, leads.email AS lead_email
    FROM quotes JOIN leads ON leads.id = quotes.lead_id
    ORDER BY quotes.created_at DESC
  `);
  res.json(rows);
});

// ---------- Event assignments (staffing a Confirmed event) ----------
// Admin picks which team members are performing; each gets a pending
// invitation they accept/decline from their own simplified view.
app.get("/api/leads/:id/assignments", requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT event_assignments.*, team.name AS team_name
    FROM event_assignments JOIN team ON team.id = event_assignments.team_id
    WHERE lead_id = $1
    ORDER BY event_assignments.created_at ASC
  `, [req.params.id]);
  res.json(rows);
});

app.post("/api/leads/:id/assignments", requireAuth, requireAdmin, async (req, res) => {
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const { teamIds = [] } = req.body;
  const existing = (await pool.query("SELECT team_id FROM event_assignments WHERE lead_id = $1", [req.params.id])).rows.map((r) => r.team_id);
  const now = new Date().toISOString();
  const newlyAdded = teamIds.filter((id) => !existing.includes(id));
  for (const teamId of newlyAdded) {
    await pool.query(`
      INSERT INTO event_assignments (id, lead_id, team_id, status, paid, created_at)
      VALUES ($1, $2, $3, 'pending', 0, $4)
    `, [uuid(), req.params.id, teamId, now]);
    await pool.query(`
      INSERT INTO notifications (id, team_id, message, created_at)
      VALUES ($1, $2, $3, $4)
    `, [uuid(), teamId, `You've been added to a new event: ${lead.name} on ${lead.date}${lead.city ? ` in ${lead.city}` : ""}.`, now]);
  }
  const { rows } = await pool.query(`
    SELECT event_assignments.*, team.name AS team_name
    FROM event_assignments JOIN team ON team.id = event_assignments.team_id
    WHERE lead_id = $1
  `, [req.params.id]);
  res.status(201).json(rows);
});

app.delete("/api/assignments/:id", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM event_assignments WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// Admin marks a crew member's fee as paid/unpaid for a specific event.
app.patch("/api/assignments/:id", requireAuth, requireAdmin, async (req, res) => {
  const a = (await pool.query("SELECT * FROM event_assignments WHERE id = $1", [req.params.id])).rows[0];
  if (!a) return res.status(404).json({ error: "Assignment not found" });
  const { paid, feeAmount } = req.body;
  await pool.query("UPDATE event_assignments SET paid = $1, fee_amount = $2 WHERE id = $3", [
    paid !== undefined ? (paid ? 1 : 0) : a.paid,
    feeAmount !== undefined ? feeAmount : a.fee_amount,
    a.id,
  ]);
  res.json((await pool.query("SELECT * FROM event_assignments WHERE id = $1", [a.id])).rows[0]);
});

// ---------- Performer/photographer view — deliberately narrow: only their own events ----------
app.get("/api/my/events", requireAuth, async (req, res) => {
  if (!req.user.team_id) return res.json([]);
  const { rows } = await pool.query(`
    SELECT event_assignments.id, event_assignments.lead_id, event_assignments.team_id, event_assignments.status,
      leads.name AS lead_name, leads.date, leads.city, leads.event_type, leads.stage,
      ex.paid AS paid, ex.amount AS fee_amount, ex.payment_date, ex.payment_mode
    FROM event_assignments
    JOIN leads ON leads.id = event_assignments.lead_id
    LEFT JOIN expenses ex ON ex.team_id = event_assignments.team_id AND ex.lead_id = event_assignments.lead_id
    WHERE event_assignments.team_id = $1
    ORDER BY leads.date ASC
  `, [req.user.team_id]);
  res.json(rows);
});

app.post("/api/my/assignments/:id/respond", requireAuth, async (req, res) => {
  const a = (await pool.query("SELECT * FROM event_assignments WHERE id = $1", [req.params.id])).rows[0];
  if (!a) return res.status(404).json({ error: "Assignment not found" });
  if (a.team_id !== req.user.team_id) return res.status(403).json({ error: "This invitation isn't yours" });
  const { status } = req.body;
  if (!["accepted", "declined"].includes(status)) return res.status(400).json({ error: "status must be 'accepted' or 'declined'" });
  await pool.query("UPDATE event_assignments SET status = $1, responded_at = $2 WHERE id = $3", [status, new Date().toISOString(), a.id]);

  const lead = (await pool.query("SELECT name, date FROM leads WHERE id = $1", [a.lead_id])).rows[0];
  const member = (await pool.query("SELECT name FROM team WHERE id = $1", [a.team_id])).rows[0];
  if (lead && member) {
    await pool.query(`
      INSERT INTO admin_notifications (id, message, assignment_id, created_at)
      VALUES ($1, $2, $3, $4)
    `, [uuid(), `${member.name} ${status} ${lead.name} on ${lead.date}.`, a.id, new Date().toISOString()]);
  }

  res.json((await pool.query("SELECT * FROM event_assignments WHERE id = $1", [a.id])).rows[0]);
});

// A performer who already accepted can request to back out, giving a reason —
// admin sees it and decides whether to approve, freeing up that slot.
app.post("/api/my/assignments/:id/request-cancel", requireAuth, async (req, res) => {
  const a = (await pool.query("SELECT * FROM event_assignments WHERE id = $1", [req.params.id])).rows[0];
  if (!a) return res.status(404).json({ error: "Assignment not found" });
  if (a.team_id !== req.user.team_id) return res.status(403).json({ error: "This invitation isn't yours" });
  if (a.status !== "accepted") return res.status(400).json({ error: "Only an accepted event can be cancelled" });
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: "Please give a reason for cancelling" });
  await pool.query("UPDATE event_assignments SET status = 'cancel_requested', cancel_reason = $1 WHERE id = $2", [reason, a.id]);

  const lead = (await pool.query("SELECT name, date FROM leads WHERE id = $1", [a.lead_id])).rows[0];
  const member = (await pool.query("SELECT name FROM team WHERE id = $1", [a.team_id])).rows[0];
  if (lead && member) {
    await pool.query(`
      INSERT INTO admin_notifications (id, message, assignment_id, created_at)
      VALUES ($1, $2, $3, $4)
    `, [uuid(), `${member.name} wants to cancel their spot on ${lead.name} (${lead.date}) — reason: ${reason}`, a.id, new Date().toISOString()]);
  }
  res.json((await pool.query("SELECT * FROM event_assignments WHERE id = $1", [a.id])).rows[0]);
});

// Admin approves or rejects a performer's cancellation request.
app.post("/api/assignments/:id/resolve-cancel", requireAuth, requireAdmin, async (req, res) => {
  const a = (await pool.query("SELECT * FROM event_assignments WHERE id = $1", [req.params.id])).rows[0];
  if (!a) return res.status(404).json({ error: "Assignment not found" });
  if (a.status !== "cancel_requested") return res.status(400).json({ error: "No pending cancellation request on this assignment" });
  const { approve } = req.body;
  const newStatus = approve ? "declined" : "accepted";
  await pool.query("UPDATE event_assignments SET status = $1, cancel_reason = NULL WHERE id = $2", [newStatus, a.id]);

  const lead = (await pool.query("SELECT name, date FROM leads WHERE id = $1", [a.lead_id])).rows[0];
  if (lead) {
    await pool.query(`
      INSERT INTO notifications (id, team_id, message, created_at)
      VALUES ($1, $2, $3, $4)
    `, [uuid(), a.team_id, `Your cancellation request for ${lead.name} (${lead.date}) was ${approve ? "approved" : "declined — you're still on this event"}.`, new Date().toISOString()]);
  }
  res.json((await pool.query("SELECT * FROM event_assignments WHERE id = $1", [a.id])).rows[0]);
});

app.get("/api/admin/notifications", requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT admin_notifications.*, event_assignments.status AS assignment_status
    FROM admin_notifications
    LEFT JOIN event_assignments ON event_assignments.id = admin_notifications.assignment_id
    ORDER BY admin_notifications.created_at DESC LIMIT 15
  `);
  res.json(rows);
});

app.delete("/api/admin/notifications/:id", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM admin_notifications WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

async function canAccessEventChat(req, leadId) {
  if (req.user.access_level === "admin") return true;
  if (!req.user.team_id) return false;
  const row = (await pool.query("SELECT id FROM event_assignments WHERE lead_id = $1 AND team_id = $2", [leadId, req.user.team_id])).rows[0];
  return !!row;
}

app.get("/api/my/events/:leadId/messages", requireAuth, async (req, res) => {
  if (!(await canAccessEventChat(req, req.params.leadId))) return res.status(403).json({ error: "Not part of this event" });
  const { rows } = await pool.query("SELECT * FROM event_messages WHERE lead_id = $1 ORDER BY created_at ASC", [req.params.leadId]);
  res.json(rows);
});

app.post("/api/my/events/:leadId/messages", requireAuth, async (req, res) => {
  if (!(await canAccessEventChat(req, req.params.leadId))) return res.status(403).json({ error: "Not part of this event" });
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Message can't be empty" });
  let authorName = req.user.username;
  if (req.user.team_id) {
    const t = (await pool.query("SELECT name FROM team WHERE id = $1", [req.user.team_id])).rows[0];
    if (t) authorName = t.name;
  }
  const id = uuid();
  await pool.query(`
    INSERT INTO event_messages (id, lead_id, author_name, body, created_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [id, req.params.leadId, authorName, body, new Date().toISOString()]);
  res.status(201).json((await pool.query("SELECT * FROM event_messages WHERE id = $1", [id])).rows[0]);
});

// ---------- Announcements (broadcast to the whole team) ----------
app.get("/api/my/notifications", requireAuth, async (req, res) => {
  if (!req.user.team_id) return res.json([]);
  const { rows } = await pool.query("SELECT * FROM notifications WHERE team_id = $1 ORDER BY created_at DESC", [req.user.team_id]);
  res.json(rows);
});

app.delete("/api/my/notifications/:id", requireAuth, async (req, res) => {
  const n = (await pool.query("SELECT * FROM notifications WHERE id = $1", [req.params.id])).rows[0];
  if (!n) return res.status(204).end();
  if (n.team_id !== req.user.team_id) return res.status(403).json({ error: "Not yours to dismiss" });
  await pool.query("DELETE FROM notifications WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

app.get("/api/announcements", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM announcements ORDER BY created_at DESC LIMIT 10");
  res.json(rows);
});

app.post("/api/announcements", requireAuth, requireAdmin, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: "Message can't be empty" });
  const id = uuid();
  await pool.query(`
    INSERT INTO announcements (id, message, created_by, created_at)
    VALUES ($1, $2, $3, $4)
  `, [id, message, req.user.username, new Date().toISOString()]);
  res.status(201).json((await pool.query("SELECT * FROM announcements WHERE id = $1", [id])).rows[0]);
});

app.delete("/api/announcements/:id", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM announcements WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// ---------- Team ----------
app.get("/api/team", requireAuth, async (req, res) => {
  const leads = (await pool.query("SELECT * FROM leads WHERE stage NOT IN ('Completed', 'Cancelled')")).rows;
  const team = (await pool.query("SELECT * FROM team")).rows.map((m) => ({
    ...m,
    activeLeads: leads.filter((l) => l.assigned_to === m.id),
  }));
  res.json(team);
});

// ---------- Calendar ----------
app.get("/api/calendar", requireAuth, async (req, res) => {
  const { year, month } = req.query; // month is 1-12
  const rows = (await pool.query("SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed')")).rows;
  const filtered = rows.filter((l) => {
    if (!l.date) return false;
    const d = new Date(l.date + "T00:00:00");
    return (!year || d.getFullYear() === Number(year)) && (!month || d.getMonth() + 1 === Number(month));
  });
  res.json(filtered);
});

// ---------- Accounts ----------
app.get("/api/accounts", requireAuth, async (req, res) => {
  const rows = (await pool.query("SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed')")).rows;
  const paymentSums = (await pool.query(`
    SELECT lead_id, COALESCE(SUM(amount), 0) AS total
    FROM payments WHERE lead_id = ANY($1::text[]) GROUP BY lead_id
  `, [rows.map((r) => r.id)])).rows;
  const receivedByLead = {};
  paymentSums.forEach((p) => (receivedByLead[p.lead_id] = Number(p.total)));

  const bookings = rows.map((l) => ({ ...l, received: receivedByLead[l.id] || 0 }));
  const totals = bookings.reduce(
    (acc, l) => {
      acc.quoted += l.final_amount || l.quote_amount || 0;
      acc.received += l.received;
      return acc;
    },
    { quoted: 0, received: 0 }
  );
  res.json({ bookings, totals: { ...totals, outstanding: totals.quoted - totals.received } });
});

// ---------- Payments ledger — supports multiple partial payments per booking ----------
app.get("/api/ledger", requireAuth, async (req, res) => {
  const leads = (await pool.query("SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed') ORDER BY date ASC")).rows;
  const payments = (await pool.query("SELECT * FROM payments ORDER BY payment_date ASC")).rows;
  const result = leads.map((l) => {
    const leadPayments = payments.filter((p) => p.lead_id === l.id);
    const totalReceived = leadPayments.reduce((s, p) => s + p.amount, 0);
    const total = l.final_amount || l.quote_amount || 0;
    return { ...l, payments: leadPayments, totalReceived, balance: total - totalReceived };
  });
  res.json(result);
});

app.get("/api/leads/:id/payments", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM payments WHERE lead_id = $1 ORDER BY payment_date ASC", [req.params.id]);
  res.json(rows);
});

app.post("/api/leads/:id/payments", requireAuth, requireAdmin, async (req, res) => {
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const { amount, date, mode, notes } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: "Enter a valid amount" });
  if (!date) return res.status(400).json({ error: "Payment date is required" });
  const today = new Date().toISOString().slice(0, 10);
  if (date > today) return res.status(400).json({ error: "Payment date can't be in the future" });
  const id = uuid();
  await pool.query(`
    INSERT INTO payments (id, lead_id, amount, payment_date, payment_mode, notes, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [id, req.params.id, Number(amount), date, mode || null, notes || null, new Date().toISOString()]);
  res.status(201).json((await pool.query("SELECT * FROM payments WHERE id = $1", [id])).rows[0]);
});

app.delete("/api/payments/:id", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM payments WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// All artist/crew fee assignments across every event — for the Accounts tab's
// "Artist payments" section, so payment status isn't buried inside Pipeline.
app.get("/api/assignments", requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT event_assignments.*, team.name AS team_name, leads.name AS lead_name, leads.date AS lead_date
    FROM event_assignments
    JOIN team ON team.id = event_assignments.team_id
    JOIN leads ON leads.id = event_assignments.lead_id
    ORDER BY leads.date ASC
  `);
  res.json(rows);
});

// General expenses — travel, lights, or any custom head Ashwin wants to track.
// Merged view of real money movement — paid expenses (money out) and client
// payments (money in) — for a single "Recent Transactions" feed in Accounts.
app.get("/api/transactions", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      'out' AS direction,
      e.id,
      e.amount,
      e.payment_date AS date,
      e.payment_mode AS mode,
      COALESCE(t.name, l.name, 'General') AS party_name,
      e.head AS description
    FROM expenses e
    LEFT JOIN team t ON t.id = e.team_id
    LEFT JOIN leads l ON l.id = e.lead_id
    WHERE e.paid = 1 AND e.payment_date IS NOT NULL

    UNION ALL

    SELECT
      'in' AS direction,
      p.id,
      p.amount,
      p.payment_date AS date,
      p.payment_mode AS mode,
      l.name AS party_name,
      'Payment received' AS description
    FROM payments p
    JOIN leads l ON l.id = p.lead_id

    ORDER BY date DESC
    LIMIT 30
  `);
  res.json(rows);
});

app.get("/api/expenses", requireAuth, async (req, res) => {
  const { leadId } = req.query;
  const { rows } = leadId
    ? await pool.query("SELECT * FROM expenses WHERE lead_id = $1 ORDER BY created_at DESC", [leadId])
    : await pool.query("SELECT * FROM expenses ORDER BY created_at DESC");
  res.json(rows);
});

app.post("/api/expenses", requireAuth, requireAdmin, async (req, res) => {
  const { leadId, teamId, head, amount, paid, notes, paymentDate, paymentMode } = req.body;
  if (!head || amount === undefined) return res.status(400).json({ error: "head and amount are required" });
  const id = uuid();
  await pool.query(`
    INSERT INTO expenses (id, lead_id, team_id, head, amount, paid, notes, created_at, payment_date, payment_mode)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    id, leadId || null, teamId || null, head, Number(amount), paid ? 1 : 0, notes || null, new Date().toISOString(),
    paid ? (paymentDate || new Date().toISOString().slice(0, 10)) : (paymentDate || null),
    paymentMode || null,
  ]);
  res.status(201).json((await pool.query("SELECT * FROM expenses WHERE id = $1", [id])).rows[0]);
});

app.patch("/api/expenses/:id", requireAuth, requireAdmin, async (req, res) => {
  const exp = (await pool.query("SELECT * FROM expenses WHERE id = $1", [req.params.id])).rows[0];
  if (!exp) return res.status(404).json({ error: "Expense not found" });
  const { head, amount, paid, notes, paymentDate, paymentMode } = req.body;
  const nowPaid = paid !== undefined ? (paid ? 1 : 0) : exp.paid;
  // Stamp today's date automatically the moment something is marked paid, if no date was given.
  const resolvedPaymentDate = paymentDate !== undefined
    ? paymentDate
    : (nowPaid && !exp.payment_date ? new Date().toISOString().slice(0, 10) : exp.payment_date);
  await pool.query(`UPDATE expenses SET head = $1, amount = $2, paid = $3, notes = $4, payment_date = $5, payment_mode = $6 WHERE id = $7`, [
    head !== undefined ? head : exp.head,
    amount !== undefined ? Number(amount) : exp.amount,
    nowPaid,
    notes !== undefined ? notes : exp.notes,
    resolvedPaymentDate,
    paymentMode !== undefined ? paymentMode : exp.payment_mode,
    exp.id,
  ]);
  res.json((await pool.query("SELECT * FROM expenses WHERE id = $1", [exp.id])).rows[0]);
});

app.delete("/api/expenses/:id", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM expenses WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// ---------- Tasks ----------
app.get("/api/my/tasks", requireAuth, async (req, res) => {
  if (!req.user.team_id) return res.json([]);
  const { rows } = await pool.query(
    "SELECT * FROM tasks WHERE assigned_to = $1 ORDER BY done ASC, due_date ASC",
    [req.user.team_id]
  );
  res.json(rows);
});

app.get("/api/tasks", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM tasks ORDER BY done ASC, due_date ASC");
  res.json(rows);
});

app.post("/api/tasks", requireAuth, async (req, res) => {
  const { leadId, title, dueDate, assignedTo } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });
  const id = uuid();
  await pool.query(`
    INSERT INTO tasks (id, lead_id, title, due_date, assigned_to, done, created_at)
    VALUES ($1, $2, $3, $4, $5, 0, $6)
  `, [id, leadId || null, title, dueDate || null, assignedTo || null, new Date().toISOString()]);
  res.status(201).json((await pool.query("SELECT * FROM tasks WHERE id = $1", [id])).rows[0]);
});

app.patch("/api/tasks/:id", requireAuth, async (req, res) => {
  const task = (await pool.query("SELECT * FROM tasks WHERE id = $1", [req.params.id])).rows[0];
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (req.user.access_level === "performer") {
    if (task.assigned_to !== req.user.team_id) return res.status(403).json({ error: "Not your task" });
    if (req.body.done === undefined || Object.keys(req.body).length > 1) {
      return res.status(403).json({ error: "You can only mark your own tasks done/not done" });
    }
  }
  const fields = { done: "done", title: "title", due_date: "dueDate", assigned_to: "assignedTo" };
  const updates = [];
  const values = [];
  Object.entries(fields).forEach(([col, key]) => {
    if (req.body[key] !== undefined) {
      values.push(col === "done" ? (req.body[key] ? 1 : 0) : req.body[key]);
      updates.push(`${col} = $${values.length}`);
    }
  });
  if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });
  values.push(req.params.id);
  await pool.query(`UPDATE tasks SET ${updates.join(", ")} WHERE id = $${values.length}`, values);
  res.json((await pool.query("SELECT * FROM tasks WHERE id = $1", [req.params.id])).rows[0]);
});

app.delete("/api/tasks/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM tasks WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// ---------- Documents ----------
app.get("/api/documents", requireAuth, async (req, res) => {
  const { leadId } = req.query;
  const { rows } = leadId
    ? await pool.query("SELECT * FROM documents WHERE lead_id = $1 ORDER BY uploaded_at DESC", [leadId])
    : await pool.query("SELECT * FROM documents ORDER BY uploaded_at DESC");
  res.json(rows.map((d) => ({ ...d, url: `/uploads/${d.stored_name}` })));
});

app.post("/api/documents", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const id = uuid();
  await pool.query(`
    INSERT INTO documents (id, lead_id, original_name, stored_name, notes, uploaded_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [id, req.body.leadId || null, req.file.originalname, req.file.filename, req.body.notes || null, new Date().toISOString()]);
  const doc = (await pool.query("SELECT * FROM documents WHERE id = $1", [id])).rows[0];
  res.status(201).json({ ...doc, url: `/uploads/${doc.stored_name}` });
});

app.delete("/api/documents/:id", requireAuth, async (req, res) => {
  const doc = (await pool.query("SELECT * FROM documents WHERE id = $1", [req.params.id])).rows[0];
  if (doc) {
    fs.unlink(path.join(UPLOAD_DIR, doc.stored_name), () => {});
    await pool.query("DELETE FROM documents WHERE id = $1", [req.params.id]);
  }
  res.status(204).end();
});

// ---------- Dashboard ----------
app.get("/api/dashboard", requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  const [upcomingRes, followUpsRes, accountsRes, paymentsRes, tasksRes, newLeadsRes] = await Promise.all([
    pool.query(`SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed') AND date >= $1 ORDER BY date ASC LIMIT 5`, [today]),
    pool.query(`SELECT * FROM leads WHERE stage = 'Follow-up' ORDER BY date ASC`),
    pool.query(`SELECT id, final_amount, quote_amount FROM leads WHERE stage IN ('Confirmed', 'Completed')`),
    pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments`),
    pool.query(`SELECT * FROM tasks WHERE done = 0 AND (due_date <= $1 OR due_date IS NULL) ORDER BY due_date ASC LIMIT 8`, [weekAhead]),
    pool.query(`SELECT COUNT(*) AS c FROM leads WHERE stage = 'New'`),
  ]);

  const totalQuoted = accountsRes.rows.reduce((s, l) => s + (l.final_amount || l.quote_amount || 0), 0);
  const totalReceived = Number(paymentsRes.rows[0].total);

  res.json({
    upcomingEvents: upcomingRes.rows,
    pendingFollowUps: followUpsRes.rows,
    tasksDueSoon: tasksRes.rows,
    newLeadsCount: Number(newLeadsRes.rows[0].c),
    outstanding: totalQuoted - totalReceived,
  });
});

// Confirmed events move themselves to Completed once the event date has passed —
// runs at boot and every hour after. No cron infra needed for this volume of data.
async function autoCompletePastEvents() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(`UPDATE leads SET stage = 'Completed' WHERE stage = 'Confirmed' AND date < $1`, [today]);
  } catch (err) {
    console.error("autoCompletePastEvents failed:", err.message);
  }
}

const PORT = process.env.PORT || 3300;
ready.then(() => {
  app.listen(PORT, () => console.log(`TOL workflow app running on http://localhost:${PORT}`));
  autoCompletePastEvents();
  setInterval(autoCompletePastEvents, 60 * 60 * 1000);
});
