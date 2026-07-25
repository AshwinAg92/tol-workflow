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
      "SELECT id, username, access_level, team_id, permissions, is_performer FROM users WHERE id = $1",
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

// Gate a section (e.g. "accounts") for staff logins with restricted permissions.
// Admin always passes. NULL permissions = full access (default for existing staff).
// Same permission check as requireSection, but as a plain boolean for cases where
// the request should still succeed — just with financial fields stripped out —
// rather than being blocked outright (e.g. a manager viewing team assignments for
// planning purposes shouldn't see fee amounts, but should still see who's playing).
function userHasSection(user, section) {
  if (user.access_level === "admin") return true;
  if (user.access_level !== "staff") return false;
  let perms = null;
  try { perms = user.permissions ? JSON.parse(user.permissions) : null; } catch { perms = null; }
  return !perms || perms.includes(section);
}

function requireSection(section) {
  return (req, res, next) => {
    if (req.user.access_level === "admin") return next();
    if (req.user.access_level === "staff") {
      let perms = null;
      try { perms = req.user.permissions ? JSON.parse(req.user.permissions) : null; } catch { perms = null; }
      if (perms && !perms.includes(section)) {
        return res.status(403).json({ error: `You don't have access to ${section}` });
      }
      return next();
    }
    return res.status(403).json({ error: "Not available for this account" });
  };
}

// Same shape as requireSection, but for operational abilities (not page visibility) —
// e.g. "assign_team" lets a staff member allot artists to a confirmed event without
// making them a full admin (which would also let them manage other people's logins).
function requireCapability(capability) {
  return (req, res, next) => {
    if (req.user.access_level === "admin") return next();
    if (req.user.access_level === "staff") {
      let perms = null;
      try { perms = req.user.permissions ? JSON.parse(req.user.permissions) : null; } catch { perms = null; }
      if (perms && !perms.includes(capability)) {
        return res.status(403).json({ error: "You don't have permission to do that" });
      }
      return next();
    }
    return res.status(403).json({ error: "Not available for this account" });
  };
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

// Best-effort daily activity log — shown on the Dashboard as a register of what happened today.
// Never throws: a logging failure should never break the request that triggered it.
async function actorName(user) {
  if (!user) return "System";
  if (user.team_id) {
    try {
      const { rows } = await pool.query("SELECT name FROM team WHERE id = $1", [user.team_id]);
      if (rows[0]) return rows[0].name;
    } catch {}
  }
  return user.username || "Someone";
}
async function logActivity(req, message, leadId) {
  try {
    const actor = await actorName(req.user);
    await pool.query(
      "INSERT INTO activity_log (id, message, actor, created_at, lead_id) VALUES ($1, $2, $3, $4, $5)",
      [uuid(), message, actor, new Date().toISOString(), leadId || null]
    );
  } catch (err) {
    console.error("logActivity failed:", err.message);
  }
}

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
  let name = user.username;
  if (user.team_id) {
    const member = (await pool.query("SELECT name FROM team WHERE id = $1", [user.team_id])).rows[0];
    if (member) name = member.name;
  }
  let permissions = null;
  try { permissions = user.permissions ? JSON.parse(user.permissions) : null; } catch { permissions = null; }
  res.json({ id: user.id, username: user.username, accessLevel: user.access_level, name, permissions, isPerformer: !!user.is_performer });
});

// ---------- User accounts (admin only) — add teammates with their own login ----------
app.get("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT users.id, users.username, users.access_level, users.team_id, users.permissions, users.is_performer, team.name AS team_name, team.role AS team_role
    FROM users LEFT JOIN team ON team.id = users.team_id
    ORDER BY users.created_at ASC
  `);
  res.json(rows.map((u) => ({ ...u, permissions: u.permissions ? JSON.parse(u.permissions) : null })));
});

app.post("/api/users", requireAuth, requireCapability("manage_team"), async (req, res) => {
  const { name, roleTitle, phone, specialty, username, password, accessLevel, existingTeamId, permissions, isPerformer } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password are required" });
  if (!existingTeamId && !name) return res.status(400).json({ error: "Name is required for a new team member" });
  if (!["admin", "staff", "performer"].includes(accessLevel)) return res.status(400).json({ error: "accessLevel must be 'admin', 'staff', or 'performer'" });

  // Guardrails for a manager (staff with manage_team) — never a true admin:
  // can't create admin accounts, and can't hand out access broader than their own.
  if (req.user.access_level === "staff") {
    if (accessLevel === "admin") return res.status(403).json({ error: "Managers can't create admin accounts — ask an admin." });
    if (Array.isArray(permissions)) {
      let ownPerms = null;
      try { ownPerms = req.user.permissions ? JSON.parse(req.user.permissions) : null; } catch { ownPerms = null; }
      if (Array.isArray(ownPerms)) {
        const overreach = permissions.filter((p) => !ownPerms.includes(p));
        if (overreach.length > 0) return res.status(403).json({ error: `You can't grant access you don't have yourself: ${overreach.join(", ")}` });
      }
    }
  }

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
    INSERT INTO users (id, team_id, username, password_hash, access_level, created_at, permissions, is_performer)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [userId, teamId, username, passwordHash, accessLevel, new Date().toISOString(), Array.isArray(permissions) ? JSON.stringify(permissions) : null, isPerformer ? 1 : 0]);

  res.status(201).json({ id: userId, username, accessLevel, teamId, name, isPerformer: !!isPerformer });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't remove your own login while logged in as it" });
  await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// Update an existing login — username, access level, and/or password (leave password blank to keep it unchanged).
app.patch("/api/users/:id", requireAuth, requireCapability("manage_team"), async (req, res) => {
  const user = (await pool.query("SELECT * FROM users WHERE id = $1", [req.params.id])).rows[0];
  if (!user) return res.status(404).json({ error: "Login not found" });
  const { username, password, accessLevel, permissions, isPerformer } = req.body;

  if (req.user.access_level === "staff") {
    if (user.access_level === "admin") return res.status(403).json({ error: "Managers can't edit an admin's login." });
    if (accessLevel === "admin") return res.status(403).json({ error: "Managers can't promote anyone to admin." });
    if (Array.isArray(permissions)) {
      let ownPerms = null;
      try { ownPerms = req.user.permissions ? JSON.parse(req.user.permissions) : null; } catch { ownPerms = null; }
      if (Array.isArray(ownPerms)) {
        const overreach = permissions.filter((p) => !ownPerms.includes(p));
        if (overreach.length > 0) return res.status(403).json({ error: `You can't grant access you don't have yourself: ${overreach.join(", ")}` });
      }
    }
  }

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
      password_hash = $3,
      permissions = $4,
      is_performer = $5
    WHERE id = $6
  `, [
    username || user.username,
    accessLevel || user.access_level,
    password ? bcrypt.hashSync(password, 10) : user.password_hash,
    permissions !== undefined ? (Array.isArray(permissions) ? JSON.stringify(permissions) : null) : user.permissions,
    isPerformer !== undefined ? (isPerformer ? 1 : 0) : user.is_performer,
    user.id,
  ]);
  res.json({ id: user.id, username: username || user.username, accessLevel: accessLevel || user.access_level, isPerformer: !!(isPerformer !== undefined ? isPerformer : user.is_performer) });
});

// Update a team member's own details (name, role/title, phone, email).
app.patch("/api/team/:id", requireAuth, requireCapability("manage_team"), async (req, res) => {
  const member = (await pool.query("SELECT * FROM team WHERE id = $1", [req.params.id])).rows[0];
  if (!member) return res.status(404).json({ error: "Team member not found" });
  if (req.user.access_level === "staff") {
    const linkedUser = (await pool.query("SELECT access_level FROM users WHERE team_id = $1", [req.params.id])).rows[0];
    if (linkedUser && linkedUser.access_level === "admin") {
      return res.status(403).json({ error: "Managers can't edit an admin's details." });
    }
  }
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
app.get("/api/config", async (req, res) => {
  let pricing = PRICING;
  try {
    const row = (await pool.query("SELECT template FROM message_templates WHERE key = 'pricing_matrix'")).rows[0];
    if (row) pricing = JSON.parse(row.template);
  } catch (err) {
    console.error("Failed to load pricing_matrix override, using config.js default:", err.message);
  }
  res.json({
    stages: STAGES,
    packages: PACKAGES,
    addons: ADDONS,
    pricing,
    experiences: EXPERIENCES,
    occasions: OCCASIONS,
    guestRanges: GUEST_RANGES,
    howHeard: HOW_HEARD,
  });
});

app.patch("/api/pricing", requireAuth, requireAdmin, async (req, res) => {
  const { pricing } = req.body;
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) {
    return res.status(400).json({ error: "pricing must be an object of { packageId: { pcs: rate } }" });
  }
  for (const [pkgId, tiers] of Object.entries(pricing)) {
    if (typeof tiers !== "object" || Array.isArray(tiers)) return res.status(400).json({ error: `Invalid pricing for "${pkgId}"` });
    for (const [pcs, rate] of Object.entries(tiers)) {
      if (isNaN(Number(pcs)) || isNaN(Number(rate))) return res.status(400).json({ error: `Invalid Pcs/rate pair in "${pkgId}"` });
    }
  }
  await pool.query(`
    INSERT INTO message_templates (key, template, updated_at) VALUES ('pricing_matrix', $1, $2)
    ON CONFLICT (key) DO UPDATE SET template = $1, updated_at = $2
  `, [JSON.stringify(pricing), new Date().toISOString()]);
  res.json({ pricing });
});

// ---------- Leads ----------
app.get("/api/leads", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM leads ORDER BY created_at DESC");
  let hasLeadsAccess = true;
  if (req.user.access_level === "staff") {
    let perms = null;
    try { perms = req.user.permissions ? JSON.parse(req.user.permissions) : null; } catch { perms = null; }
    if (perms && !perms.includes("leads")) hasLeadsAccess = false;
  }
  if (hasLeadsAccess) return res.json(rows);
  // Restricted staff (e.g. a manager who can assign team but not view the pipeline)
  // still need basic event info for the calendar and team assignment — nothing sensitive.
  res.json(rows.map((l) => ({
    id: l.id, name: l.name, date: l.date, city: l.city, event_type: l.event_type, stage: l.stage,
    event_time: l.event_time, soundcheck_time: l.soundcheck_time,
  })));
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
  logActivity({ user: null }, `New query received: ${name} — ${packageName(eventType)}${city ? ` in ${city}` : ""}`, id);
  // New leads show up immediately in the Leads tab and dashboard "new leads"
  // count — no email/notification needed, the team works off the app directly.
});

app.patch("/api/leads/:id", requireAuth, async (req, res) => {
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const hasLeads = userHasSection(req.user, "leads");
  const canAssignTeam = userHasSection(req.user, "assign_team");
  if (!hasLeads && !canAssignTeam) return res.status(403).json({ error: "You don't have permission to update this event" });

  // Event day timing is editable by anyone who can plan the team for an event
  // (a manager without full Leads access included); everything else — stage,
  // amounts, notes — needs full Leads access.
  const leadsOnlyFields = ["stage", "assigned_to", "advance", "advance_date", "quote_amount", "final_amount", "notes", "date"];
  const sharedFields = ["event_time", "soundcheck_time"];
  if (!hasLeads) {
    const keyFor = (f) => (f === "assigned_to" ? "assignedTo" : f === "advance_date" ? "advanceDate" : f);
    const attemptedRestricted = leadsOnlyFields.some((f) => req.body[keyFor(f)] !== undefined);
    if (attemptedRestricted) return res.status(403).json({ error: "You don't have permission to update those fields" });
  }

  if (req.body.advanceDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (req.body.advanceDate > today) return res.status(400).json({ error: "Advance received date can't be in the future" });
  }

  if (req.body.stage === "Completed" && lead.stage !== "Completed") {
    const today = new Date().toISOString().slice(0, 10);
    const effectiveDate = req.body.date || lead.date;
    if (!(effectiveDate < today)) {
      return res.status(400).json({ error: "Can't mark as Completed until the day after the event date — this happens automatically." });
    }
  }

  const fields = hasLeads ? [...leadsOnlyFields, ...sharedFields] : sharedFields;
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    const key = f === "assigned_to" ? "assignedTo" : f === "quote_amount" ? "quoteAmount" : f === "final_amount" ? "finalAmount" : f === "advance_date" ? "advanceDate" : f === "event_time" ? "eventTime" : f === "soundcheck_time" ? "soundcheckTime" : f;
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

  if (req.body.stage !== undefined && req.body.stage !== lead.stage) {
    if (req.body.stage === "Confirmed") {
      const amt = req.body.finalAmount ? ` — ₹${Number(req.body.finalAmount).toLocaleString("en-IN")}` : "";
      logActivity(req, `Confirmed: ${lead.name}${amt}`, lead.id);
    } else {
      logActivity(req, `${lead.name}: ${lead.stage} → ${req.body.stage}`, lead.id);
    }
  } else if (req.body.advance !== undefined && Number(req.body.advance) !== Number(lead.advance || 0)) {
    logActivity(req, `Payment recorded for ${lead.name}: ₹${Number(req.body.advance).toLocaleString("en-IN")} received`, lead.id);
  }
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
  logActivity(req, `Quote sent to ${lead.name}${numericAmount ? `: ₹${numericAmount.toLocaleString("en-IN")}` : ""}`, lead.id);
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
app.get("/api/leads/:id/assignments", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT event_assignments.*, team.name AS team_name
    FROM event_assignments JOIN team ON team.id = event_assignments.team_id
    WHERE lead_id = $1
    ORDER BY event_assignments.created_at ASC
  `, [req.params.id]);
  const canSeeMoney = userHasSection(req.user, "accounts");
  res.json(canSeeMoney ? rows : rows.map(({ fee_amount, ...rest }) => rest));
});

app.post("/api/leads/:id/assignments", requireAuth, requireCapability("assign_team"), async (req, res) => {
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
  if (newlyAdded.length > 0) {
    const names = rows.filter((r) => newlyAdded.includes(r.team_id)).map((r) => r.team_name).join(", ");
    logActivity(req, `${names} assigned to ${lead.name}`, lead.id);
  }
});

app.delete("/api/assignments/:id", requireAuth, requireCapability("assign_team"), async (req, res) => {
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

// ---------- Temporary artists — one-off performers hired for a single event, not part of the permanent team ----------
// Their fee (if given) lives as a row in the same `expenses` table used everywhere
// else in Accounts, linked via temp_artists.expense_id — so it automatically counts
// toward that event's expenses/profit and shows up in Pending expenses / Recent
// transactions, without a second, separate accounting path to keep in sync.
app.get("/api/leads/:id/temp-artists", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT temp_artists.*, expenses.amount AS fee_amount, expenses.paid AS fee_paid,
      expenses.payment_date AS fee_payment_date, expenses.payment_mode AS fee_payment_mode
    FROM temp_artists
    LEFT JOIN expenses ON expenses.id = temp_artists.expense_id
    WHERE temp_artists.lead_id = $1 ORDER BY temp_artists.created_at ASC
  `, [req.params.id]);
  const canSeeMoney = userHasSection(req.user, "accounts");
  res.json(canSeeMoney ? rows : rows.map(({ fee_amount, fee_paid, fee_payment_date, fee_payment_mode, expense_id, ...rest }) => rest));
});

app.post("/api/leads/:id/temp-artists", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const { name, description, phone, feeAmount } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });
  const id = uuid();
  const now = new Date().toISOString();
  let expenseId = null;
  if (feeAmount !== undefined && feeAmount !== null && feeAmount !== "") {
    if (isNaN(Number(feeAmount)) || Number(feeAmount) < 0) return res.status(400).json({ error: "Enter a valid fee amount" });
    expenseId = uuid();
    await pool.query(`
      INSERT INTO expenses (id, lead_id, head, amount, paid, created_at)
      VALUES ($1, $2, $3, $4, 0, $5)
    `, [expenseId, req.params.id, `Artist fee — ${name} (guest artist)`, Number(feeAmount), now]);
  }
  await pool.query(`
    INSERT INTO temp_artists (id, lead_id, name, description, phone, expense_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [id, req.params.id, name, description || null, phone || null, expenseId, now]);
  const { rows } = await pool.query(`
    SELECT temp_artists.*, expenses.amount AS fee_amount, expenses.paid AS fee_paid,
      expenses.payment_date AS fee_payment_date, expenses.payment_mode AS fee_payment_mode
    FROM temp_artists LEFT JOIN expenses ON expenses.id = temp_artists.expense_id WHERE temp_artists.id = $1
  `, [id]);
  res.status(201).json(rows[0]);
  logActivity(req, `Temporary artist added to ${lead.name}: ${name}${description ? ` (${description})` : ""}${expenseId ? ` — fee ₹${Number(feeAmount).toLocaleString("en-IN")}` : ""}`, lead.id);
});

app.patch("/api/temp-artists/:id", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const artist = (await pool.query("SELECT * FROM temp_artists WHERE id = $1", [req.params.id])).rows[0];
  if (!artist) return res.status(404).json({ error: "Not found" });
  const { feeAmount } = req.body;
  if (feeAmount !== undefined && feeAmount !== null && feeAmount !== "" && (isNaN(Number(feeAmount)) || Number(feeAmount) < 0)) {
    return res.status(400).json({ error: "Enter a valid fee amount" });
  }
  const hasFee = feeAmount !== undefined && feeAmount !== null && feeAmount !== "";
  if (artist.expense_id) {
    // Already has a linked expense — update its amount, or drop it if the fee was cleared.
    if (hasFee) {
      await pool.query("UPDATE expenses SET amount = $1 WHERE id = $2", [Number(feeAmount), artist.expense_id]);
    } else {
      await pool.query("DELETE FROM expenses WHERE id = $1", [artist.expense_id]);
      await pool.query("UPDATE temp_artists SET expense_id = NULL WHERE id = $1", [artist.id]);
    }
  } else if (hasFee) {
    const expenseId = uuid();
    await pool.query(`
      INSERT INTO expenses (id, lead_id, head, amount, paid, created_at)
      VALUES ($1, $2, $3, $4, 0, $5)
    `, [expenseId, artist.lead_id, `Artist fee — ${artist.name} (guest artist)`, Number(feeAmount), new Date().toISOString()]);
    await pool.query("UPDATE temp_artists SET expense_id = $1 WHERE id = $2", [expenseId, artist.id]);
  }
  const { rows } = await pool.query(`
    SELECT temp_artists.*, expenses.amount AS fee_amount, expenses.paid AS fee_paid,
      expenses.payment_date AS fee_payment_date, expenses.payment_mode AS fee_payment_mode
    FROM temp_artists LEFT JOIN expenses ON expenses.id = temp_artists.expense_id WHERE temp_artists.id = $1
  `, [artist.id]);
  res.json(rows[0]);
});

app.delete("/api/temp-artists/:id", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const artist = (await pool.query("SELECT * FROM temp_artists WHERE id = $1", [req.params.id])).rows[0];
  if (artist?.expense_id) await pool.query("DELETE FROM expenses WHERE id = $1", [artist.expense_id]);
  await pool.query("DELETE FROM temp_artists WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// ---------- Performer/photographer view — deliberately narrow: only their own events ----------
app.get("/api/my/events", requireAuth, async (req, res) => {
  if (!req.user.team_id) return res.json([]);
  const { rows } = await pool.query(`
    SELECT event_assignments.id, event_assignments.lead_id, event_assignments.team_id, event_assignments.status,
      leads.name AS lead_name, leads.date, leads.city, leads.event_type, leads.stage, leads.event_time, leads.soundcheck_time,
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
  // A manager coordinating an event should be able to jump into its chat even
  // if they aren't personally performing at it — not just admins and performers
  // who happen to be assigned.
  if (userHasSection(req.user, "leads") || userHasSection(req.user, "assign_team")) return true;
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

// One-time cleanup: wipe demo/seed data (leads and everything tied to them,
// plus the placeholder team members) while preserving real admin logins.
app.post("/api/admin/clear-demo-data", requireAuth, requireAdmin, async (req, res) => {
  const demoNames = ["Divya", "Karan", "Neha", "Devin"];
  try {
    const seedLeadIds = (await pool.query("SELECT id FROM leads WHERE is_seed = 1")).rows.map((r) => r.id);
    if (seedLeadIds.length > 0) {
      const seedAssignmentIds = (await pool.query(
        "SELECT id FROM event_assignments WHERE lead_id = ANY($1::text[])", [seedLeadIds]
      )).rows.map((r) => r.id);
      if (seedAssignmentIds.length > 0) {
        await pool.query("DELETE FROM admin_notifications WHERE assignment_id = ANY($1::text[])", [seedAssignmentIds]);
      }
      await pool.query("DELETE FROM event_assignments WHERE lead_id = ANY($1::text[])", [seedLeadIds]);
      await pool.query("DELETE FROM event_messages WHERE lead_id = ANY($1::text[])", [seedLeadIds]);
      await pool.query("DELETE FROM temp_artists WHERE lead_id = ANY($1::text[])", [seedLeadIds]);
      await pool.query("DELETE FROM expenses WHERE lead_id = ANY($1::text[])", [seedLeadIds]);
      await pool.query("DELETE FROM quotes WHERE lead_id = ANY($1::text[])", [seedLeadIds]);
      await pool.query("DELETE FROM payments WHERE lead_id = ANY($1::text[])", [seedLeadIds]);
      await pool.query("DELETE FROM tasks WHERE lead_id = ANY($1::text[])", [seedLeadIds]);
      await pool.query("DELETE FROM documents WHERE lead_id = ANY($1::text[])", [seedLeadIds]);
      await pool.query("DELETE FROM notifications WHERE lead_id = ANY($1::text[])", [seedLeadIds]);
      await pool.query("DELETE FROM activity_log WHERE lead_id = ANY($1::text[])", [seedLeadIds]);
      await pool.query("DELETE FROM leads WHERE id = ANY($1::text[])", [seedLeadIds]);
    }
    await pool.query("DELETE FROM users WHERE team_id IN (SELECT id FROM team WHERE name = ANY($1::text[]))", [demoNames]);
    await pool.query("DELETE FROM team WHERE name = ANY($1::text[])", [demoNames]);

    const leadsLeft = Number((await pool.query("SELECT COUNT(*) AS c FROM leads")).rows[0].c);
    const teamLeft = Number((await pool.query("SELECT COUNT(*) AS c FROM team")).rows[0].c);
    const usersLeft = Number((await pool.query("SELECT COUNT(*) AS c FROM users")).rows[0].c);
    res.json({ ok: true, leadsLeft, teamLeft, usersLeft, seedLeadsRemoved: seedLeadIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Team ----------
app.get("/api/team", requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const assignments = (await pool.query(`
    SELECT event_assignments.team_id, leads.id, leads.name, leads.date
    FROM event_assignments
    JOIN leads ON leads.id = event_assignments.lead_id
    WHERE event_assignments.status != 'declined' AND leads.stage != 'Cancelled' AND leads.date >= $1
    ORDER BY leads.date ASC
  `, [today])).rows;
  const team = (await pool.query("SELECT * FROM team")).rows.map((m) => ({
    ...m,
    activeShows: assignments.filter((a) => a.team_id === m.id),
  }));
  res.json(team);
});

// Events a specific team member is booked to perform at (distinct from a lead's
// "assigned_to" owner above) — used by the Team tab so anyone who can plan events
// (manager or admin) can click an artist and see what's on their plate.
app.get("/api/team/:id/assignments", requireAuth, async (req, res) => {
  if (!userHasSection(req.user, "leads") && !userHasSection(req.user, "assign_team")) {
    return res.status(403).json({ error: "You don't have permission to view this" });
  }
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(`
    SELECT event_assignments.id, event_assignments.status,
      leads.id AS lead_id, leads.name AS lead_name, leads.date, leads.city, leads.event_type, leads.stage,
      leads.event_time, leads.soundcheck_time,
      ex.paid AS paid, ex.amount AS fee_amount
    FROM event_assignments
    JOIN leads ON leads.id = event_assignments.lead_id
    LEFT JOIN expenses ex ON ex.team_id = event_assignments.team_id AND ex.lead_id = event_assignments.lead_id
    WHERE event_assignments.team_id = $1 AND leads.date >= $2
    ORDER BY leads.date ASC
  `, [req.params.id, today]);
  const canSeeMoney = userHasSection(req.user, "accounts");
  res.json(canSeeMoney ? rows : rows.map(({ fee_amount, paid, ...rest }) => rest));
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
app.get("/api/accounts", requireAuth, requireSection("accounts"), async (req, res) => {
  const rows = (await pool.query("SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed')")).rows;
  const paymentSums = (await pool.query(`
    SELECT lead_id, COALESCE(SUM(amount), 0) AS total
    FROM payments WHERE lead_id = ANY($1::text[]) GROUP BY lead_id
  `, [rows.map((r) => r.id)])).rows;
  const receivedByLead = {};
  paymentSums.forEach((p) => (receivedByLead[p.lead_id] = Number(p.total)));

  // Expenses committed to an event (artist fees + any other head) count against
  // its profit whether or not they've actually been paid out yet — the cost is
  // real the moment it's booked, not only once cash has left the account.
  const expenseSums = (await pool.query(`
    SELECT lead_id, COALESCE(SUM(amount), 0) AS total
    FROM expenses WHERE lead_id = ANY($1::text[]) GROUP BY lead_id
  `, [rows.map((r) => r.id)])).rows;
  const expensesByLead = {};
  expenseSums.forEach((e) => (expensesByLead[e.lead_id] = Number(e.total)));

  const bookings = rows.map((l) => {
    const revenue = l.final_amount || l.quote_amount || 0;
    const expenses = expensesByLead[l.id] || 0;
    return { ...l, received: receivedByLead[l.id] || 0, expenses, profit: revenue - expenses };
  });
  const totals = bookings.reduce(
    (acc, l) => {
      acc.quoted += l.final_amount || l.quote_amount || 0;
      acc.received += l.received;
      acc.expenses += l.expenses;
      acc.profit += l.profit;
      return acc;
    },
    { quoted: 0, received: 0, expenses: 0, profit: 0 }
  );
  res.json({ bookings, totals: { ...totals, outstanding: totals.quoted - totals.received } });
});

// ---------- Payments ledger — supports multiple partial payments per booking ----------
app.get("/api/ledger", requireAuth, requireSection("accounts"), async (req, res) => {
  const leads = (await pool.query("SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed') ORDER BY date ASC")).rows;
  const payments = (await pool.query("SELECT * FROM payments ORDER BY payment_date ASC")).rows;
  const expenses = (await pool.query(`
    SELECT expenses.*, team.name AS team_name FROM expenses
    LEFT JOIN team ON team.id = expenses.team_id
    ORDER BY expenses.created_at ASC
  `)).rows;
  const result = leads.map((l) => {
    const leadPayments = payments.filter((p) => p.lead_id === l.id);
    const leadExpenses = expenses.filter((e) => e.lead_id === l.id);
    const totalReceived = leadPayments.reduce((s, p) => s + p.amount, 0);
    const totalExpenses = leadExpenses.reduce((s, e) => s + e.amount, 0);
    const total = l.final_amount || l.quote_amount || 0;
    return { ...l, payments: leadPayments, expenses: leadExpenses, totalReceived, totalExpenses, profit: total - totalExpenses, balance: total - totalReceived };
  });
  res.json(result);
});

app.get("/api/leads/:id/payments", requireAuth, requireSection("accounts"), async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM payments WHERE lead_id = $1 ORDER BY payment_date ASC", [req.params.id]);
  res.json(rows);
});

app.post("/api/leads/:id/payments", requireAuth, requireSection("accounts"), requireAdmin, async (req, res) => {
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
  logActivity(req, `Payment recorded for ${lead.name}: ₹${Number(amount).toLocaleString("en-IN")}${mode ? ` via ${mode}` : ""}`, lead.id);
});

app.delete("/api/payments/:id", requireAuth, requireSection("accounts"), requireAdmin, async (req, res) => {
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
app.get("/api/transactions", requireAuth, requireSection("accounts"), async (req, res) => {
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

app.get("/api/expenses", requireAuth, requireSection("accounts"), async (req, res) => {
  const { leadId } = req.query;
  const { rows } = leadId
    ? await pool.query("SELECT * FROM expenses WHERE lead_id = $1 ORDER BY created_at DESC", [leadId])
    : await pool.query("SELECT * FROM expenses ORDER BY created_at DESC");
  res.json(rows);
});

app.post("/api/expenses", requireAuth, requireSection("accounts"), requireAdmin, async (req, res) => {
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

app.patch("/api/expenses/:id", requireAuth, requireSection("accounts"), requireAdmin, async (req, res) => {
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

app.delete("/api/expenses/:id", requireAuth, requireSection("accounts"), requireAdmin, async (req, res) => {
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
  let leadName = null;
  if (req.body.leadId) {
    const lead = (await pool.query("SELECT name FROM leads WHERE id = $1", [req.body.leadId])).rows[0];
    leadName = lead?.name;
  }
  logActivity(req, `Document uploaded${req.body.notes ? `: ${req.body.notes}` : ""}${leadName ? ` for ${leadName}` : ""} (${req.file.originalname})`, req.body.leadId || null);
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
// ---------- Message templates — self-service wording for Follow-up / Tentative / Confirmed / Document-share messages ----------
app.get("/api/message-templates", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT key, template FROM message_templates");
  const map = {};
  rows.forEach((r) => (map[r.key] = r.template));
  res.json(map);
});

app.patch("/api/message-templates/:key", requireAuth, requireAdmin, async (req, res) => {
  const { template } = req.body;
  if (typeof template !== "string" || !template.trim()) return res.status(400).json({ error: "Template text is required" });
  await pool.query(`
    INSERT INTO message_templates (key, template, updated_at) VALUES ($1, $2, $3)
    ON CONFLICT (key) DO UPDATE SET template = $2, updated_at = $3
  `, [req.params.key, template, new Date().toISOString()]);
  res.json({ key: req.params.key, template });
});

app.get("/api/activity", requireAuth, async (req, res) => {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const { rows } = await pool.query(
    "SELECT * FROM activity_log WHERE created_at >= $1 ORDER BY created_at ASC",
    [startOfToday.toISOString()]
  );
  res.json(rows);
});

app.delete("/api/activity/:id", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM activity_log WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

app.get("/api/dashboard", requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  const [upcomingRes, followUpsRes, accountsRes, paymentsRes, tasksRes, newLeadsRes, tentativeRes] = await Promise.all([
    pool.query(`SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed') AND date >= $1 ORDER BY date ASC LIMIT 5`, [today]),
    pool.query(`SELECT * FROM leads WHERE stage = 'Follow-up' ORDER BY date ASC`),
    pool.query(`SELECT id, final_amount, quote_amount FROM leads WHERE stage IN ('Confirmed', 'Completed')`),
    pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments`),
    pool.query(`SELECT * FROM tasks WHERE done = 0 AND (due_date <= $1 OR due_date IS NULL) ORDER BY due_date ASC LIMIT 8`, [weekAhead]),
    pool.query(`SELECT COUNT(*) AS c FROM leads WHERE stage = 'New'`),
    pool.query(`SELECT * FROM leads WHERE stage = 'Tentative' ORDER BY date ASC`),
  ]);

  const totalQuoted = accountsRes.rows.reduce((s, l) => s + (l.final_amount || l.quote_amount || 0), 0);
  const totalReceived = Number(paymentsRes.rows[0].total);

  res.json({
    upcomingEvents: upcomingRes.rows,
    pendingFollowUps: followUpsRes.rows,
    tasksDueSoon: tasksRes.rows,
    newLeadsCount: Number(newLeadsRes.rows[0].c),
    tentativeBookings: tentativeRes.rows,
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
