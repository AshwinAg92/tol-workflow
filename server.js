try { require("dotenv").config(); } catch (e) { /* .env is optional */ }
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const nodemailer = require("nodemailer");
const XLSX = require("xlsx");
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

// Documents are stored in Postgres (as bytea), not on local disk — Railway's
// container filesystem is wiped on every redeploy, which was silently losing
// every uploaded file each time we shipped new code. The database is the one
// thing on this project that reliably survives redeploys, so files live there
// via memoryStorage (req.file.buffer) instead of multer.diskStorage.
const upload = multer({
  storage: multer.memoryStorage(),
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
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});
// app.js and index.html change on every deploy but have no cache-busting
// filename (no hash in the URL), so browsers were caching stale copies for
// days — this forces a fresh fetch every time, ending that recurring issue.
app.use(["/app.js", "/index.html", "/home.html"], (req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { index: false }));
// Document files are served from Postgres now — see /api/documents/:id/file below.

// The CRM now lives at /login instead of the domain root, to leave the root
// free for a future marketing site. "/" shows a simple placeholder until that
// site exists — update this if/when the marketing site is built.
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

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
  res.json({ id: user.id, username: user.username, accessLevel: user.access_level, name, permissions, isPerformer: !!user.is_performer, teamId: user.team_id || null });
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
  // The old single `advance` column is dead — nothing writes to it anymore.
  // Real payments live in the payments table (recorded via Accounts, the
  // Confirm-event flow, or combo bookings). Compute the true received total
  // per lead here so every screen shows accurate figures, not a stale ₹0.
  const paymentSums = (await pool.query("SELECT lead_id, COALESCE(SUM(amount), 0) AS total FROM payments GROUP BY lead_id")).rows;
  const receivedByLead = {};
  paymentSums.forEach((p) => (receivedByLead[p.lead_id] = Number(p.total)));
  // So the Leads tab can show "when did I last quote this person" -- helps
  // judge when a follow-up is actually due instead of guessing.
  const lastQuoted = (await pool.query("SELECT lead_id, MAX(created_at) AS last_quoted_at FROM quotes GROUP BY lead_id")).rows;
  const lastQuotedByLead = {};
  lastQuoted.forEach((q) => (lastQuotedByLead[q.lead_id] = q.last_quoted_at));
  const withReceived = rows.map((l) => ({ ...l, received: receivedByLead[l.id] || 0, last_quoted_at: lastQuotedByLead[l.id] || null }));

  let hasLeadsAccess = true;
  if (req.user.access_level === "staff") {
    let perms = null;
    try { perms = req.user.permissions ? JSON.parse(req.user.permissions) : null; } catch { perms = null; }
    if (perms && !perms.includes("leads")) hasLeadsAccess = false;
  }
  if (hasLeadsAccess) return res.json(withReceived);
  // Restricted staff (e.g. a manager who can assign team but not view the pipeline)
  // still need basic event info for the calendar and team assignment — nothing sensitive.
  res.json(withReceived.map((l) => ({
    id: l.id, name: l.name, date: l.date, city: l.city, event_type: l.event_type, stage: l.stage,
    event_time: l.event_time, soundcheck_time: l.soundcheck_time, occasion: l.occasion, venue: l.venue,
    combo_group_id: l.combo_group_id, is_combo_primary: l.is_combo_primary, pcs: l.pcs, duration: l.duration,
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
    venue, occasion, guestRange, details, howHeard, whatsappOptin, altDate, whatsappNumber, pcs,
  } = req.body;
  if (!name || !eventType || !date) {
    return res.status(400).json({ error: "name, eventType, and date are required" });
  }
  // Don't accept a new enquiry for a date we're already Confirmed for — unless
  // they've also given a valid (not-also-booked) alternative date, matching the
  // flexibility the form itself offers. Blocking outright even when a good
  // alternative was given would make that field pointless.
  const dateTaken = (await pool.query(
    "SELECT 1 FROM leads WHERE stage = 'Confirmed' AND date = $1 LIMIT 1", [date]
  )).rows[0];
  if (dateTaken) {
    const altTaken = altDate ? (await pool.query(
      "SELECT 1 FROM leads WHERE stage = 'Confirmed' AND date = $1 LIMIT 1", [altDate]
    )).rows[0] : null;
    if (!altDate || altTaken) {
      return res.status(409).json({
        error: altDate
          ? "We're already booked for both that date and the alternative you gave. Please try a different date."
          : "We're already booked for that date. Please choose a different date, or enter an alternate date below.",
      });
    }
  }
  const id = uuid();
  await pool.query(`
    INSERT INTO leads (
      id, name, phone, email, event_type, city, date, budget, stage, advance, notes, created_at,
      venue, occasion, guest_range, details, how_heard, whatsapp_optin, alt_date, whatsapp_number, pcs
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'New', 0, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
  `, [
    id, name, phone || null, email || null, eventType, city || null, date, budget || null, notes || null, new Date().toISOString(),
    venue || null, occasion || null, guestRange || null,
    details || null, howHeard || null, whatsappOptin ? 1 : 0, altDate || null, whatsappNumber || null, pcs || null,
  ]);
  const created = (await pool.query("SELECT * FROM leads WHERE id = $1", [id])).rows[0];
  res.status(201).json(created);
  logActivity({ user: null }, `New query received: ${name} — ${packageName(eventType)}${city ? ` in ${city}` : ""}`, id);

  // Flashing in-app alert (same feed used for team responses) plus an email —
  // so a new query is hard to miss whether you're in the app or not.
  // Admin-only — a new sales enquiry isn't a manager's concern, unlike the
  // event-coordination notifications below which they now share with admin.
  pool.query(`
    INSERT INTO admin_notifications (id, message, assignment_id, audience, created_at)
    VALUES ($1, $2, NULL, 'admin', $3)
  `, [uuid(), `New query: ${name} — ${packageName(eventType)}${city ? ` in ${city}` : ""}, wants ${date}`, new Date().toISOString()]
  ).catch((err) => console.error("Failed to create new-lead notification:", err.message));

  sendNewLeadEmail(created).catch((err) => console.error("New-lead email failed (not fatal):", err.message));
});

// Public — deliberately no requireAuth: this powers the "Upcoming Events"
// section on the marketing site, so anonymous visitors need to read it.
// Deliberately excludes the client's name — only city/date/occasion/package,
// so no one's private event details get published without their consent.
// ---------- Live Instagram stats (Windsor.ai) — cached, not fetched per-visitor ----------
// Only followers/likes/reel-count are auto-computed here; cities/international
// stay as manual CMS overrides since those need human judgment, not just
// arithmetic on the API response.
let instagramStatsCache = { data: null, fetchedAt: 0 };
const INSTAGRAM_STATS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function fetchLiveInstagramStats() {
  const apiKey = process.env.WINDSOR_API_KEY;
  if (!apiKey) return null;
  const url = `https://connectors.windsor.ai/instagram_public?api_key=${apiKey}&fields=media_like_count,profile_followers_count,profile_media_count&date_preset=last_2years&_renderer=json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Windsor.ai returned ${resp.status}`);
  const json = await resp.json();
  const rows = Array.isArray(json) ? json : (json.data || []);
  if (!rows.length) return null;
  const totalLikes = rows.reduce((sum, r) => sum + (Number(r.media_like_count) || 0), 0);
  const followers = Number(rows[0].profile_followers_count) || null;
  const mediaCount = Number(rows[0].profile_media_count) || null;
  return { followers, totalLikes, mediaCount };
}

app.get("/api/public/live-instagram-stats", async (req, res) => {
  const isFresh = instagramStatsCache.data && (Date.now() - instagramStatsCache.fetchedAt) < INSTAGRAM_STATS_TTL_MS;
  if (isFresh) return res.json(instagramStatsCache.data);
  try {
    const stats = await fetchLiveInstagramStats();
    if (stats) {
      instagramStatsCache = { data: stats, fetchedAt: Date.now() };
      return res.json(stats);
    }
    return res.json(instagramStatsCache.data || {});
  } catch (err) {
    console.error("Live Instagram stats fetch failed:", err.message);
    // Serve the last good cache (even if stale) rather than nothing.
    return res.json(instagramStatsCache.data || {});
  }
});

// ---------- Website traffic (Google Analytics 4, via Windsor.ai) ----------
// Internal-only (unlike Instagram stats above, which feed the public site) —
// this powers a Dashboard card so Ashwin/Prakriti can see visits and traffic
// sources without leaving the CRM to check analytics.google.com. Cached for
// an hour since GA4 itself only settles data every few hours anyway.
let websiteTrafficCache = { data: null, fetchedAt: 0 };
const WEBSITE_TRAFFIC_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchWebsiteTraffic() {
  const apiKey = process.env.WINDSOR_API_KEY;
  if (!apiKey) return null;
  const [byDayResp, byChannelResp] = await Promise.all([
    fetch(`https://connectors.windsor.ai/googleanalytics4?api_key=${apiKey}&fields=date,sessions,active_users,screen_page_views&date_preset=last_30d&_renderer=json`),
    fetch(`https://connectors.windsor.ai/googleanalytics4?api_key=${apiKey}&fields=session_default_channel_group,sessions&date_preset=last_30d&_renderer=json`),
  ]);
  if (!byDayResp.ok) throw new Error(`Windsor.ai returned ${byDayResp.status}`);
  if (!byChannelResp.ok) throw new Error(`Windsor.ai returned ${byChannelResp.status}`);
  const byDayJson = await byDayResp.json();
  const byChannelJson = await byChannelResp.json();
  const byDay = (Array.isArray(byDayJson) ? byDayJson : (byDayJson.data || []))
    .map((r) => ({
      date: r.date,
      sessions: Number(r.sessions) || 0,
      activeUsers: Number(r.active_users) || 0,
      pageViews: Number(r.screen_page_views) || 0,
    }))
    .sort((a, b) => (a.date > b.date ? 1 : -1));
  const byChannel = (Array.isArray(byChannelJson) ? byChannelJson : (byChannelJson.data || []))
    .map((r) => ({ channel: r.session_default_channel_group || "Unassigned", sessions: Number(r.sessions) || 0 }))
    .sort((a, b) => b.sessions - a.sessions);
  const totalSessions = byDay.reduce((s, d) => s + d.sessions, 0);
  const totalUsers = byDay.reduce((s, d) => s + d.activeUsers, 0);
  const totalPageViews = byDay.reduce((s, d) => s + d.pageViews, 0);
  return { byDay, byChannel, totalSessions, totalUsers, totalPageViews };
}

app.get("/api/website-traffic", requireAuth, requireAdmin, async (req, res) => {
  const isFresh = websiteTrafficCache.data && (Date.now() - websiteTrafficCache.fetchedAt) < WEBSITE_TRAFFIC_TTL_MS;
  if (isFresh) return res.json(websiteTrafficCache.data);
  try {
    const traffic = await fetchWebsiteTraffic();
    if (traffic) {
      websiteTrafficCache = { data: traffic, fetchedAt: Date.now() };
      return res.json(traffic);
    }
    return res.json(websiteTrafficCache.data || { byDay: [], byChannel: [], totalSessions: 0, totalUsers: 0, totalPageViews: 0 });
  } catch (err) {
    console.error("Website traffic fetch failed:", err.message);
    return res.json(websiteTrafficCache.data || { byDay: [], byChannel: [], totalSessions: 0, totalUsers: 0, totalPageViews: 0 });
  }
});

app.get("/api/public/upcoming-events", async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(`
    SELECT date, city, event_type, occasion FROM leads
    WHERE stage = 'Confirmed' AND date >= $1
    ORDER BY date ASC LIMIT 30
  `, [today]);
  res.json({
    events: rows.map((r) => ({
      date: r.date, city: r.city, occasion: r.occasion,
      packageName: packageName(r.event_type),
    })),
    totalCount: rows.length,
  });
});

// ---------- Website content management (CMS for the public marketing site) ----------
const SITE_CONTENT_KEYS = ["faqs", "testimonials", "press", "team", "cities", "countries", "services", "hero_banners", "stats_override"];
const SITE_CONTENT_DEFAULTS = {
  faqs: [], testimonials: [], press: [], team: [], cities: [], countries: [], services: [], hero_banners: [], stats_override: {},
};

// Public — powers the marketing site. Anonymous visitors read this.
app.get("/api/public/site-content/:key", async (req, res) => {
  const { key } = req.params;
  if (!SITE_CONTENT_KEYS.includes(key)) return res.status(404).json({ error: "Unknown content key" });
  const row = (await pool.query("SELECT value FROM site_content WHERE key = $1", [key])).rows[0];
  res.json(row ? row.value : SITE_CONTENT_DEFAULTS[key]);
});

// Admin — loads every block at once for the "Website" tab.
app.get("/api/site-content", requireAuth, requireAdmin, async (req, res) => {
  const rows = (await pool.query("SELECT key, value FROM site_content")).rows;
  const byKey = {};
  rows.forEach((r) => (byKey[r.key] = r.value));
  const result = {};
  SITE_CONTENT_KEYS.forEach((k) => (result[k] = byKey[k] !== undefined ? byKey[k] : SITE_CONTENT_DEFAULTS[k]));
  res.json(result);
});

// Real geocoding via OpenStreetMap's free Nominatim service — so any city
// name an admin types gets its actual coordinates looked up automatically,
// instead of relying on a hand-maintained list of known cities.
app.get("/api/geocode-city", requireAuth, requireAdmin, async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=1`;
    const resp = await fetch(url, { headers: { "User-Agent": "TogetherOutLoudWebsite/1.0 (togetheroutloudclub@gmail.com)" } });
    if (!resp.ok) throw new Error(`Nominatim returned ${resp.status}`);
    const results = await resp.json();
    if (!results.length) return res.json({ found: false });
    res.json({ found: true, lat: Number(results[0].lat), lng: Number(results[0].lon), displayName: results[0].display_name });
  } catch (err) {
    console.error("Geocoding failed for", name, ":", err.message);
    res.json({ found: false });
  }
});

app.put("/api/site-content/:key", requireAuth, requireAdmin, async (req, res) => {
  const { key } = req.params;
  if (!SITE_CONTENT_KEYS.includes(key)) return res.status(404).json({ error: "Unknown content key" });
  const { value } = req.body;
  await pool.query(`
    INSERT INTO site_content (key, value, updated_at) VALUES ($1, $2, $3)
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3
  `, [key, JSON.stringify(value), new Date().toISOString()]);
  logActivity(req, `Updated website content: ${key}`, null);
  res.json({ ok: true });
});

// ---------- Website gallery (images stored in Postgres — see documents note on why) ----------
app.get("/api/public/gallery", async (req, res) => {
  const { rows } = await pool.query("SELECT id, caption, sort_order FROM site_gallery_images WHERE category = 'gallery' ORDER BY sort_order ASC, uploaded_at ASC");
  res.json(rows.map((r) => ({ id: r.id, caption: r.caption, url: `/api/public/gallery/${r.id}/file` })));
});

// Press clippings — same storage, different category, so they show in the
// Press section's image strip instead of the general Gallery.
app.get("/api/public/press-images", async (req, res) => {
  const { rows } = await pool.query("SELECT id, caption, sort_order FROM site_gallery_images WHERE category = 'press' ORDER BY sort_order ASC, uploaded_at ASC");
  res.json(rows.map((r) => ({ id: r.id, caption: r.caption, url: `/api/public/gallery/${r.id}/file` })));
});

app.get("/api/public/gallery/:id/file", async (req, res) => {
  const row = (await pool.query("SELECT mime_type, file_data FROM site_gallery_images WHERE id = $1", [req.params.id])).rows[0];
  if (!row || !row.file_data) return res.status(404).send("Not found");
  res.setHeader("Content-Type", row.mime_type || "image/jpeg");
  res.send(row.file_data);
});

app.get("/api/gallery", requireAuth, requireAdmin, async (req, res) => {
  const { category } = req.query;
  const { rows } = category
    ? await pool.query("SELECT id, caption, sort_order, uploaded_at, category FROM site_gallery_images WHERE category = $1 ORDER BY sort_order ASC, uploaded_at ASC", [category])
    : await pool.query("SELECT id, caption, sort_order, uploaded_at, category FROM site_gallery_images ORDER BY sort_order ASC, uploaded_at ASC");
  res.json(rows.map((r) => ({ ...r, url: `/api/public/gallery/${r.id}/file` })));
});

app.post("/api/gallery", requireAuth, requireAdmin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const category = req.body.category === "press" ? "press" : "gallery";
  const id = uuid();
  const maxOrder = (await pool.query("SELECT COALESCE(MAX(sort_order), 0) AS m FROM site_gallery_images WHERE category = $1", [category])).rows[0].m;
  await pool.query(`
    INSERT INTO site_gallery_images (id, caption, mime_type, file_data, sort_order, uploaded_at, category)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [id, req.body.caption || null, req.file.mimetype, req.file.buffer, Number(maxOrder) + 1, new Date().toISOString(), category]);
  res.status(201).json({ id, url: `/api/public/gallery/${id}/file` });
  logActivity(req, `Added ${category === "press" ? "press image" : "gallery image"}${req.body.caption ? `: ${req.body.caption}` : ""}`, null);
});

app.patch("/api/gallery/:id", requireAuth, requireAdmin, async (req, res) => {
  const { caption, sortOrder } = req.body;
  await pool.query(`
    UPDATE site_gallery_images SET caption = COALESCE($1, caption), sort_order = COALESCE($2, sort_order) WHERE id = $3
  `, [caption ?? null, sortOrder ?? null, req.params.id]);
  res.json({ ok: true });
});

app.delete("/api/gallery/:id", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM site_gallery_images WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// Combo booking: one client confirming multiple formats/dates under a single
// combined price (e.g. Bhajan Jamming on the 20th + Musical Pheras on the
// 21st, priced as one package). Creates one lead per format/date, linked via
// combo_group_id. Only the first ("primary") lead carries the quote/final
// amount, so Accounts/profit totals aren't double-counted across the group —
// the others just point back to it for display.
app.post("/api/leads/combo", requireAuth, async (req, res) => {
  const { name, phone, email, city, occasion, guestRange, events, budget, finalAmount, alreadyConfirmed, advanceAmount, advanceDate, advanceMode } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });
  if (!Array.isArray(events) || events.length < 2) return res.status(400).json({ error: "Provide at least two format/date combinations for a combo booking" });
  for (const e of events) {
    if (!e.eventType || !e.date) return res.status(400).json({ error: "Each event needs a format and a date" });
  }
  const comboGroupId = uuid();
  const now = new Date().toISOString();
  const createdIds = [];
  for (let i = 0; i < events.length; i++) {
    const isPrimary = i === 0;
    const id = uuid();
    await pool.query(`
      INSERT INTO leads (
        id, name, phone, email, event_type, city, date, budget, stage, advance,
        quote_amount, final_amount, occasion, guest_range, combo_group_id, is_combo_primary, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15,$16)
    `, [
      id, name, phone || null, email || null, events[i].eventType, city || null, events[i].date,
      isPrimary ? (budget || null) : null,
      alreadyConfirmed ? "Confirmed" : "New",
      isPrimary ? (budget || null) : null,
      isPrimary && alreadyConfirmed ? (finalAmount || null) : null,
      occasion || null, guestRange || null, comboGroupId, isPrimary ? 1 : 0, now,
    ]);
    createdIds.push(id);
  }
  if (alreadyConfirmed && advanceAmount && Number(advanceAmount) > 0 && advanceDate) {
    await pool.query(`
      INSERT INTO payments (id, lead_id, amount, payment_date, payment_mode, notes, created_at)
      VALUES ($1, $2, $3, $4, $5, NULL, $6)
    `, [uuid(), createdIds[0], Number(advanceAmount), advanceDate, advanceMode || null, now]);
  }
  const rows = (await pool.query("SELECT * FROM leads WHERE id = ANY($1::text[]) ORDER BY date ASC", [createdIds])).rows;
  res.status(201).json(rows);
  logActivity(req, `Combo booking added for ${name}: ${events.map((e) => packageName(e.eventType)).join(" + ")}${alreadyConfirmed && finalAmount ? ` — ₹${Number(finalAmount).toLocaleString("en-IN")}` : ""}`, createdIds[0]);
});

app.patch("/api/leads/:id", requireAuth, async (req, res) => {
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const hasLeads = userHasSection(req.user, "leads");
  const canAssignTeam = userHasSection(req.user, "assign_team");
  if (!hasLeads && !canAssignTeam) return res.status(403).json({ error: "You don't have permission to update this event" });

  // Completed events are a closed record — no edits at all, with one deliberate
  // escape hatch: a Leads-access user can move the stage away from Completed
  // (as a standalone action) to "reopen" it if something genuinely needs
  // correcting, after which normal editing rules apply again.
  if (lead.stage === "Completed") {
    const onlyReopening = Object.keys(req.body).length === 1 && req.body.stage !== undefined && req.body.stage !== "Completed";
    if (!onlyReopening) {
      return res.status(403).json({ error: "Completed events can't be edited — they're a closed record. Change the stage away from Completed first if something needs correcting." });
    }
    if (!hasLeads) return res.status(403).json({ error: "Only a Leads-access user can reopen a Completed event." });
  }

  // Event day timing is editable by anyone who can plan the team for an event
  // (a manager without full Leads access included); everything else — stage,
  // amounts, notes — needs full Leads access.
  const leadsOnlyFields = [
    "stage", "assigned_to", "advance", "advance_date", "quote_amount", "final_amount", "notes", "date",
    "name", "phone", "email", "city", "event_type", "occasion", "guest_range", "pcs", "duration", "whatsapp_number",
    "cancellation_reason",
  ];
  const sharedFields = ["event_time", "soundcheck_time", "venue"];
  if (!hasLeads) {
    const keyFor = (f) => (f === "assigned_to" ? "assignedTo" : f === "advance_date" ? "advanceDate" : f === "quote_amount" ? "quoteAmount" : f === "final_amount" ? "finalAmount" : f === "event_type" ? "eventType" : f === "guest_range" ? "guestRange" : f === "whatsapp_number" ? "whatsappNumber" : f);
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
    const key = f === "assigned_to" ? "assignedTo" : f === "quote_amount" ? "quoteAmount" : f === "final_amount" ? "finalAmount" : f === "advance_date" ? "advanceDate" : f === "event_time" ? "eventTime" : f === "soundcheck_time" ? "soundcheckTime" : f === "event_type" ? "eventType" : f === "guest_range" ? "guestRange" : f === "whatsapp_number" ? "whatsappNumber" : f;
    if (req.body[key] !== undefined) {
      values.push(req.body[key]);
      updates.push(`${f} = $${values.length}`);
    }
  });
  // logFollowup is a trigger, not a raw field — the timestamp is always set
  // server-side (never trust a client-supplied clock) so "last followed up"
  // stays accurate regardless of who's clicking it or from where.
  if (hasLeads && req.body.logFollowup === true) {
    values.push(new Date().toISOString());
    updates.push(`last_followup_at = $${values.length}`);
  }
  if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });

  values.push(req.params.id);
  await pool.query(`UPDATE leads SET ${updates.join(", ")} WHERE id = $${values.length}`, values);

  // If this event just got cancelled, tell everyone who was assigned to it.
  if (req.body.stage === "Cancelled" && lead.stage !== "Cancelled") {
    const assigned = (await pool.query("SELECT team_id FROM event_assignments WHERE lead_id = $1", [req.params.id])).rows;
    const now = new Date().toISOString();
    const reasonSuffix = req.body.cancellation_reason ? ` Reason: ${req.body.cancellation_reason}` : "";
    for (const a of assigned) {
      await pool.query(`
        INSERT INTO notifications (id, team_id, message, created_at)
        VALUES ($1, $2, $3, $4)
      `, [uuid(), a.team_id, `Event cancelled: ${lead.name} on ${lead.date}${lead.city ? ` in ${lead.city}` : ""} — no longer happening.${reasonSuffix}`, now]);
    }
  }

  res.json((await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0]);

  if (req.body.stage !== undefined && req.body.stage !== lead.stage) {
    if (req.body.stage === "Confirmed") {
      const amt = req.body.finalAmount ? ` — ₹${Number(req.body.finalAmount).toLocaleString("en-IN")}` : "";
      logActivity(req, `Confirmed: ${lead.name}${amt}`, lead.id);
      // Surfaced in the shared admin/manager notifications feed too — a new
      // Confirmed event usually means artists need staffing soon.
      pool.query(`
        INSERT INTO admin_notifications (id, message, assignment_id, created_at)
        VALUES ($1, $2, NULL, $3)
      `, [uuid(), `New event confirmed: ${lead.name} on ${lead.date}${lead.city ? ` in ${lead.city}` : ""} — needs staffing.`, new Date().toISOString()]).catch(() => {});
    } else {
      const reasonSuffix = req.body.stage === "Cancelled" && req.body.cancellation_reason ? ` — ${req.body.cancellation_reason}` : "";
      logActivity(req, `${lead.name}: ${lead.stage} → ${req.body.stage}${reasonSuffix}`, lead.id);
    }
  } else if (req.body.advance !== undefined && Number(req.body.advance) !== Number(lead.advance || 0)) {
    logActivity(req, `Payment recorded for ${lead.name}: ₹${Number(req.body.advance).toLocaleString("en-IN")} received`, lead.id);
  }
});

// Permanently delete a single lead/event and everything tied to it. Distinct
// from "Cancel" (a stage, keeps the record) and "Clear demo data" (scoped to
// the 7 seed leads only) — this is for removing any one real record entirely.
app.delete("/api/leads/:id", requireAuth, requireAdmin, async (req, res) => {
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  if (lead.stage === "Completed") {
    return res.status(403).json({ error: "Completed events can't be deleted — they're a closed record of past business." });
  }

  const assignmentIds = (await pool.query("SELECT id FROM event_assignments WHERE lead_id = $1", [req.params.id])).rows.map((r) => r.id);
  if (assignmentIds.length > 0) {
    await pool.query("DELETE FROM admin_notifications WHERE assignment_id = ANY($1::text[])", [assignmentIds]);
  }
  await pool.query("DELETE FROM event_assignments WHERE lead_id = $1", [req.params.id]);
  await pool.query("DELETE FROM event_messages WHERE lead_id = $1", [req.params.id]);
  await pool.query("DELETE FROM temp_artists WHERE lead_id = $1", [req.params.id]);
  await pool.query("DELETE FROM expenses WHERE lead_id = $1", [req.params.id]);
  await pool.query("DELETE FROM quotes WHERE lead_id = $1", [req.params.id]);
  await pool.query("DELETE FROM payments WHERE lead_id = $1", [req.params.id]);
  await pool.query("DELETE FROM tasks WHERE lead_id = $1", [req.params.id]);
  await pool.query("DELETE FROM documents WHERE lead_id = $1", [req.params.id]);
  await pool.query("DELETE FROM notifications WHERE lead_id = $1", [req.params.id]);
  await pool.query("DELETE FROM activity_log WHERE lead_id = $1", [req.params.id]);
  await pool.query("DELETE FROM leads WHERE id = $1", [req.params.id]);

  res.status(204).end();
  logActivity(req, `Deleted event/lead: ${lead.name}`);
});

// ---------- Quotation ----------
// The quote text is built and edited entirely in the browser (so Ashwin can
// change wording, amount, or anything else himself without needing a code
// change). This endpoint just records the amount + stage, and turns the
// final text into a WhatsApp link and a mailto link.
app.post("/api/leads/:id/quote", requireAuth, async (req, res) => {
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const { amount, subject, body, pcs, duration } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Quote text is required" });

  const numericAmount = amount !== undefined && amount !== null && amount !== "" ? Number(amount) : null;
  const finalSubject = subject && subject.trim() ? subject : "Quotation — Together, Out Loud";

  const newStage = (lead.stage === "New") ? "Follow-up" : lead.stage;
  await pool.query(
    "UPDATE leads SET quote_amount = $1, stage = $2, pcs = COALESCE($3, pcs), duration = COALESCE($4, duration) WHERE id = $5",
    [numericAmount, newStage, pcs || null, duration || null, lead.id]
  );
  await pool.query(`
    INSERT INTO quotes (id, lead_id, subject, body, amount, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [uuid(), lead.id, finalSubject, body, numericAmount, new Date().toISOString()]);

  // WhatsApp click-to-chat needs just digits (country code + number, no + or spaces).
  const digitsOnly = (lead.whatsapp_number || lead.phone || "").replace(/\D/g, "");
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

// Tracks a quote through to accepted/rejected instead of leaving it as just
// "sent" forever — purely informational, doesn't touch the lead's stage.
app.patch("/api/quotes/:id", requireAuth, async (req, res) => {
  const { status } = req.body;
  if (!["sent", "accepted", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid status" });
  const { rows } = await pool.query("UPDATE quotes SET status = $1 WHERE id = $2 RETURNING *", [status, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Quote not found" });
  res.json(rows[0]);
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

// A manager (or admin) can record an artist's response on their behalf — many
// artists don't use their own login, so this is how their accept/decline gets
// captured instead of waiting on /api/my/assignments/:id/respond.
app.patch("/api/assignments/:id/mark-response", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const a = (await pool.query("SELECT * FROM event_assignments WHERE id = $1", [req.params.id])).rows[0];
  if (!a) return res.status(404).json({ error: "Assignment not found" });
  const { status } = req.body;
  if (!["pending", "accepted", "declined"].includes(status)) return res.status(400).json({ error: "status must be 'pending', 'accepted' or 'declined'" });
  await pool.query("UPDATE event_assignments SET status = $1, responded_at = $2 WHERE id = $3", [
    status, status === "pending" ? null : new Date().toISOString(), a.id,
  ]);
  const lead = (await pool.query("SELECT name, date FROM leads WHERE id = $1", [a.lead_id])).rows[0];
  const member = (await pool.query("SELECT name FROM team WHERE id = $1", [a.team_id])).rows[0];
  if (lead) {
    logActivity(req, `Marked ${member ? member.name : "artist"} as ${status} for ${lead.name} (${lead.date})`, a.lead_id);
  }
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
  const isAdmin = req.user.access_level === "admin";
  if (!isAdmin && feeAmount !== undefined && feeAmount !== null && feeAmount !== "") {
    return res.status(403).json({ error: "Only an admin can set artist fees" });
  }
  const id = uuid();
  const now = new Date().toISOString();
  let expenseId = null;
  if (isAdmin && feeAmount !== undefined && feeAmount !== null && feeAmount !== "") {
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

// Fee changes are admin-only (financial data); name/phone/description can be
// fixed by any manager with assign_team, since that's just correcting who
// they wrote down, not touching money.
app.patch("/api/temp-artists/:id", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const artist = (await pool.query("SELECT * FROM temp_artists WHERE id = $1", [req.params.id])).rows[0];
  if (!artist) return res.status(404).json({ error: "Not found" });
  const { feeAmount, name, phone, description } = req.body;
  const isAdmin = req.user.access_level === "admin";
  if (feeAmount !== undefined) {
    if (!isAdmin) return res.status(403).json({ error: "Only an admin can set or change artist fees" });
    if (feeAmount !== null && feeAmount !== "" && (isNaN(Number(feeAmount)) || Number(feeAmount) < 0)) {
      return res.status(400).json({ error: "Enter a valid fee amount" });
    }
    const hasFee = feeAmount !== null && feeAmount !== "";
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
  }
  if (name !== undefined || phone !== undefined || description !== undefined) {
    await pool.query(`
      UPDATE temp_artists SET name = COALESCE($1, name), phone = COALESCE($2, phone), description = COALESCE($3, description) WHERE id = $4
    `, [name ?? null, phone ?? null, description ?? null, artist.id]);
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
      leads.name AS lead_name, leads.date, leads.city, leads.event_type, leads.stage, leads.event_time, leads.soundcheck_time, leads.occasion, leads.venue,
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
// A manager coordinating events can resolve these too, not just admin.
app.post("/api/assignments/:id/resolve-cancel", requireAuth, requireCapability("assign_team"), async (req, res) => {
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

// Managers (assign_team capability) see this feed too, not just admin — they're
// usually the ones coordinating artists day-to-day, so seeing accept/decline and
// cancellation requests here (not just the admin) avoids everything routing
// through one person. New sales-lead alerts (audience='admin') stay admin-only.
app.get("/api/admin/notifications", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const isAdmin = req.user.access_level === "admin";
  const { rows } = await pool.query(`
    SELECT admin_notifications.*, event_assignments.status AS assignment_status
    FROM admin_notifications
    LEFT JOIN event_assignments ON event_assignments.id = admin_notifications.assignment_id
    ${isAdmin ? "" : "WHERE admin_notifications.audience = 'coordination'"}
    ORDER BY admin_notifications.created_at DESC LIMIT 15
  `);
  res.json(rows);
});

app.delete("/api/admin/notifications/:id", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const isAdmin = req.user.access_level === "admin";
  if (!isAdmin) {
    const n = (await pool.query("SELECT audience FROM admin_notifications WHERE id = $1", [req.params.id])).rows[0];
    if (n && n.audience !== "coordination") return res.status(403).json({ error: "Not yours to dismiss" });
  }
  await pool.query("DELETE FROM admin_notifications WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

app.delete("/api/admin/notifications", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const isAdmin = req.user.access_level === "admin";
  await pool.query(isAdmin ? "DELETE FROM admin_notifications" : "DELETE FROM admin_notifications WHERE audience = 'coordination'");
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

  if (req.user.access_level !== "admin") {
    const lead = (await pool.query("SELECT name FROM leads WHERE id = $1", [req.params.leadId])).rows[0];
    const snippet = body.length > 60 ? `${body.slice(0, 60)}…` : body;
    await pool.query(`
      INSERT INTO admin_notifications (id, message, assignment_id, created_at)
      VALUES ($1, $2, NULL, $3)
    `, [uuid(), `${authorName} messaged in ${lead?.name || "an event"}: "${snippet}"`, new Date().toISOString()]);
  }
});

// General (not tied to any event) message from a manager/performer to admin --
// simple one-way notification, not a full thread, so it can piggyback on the
// same admin_notifications feed and flashing card the event chats use.
app.post("/api/messages/general", requireAuth, async (req, res) => {
  if (req.user.access_level === "admin") return res.status(400).json({ error: "You're already the admin." });
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Message can't be empty" });
  let authorName = req.user.username;
  if (req.user.team_id) {
    const t = (await pool.query("SELECT name FROM team WHERE id = $1", [req.user.team_id])).rows[0];
    if (t) authorName = t.name;
  }
  await pool.query(`
    INSERT INTO admin_notifications (id, message, assignment_id, audience, created_at)
    VALUES ($1, $2, NULL, 'admin', $3)
  `, [uuid(), `${authorName}: "${body.trim()}"`, new Date().toISOString()]);
  res.status(201).json({ ok: true });
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
      leads.event_time, leads.soundcheck_time, leads.occasion, leads.venue,
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
  // Unapproved reimbursements aren't real commitments yet — they only count
  // toward expenses/profit once an admin approves them.
  const expenseSums = (await pool.query(`
    SELECT lead_id, COALESCE(SUM(amount), 0) AS total
    FROM expenses WHERE lead_id = ANY($1::text[]) AND approved = 1 GROUP BY lead_id
  `, [rows.map((r) => r.id)])).rows;
  const expensesByLead = {};
  expenseSums.forEach((e) => (expensesByLead[e.lead_id] = Number(e.total)));

  const perLead = rows.map((l) => {
    const revenue = l.final_amount || l.quote_amount || 0;
    const expenses = expensesByLead[l.id] || 0;
    if (l.combo_group_id) {
      const groupLeadIds = rows.filter((r) => r.combo_group_id === l.combo_group_id).map((r) => r.id);
      const groupExpenses = groupLeadIds.reduce((sum, id) => sum + (expensesByLead[id] || 0), 0);
      if (l.is_combo_primary) {
        // Primary carries the combined price — its profit accounts for every
        // linked event's expenses, not just its own, so the group nets out
        // correctly instead of splitting oddly across rows.
        return { ...l, received: receivedByLead[l.id] || 0, expenses, profit: revenue - groupExpenses };
      }
      // Non-primary combo events have no revenue of their own by design (the
      // price lives on the primary) — show their own expenses for visibility,
      // but skip a per-row profit figure since it would misleadingly look
      // negative even though the group as a whole may be profitable.
      return { ...l, received: receivedByLead[l.id] || 0, expenses, profit: null };
    }
    return { ...l, received: receivedByLead[l.id] || 0, expenses, profit: revenue - expenses };
  });

  // Collapse each combo group into one row for display — Disha's Bhajan
  // Jamming + Musical Pheras should read as one booking in Accounts, not two,
  // even though they're separate leads underneath for calendar/team planning.
  const seenCombo = new Set();
  const bookings = [];
  for (const l of perLead) {
    if (!l.combo_group_id) { bookings.push(l); continue; }
    if (seenCombo.has(l.combo_group_id)) continue;
    seenCombo.add(l.combo_group_id);
    const group = perLead.filter((x) => x.combo_group_id === l.combo_group_id);
    const primary = group.find((x) => x.is_combo_primary) || group[0];
    bookings.push({
      ...primary,
      comboEvents: group.map((x) => ({ id: x.id, event_type: x.event_type, date: x.date })),
      received: group.reduce((s, x) => s + x.received, 0),
      expenses: group.reduce((s, x) => s + x.expenses, 0),
      profit: primary.profit,
    });
  }
  const totals = bookings.reduce(
    (acc, l) => {
      acc.quoted += l.final_amount || l.quote_amount || 0;
      acc.received += l.received;
      acc.expenses += l.expenses;
      acc.profit += l.profit || 0;
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
    WHERE expenses.approved = 1
    ORDER BY expenses.created_at ASC
  `)).rows;
  const perLead = leads.map((l) => {
    const leadPayments = payments.filter((p) => p.lead_id === l.id);
    const leadExpenses = expenses.filter((e) => e.lead_id === l.id);
    const totalReceived = leadPayments.reduce((s, p) => s + p.amount, 0);
    const totalExpenses = leadExpenses.reduce((s, e) => s + e.amount, 0);
    const total = l.final_amount || l.quote_amount || 0;
    return { ...l, payments: leadPayments, expenses: leadExpenses, totalReceived, totalExpenses, profit: total - totalExpenses, balance: total - totalReceived };
  });

  // Combo bookings collapse into a single ledger entry — combined payments,
  // combined expenses across every linked event, one balance/profit figure —
  // so the client picker and ledger detail show one "Disha", not two.
  const seenCombo = new Set();
  const result = [];
  for (const l of perLead) {
    if (!l.combo_group_id) { result.push(l); continue; }
    if (seenCombo.has(l.combo_group_id)) continue;
    seenCombo.add(l.combo_group_id);
    const group = perLead.filter((x) => x.combo_group_id === l.combo_group_id);
    const primary = group.find((x) => x.is_combo_primary) || group[0];
    const total = primary.final_amount || primary.quote_amount || 0;
    const totalExpenses = group.reduce((s, x) => s + x.totalExpenses, 0);
    const totalReceived = group.reduce((s, x) => s + x.totalReceived, 0);
    result.push({
      ...primary,
      comboEvents: group.map((x) => ({ id: x.id, event_type: x.event_type, date: x.date })),
      payments: group.flatMap((x) => x.payments),
      expenses: group.flatMap((x) => x.expenses),
      totalReceived,
      totalExpenses,
      profit: total - totalExpenses,
      balance: total - totalReceived,
    });
  }
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
    WHERE e.paid = 1 AND e.payment_date IS NOT NULL AND e.approved = 1

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
  // Unapproved reimbursements live in their own approval queue (/api/reimbursements/pending)
  // rather than mixing into the general expenses list until an admin signs off on them.
  const { rows } = leadId
    ? await pool.query("SELECT * FROM expenses WHERE lead_id = $1 AND approved = 1 ORDER BY created_at DESC", [leadId])
    : await pool.query("SELECT * FROM expenses WHERE approved = 1 ORDER BY created_at DESC");
  res.json(rows);
});

// A manager who's also a performer can see their own fee for an event — never
// anyone else's, and never through the general Accounts data. Deliberately
// separate from /api/expenses so this doesn't require "accounts" access.
app.get("/api/my/artist-fee", requireAuth, async (req, res) => {
  const { leadId } = req.query;
  if (!req.user.team_id || !leadId) return res.json(null);
  const row = (await pool.query(
    "SELECT amount, paid FROM expenses WHERE lead_id = $1 AND team_id = $2 AND head LIKE 'Artist fee — %' AND approved = 1 LIMIT 1",
    [leadId, req.user.team_id]
  )).rows[0];
  res.json(row || null);
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

// ---------- Reimbursements — a manager can log an artist's out-of-pocket expense ----------
// without needing Accounts access. It's stored as a normal expense (so it's ready
// to flow into profit/expense totals once live) but with approved=0, so it stays
// invisible everywhere financial (Accounts totals, pending expenses, profit) until
// an admin reviews it and approves — at which point they also set the payment
// details, same as any other expense.
app.post("/api/reimbursements", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const { leadId, teamId, artistName, amount, notes } = req.body;
  if (amount === undefined || amount === null || amount === "" || isNaN(Number(amount)) || Number(amount) < 0) {
    return res.status(400).json({ error: "Enter a valid amount" });
  }
  let resolvedName = artistName;
  if (teamId) {
    const member = (await pool.query("SELECT name FROM team WHERE id = $1", [teamId])).rows[0];
    if (!member) return res.status(400).json({ error: "Artist not found" });
    resolvedName = member.name;
  }
  if (!resolvedName) return res.status(400).json({ error: "Choose an artist or enter a name" });
  const id = uuid();
  const requestedBy = await actorName(req.user);
  await pool.query(`
    INSERT INTO expenses (id, lead_id, team_id, head, amount, paid, notes, created_at, category, approved, requested_by)
    VALUES ($1, $2, $3, $4, $5, 0, $6, $7, 'reimbursement', 0, $8)
  `, [id, leadId || null, teamId || null, `Reimbursement — ${resolvedName}`, Number(amount), notes || null, new Date().toISOString(), requestedBy]);
  const row = (await pool.query("SELECT * FROM expenses WHERE id = $1", [id])).rows[0];
  res.status(201).json(row);
  const lead = leadId ? (await pool.query("SELECT name, date FROM leads WHERE id = $1", [leadId])).rows[0] : null;
  logActivity(req, `Reimbursement requested for ${resolvedName}${lead ? ` (${lead.name})` : ""} — ₹${Number(amount).toLocaleString("en-IN")}, pending admin approval`, leadId || null);
});

// A manager can see the status of reimbursements they personally submitted,
// without needing the "accounts" section that would expose everyone else's numbers.
app.get("/api/my/reimbursements", requireAuth, async (req, res) => {
  const requestedBy = await actorName(req.user);
  const { rows } = await pool.query(
    "SELECT * FROM expenses WHERE category = 'reimbursement' AND requested_by = $1 ORDER BY created_at DESC",
    [requestedBy]
  );
  res.json(rows);
});

// Admin-only: all reimbursements awaiting approval, across every artist/event.
app.get("/api/reimbursements/pending", requireAuth, requireSection("accounts"), requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM expenses WHERE category = 'reimbursement' AND approved = 0 ORDER BY created_at ASC"
  );
  res.json(rows);
});

// Admin approves a reimbursement, setting payment details in the same step (or
// leaving it unpaid, to be settled later like any other expense).
app.post("/api/reimbursements/:id/approve", requireAuth, requireSection("accounts"), requireAdmin, async (req, res) => {
  const exp = (await pool.query("SELECT * FROM expenses WHERE id = $1 AND category = 'reimbursement'", [req.params.id])).rows[0];
  if (!exp) return res.status(404).json({ error: "Reimbursement not found" });
  const { paid, paymentDate, paymentMode, amount } = req.body;
  const nowPaid = paid ? 1 : 0;
  await pool.query(`
    UPDATE expenses SET approved = 1, amount = $1, paid = $2, payment_date = $3, payment_mode = $4 WHERE id = $5
  `, [
    amount !== undefined && amount !== null && amount !== "" ? Number(amount) : exp.amount,
    nowPaid,
    nowPaid ? (paymentDate || new Date().toISOString().slice(0, 10)) : (paymentDate || null),
    paymentMode || null,
    exp.id,
  ]);
  const updated = (await pool.query("SELECT * FROM expenses WHERE id = $1", [exp.id])).rows[0];
  res.json(updated);
  logActivity(req, `Approved reimbursement: ${exp.head} — ₹${Number(updated.amount).toLocaleString("en-IN")}${nowPaid ? " (paid)" : ""}`, exp.lead_id);
});

// Admin rejects a reimbursement request outright — just removes it.
app.delete("/api/reimbursements/:id", requireAuth, requireSection("accounts"), requireAdmin, async (req, res) => {
  const exp = (await pool.query("SELECT * FROM expenses WHERE id = $1 AND category = 'reimbursement'", [req.params.id])).rows[0];
  if (!exp) return res.status(404).json({ error: "Reimbursement not found" });
  await pool.query("DELETE FROM expenses WHERE id = $1", [exp.id]);
  res.status(204).end();
  logActivity(req, `Rejected reimbursement request: ${exp.head} — ₹${Number(exp.amount).toLocaleString("en-IN")}`, exp.lead_id);
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
// File bytes live in Postgres (bytea), not on disk — see the memory-storage
// note above. List/attach queries deliberately exclude file_data so listing
// documents doesn't ship megabytes of base64 on every page load; the actual
// bytes are only read out in the dedicated /file route below.
const DOC_LIST_COLUMNS = "id, lead_id, original_name, notes, uploaded_at";

app.get("/api/documents", requireAuth, async (req, res) => {
  const { leadId } = req.query;
  const { rows } = leadId
    ? await pool.query(`SELECT ${DOC_LIST_COLUMNS} FROM documents WHERE lead_id = $1 ORDER BY uploaded_at DESC`, [leadId])
    : await pool.query(`SELECT ${DOC_LIST_COLUMNS} FROM documents ORDER BY uploaded_at DESC`);
  res.json(rows.map((d) => ({ ...d, url: `/api/documents/${d.id}/file` })));
});

// Deliberately public (no requireAuth) — this is the link sent to clients over
// WhatsApp, who have no session with the app. Same security model as the old
// disk-based /uploads/:storedName route: unguessable UUID, not indexed anywhere.
app.get("/api/documents/:id/file", async (req, res) => {
  const doc = (await pool.query("SELECT original_name, mime_type, file_data FROM documents WHERE id = $1", [req.params.id])).rows[0];
  if (!doc || !doc.file_data) return res.status(404).send("File not found");
  res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.original_name)}"`);
  res.send(doc.file_data);
});

app.post("/api/documents", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const id = uuid();
  await pool.query(`
    INSERT INTO documents (id, lead_id, original_name, notes, uploaded_at, mime_type, file_data)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [id, req.body.leadId || null, req.file.originalname, req.body.notes || null, new Date().toISOString(), req.file.mimetype, req.file.buffer]);
  const doc = (await pool.query(`SELECT ${DOC_LIST_COLUMNS} FROM documents WHERE id = $1`, [id])).rows[0];
  res.status(201).json({ ...doc, url: `/api/documents/${doc.id}/file` });
  let leadName = null;
  if (req.body.leadId) {
    const lead = (await pool.query("SELECT name FROM leads WHERE id = $1", [req.body.leadId])).rows[0];
    leadName = lead?.name;
  }
  logActivity(req, `Document uploaded${req.body.notes ? `: ${req.body.notes}` : ""}${leadName ? ` for ${leadName}` : ""} (${req.file.originalname})`, req.body.leadId || null);
});

app.delete("/api/documents/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM documents WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// Copies a document from the general library onto a specific event, without
// re-uploading — the bytes are duplicated into a new row (not just referenced),
// so deleting either copy later never breaks the other one.
app.post("/api/documents/:id/attach", requireAuth, async (req, res) => {
  const source = (await pool.query("SELECT * FROM documents WHERE id = $1", [req.params.id])).rows[0];
  if (!source) return res.status(404).json({ error: "Document not found" });
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: "leadId is required" });
  const lead = (await pool.query("SELECT name FROM leads WHERE id = $1", [leadId])).rows[0];
  if (!lead) return res.status(404).json({ error: "Event not found" });
  if (!source.file_data) return res.status(500).json({ error: "This document's file is missing and can't be attached — try re-uploading it." });
  const id = uuid();
  await pool.query(`
    INSERT INTO documents (id, lead_id, original_name, notes, uploaded_at, mime_type, file_data)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [id, leadId, source.original_name, source.notes, new Date().toISOString(), source.mime_type, source.file_data]);
  const doc = (await pool.query(`SELECT ${DOC_LIST_COLUMNS} FROM documents WHERE id = $1`, [id])).rows[0];
  res.status(201).json({ ...doc, url: `/api/documents/${doc.id}/file` });
  logActivity(req, `Attached document "${source.notes || source.original_name}" to ${lead.name}`, leadId);
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

app.get("/api/activity", requireAuth, requireAdmin, async (req, res) => {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const { rows } = await pool.query(
    "SELECT * FROM activity_log WHERE created_at >= $1 ORDER BY created_at ASC",
    [startOfToday.toISOString()]
  );
  res.json(rows);
});

// Full, read-only activity history (no delete) — a genuine audit trail as
// opposed to the dashboard's "Today's activity" widget, which is meant to be
// clearable like a to-do list. Capped at 300 rows, newest first.
app.get("/api/activity/history", requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 300");
  res.json(rows);
});

app.delete("/api/activity/:id", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM activity_log WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

app.delete("/api/activity", requireAuth, requireAdmin, async (req, res) => {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  await pool.query("DELETE FROM activity_log WHERE created_at >= $1", [startOfToday.toISOString()]);
  res.status(204).end();
});

// ---------- Sticky note — personal, per-login scratchpad on the Dashboard ----------
app.get("/api/my/sticky-note", requireAuth, async (req, res) => {
  const row = (await pool.query("SELECT content FROM sticky_notes WHERE user_id = $1", [req.user.id])).rows[0];
  res.json({ content: row?.content || "" });
});

app.put("/api/my/sticky-note", requireAuth, async (req, res) => {
  const { content } = req.body;
  await pool.query(`
    INSERT INTO sticky_notes (user_id, content, updated_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id) DO UPDATE SET content = $2, updated_at = $3
  `, [req.user.id, content || "", new Date().toISOString()]);
  res.json({ ok: true });
});

app.get("/api/dashboard", requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  const [upcomingRes, upcomingCountRes, followUpsRes, accountsRes, paymentsRes, tasksRes, newLeadsRes, tentativeRes, interestedRes, stageCountsRes] = await Promise.all([
    pool.query(`SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed') AND date >= $1 ORDER BY date ASC LIMIT 5`, [today]),
    pool.query(`SELECT COUNT(*) AS c FROM leads WHERE stage IN ('Confirmed', 'Completed') AND date >= $1`, [today]),
    pool.query(`SELECT * FROM leads WHERE stage = 'Follow-up' ORDER BY last_followup_at ASC NULLS FIRST, created_at ASC`),
    pool.query(`SELECT id, final_amount, quote_amount FROM leads WHERE stage IN ('Confirmed', 'Completed')`),
    pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments`),
    pool.query(`SELECT * FROM tasks WHERE done = 0 AND (due_date <= $1 OR due_date IS NULL) ORDER BY due_date ASC LIMIT 8`, [weekAhead]),
    pool.query(`SELECT COUNT(*) AS c FROM leads WHERE stage = 'New'`),
    pool.query(`SELECT * FROM leads WHERE stage = 'Tentative' ORDER BY date ASC`),
    pool.query(`SELECT * FROM leads WHERE stage = 'Interested' ORDER BY date ASC`),
    // Powers the pipeline funnel on the dashboard — one query, grouped, rather
    // than five separate COUNT(*) calls for each stage.
    pool.query(`SELECT stage, COUNT(*) AS c FROM leads WHERE stage != 'Cancelled' GROUP BY stage`),
  ]);

  const totalQuoted = accountsRes.rows.reduce((s, l) => s + (l.final_amount || l.quote_amount || 0), 0);
  const totalReceived = Number(paymentsRes.rows[0].total);
  const stageCounts = {};
  stageCountsRes.rows.forEach((r) => { stageCounts[r.stage] = Number(r.c); });

  res.json({
    upcomingEvents: upcomingRes.rows,
    upcomingEventsCount: Number(upcomingCountRes.rows[0].c),
    pendingFollowUps: followUpsRes.rows,
    tasksDueSoon: tasksRes.rows,
    newLeadsCount: Number(newLeadsRes.rows[0].c),
    tentativeBookings: tentativeRes.rows,
    interestedLeads: interestedRes.rows,
    outstanding: totalQuoted - totalReceived,
    stageCounts,
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

// ---------- Monthly data backup ----------
// A full export of every table, emailed to the admin so there's always an
// off-app copy of everything captured — not just leads, but payments,
// expenses, team, quotes, assignments, tasks, documents metadata, and the
// activity log. `users` is deliberately excluded (password hashes).
const BACKUP_TABLES = [
  ["Leads", "SELECT * FROM leads ORDER BY created_at DESC"],
  ["Payments", "SELECT * FROM payments ORDER BY payment_date DESC"],
  ["Expenses", "SELECT * FROM expenses ORDER BY created_at DESC"],
  ["Team", "SELECT * FROM team ORDER BY name ASC"],
  ["Quotes", "SELECT * FROM quotes ORDER BY created_at DESC"],
  ["EventAssignments", "SELECT * FROM event_assignments ORDER BY created_at DESC"],
  ["TempArtists", "SELECT * FROM temp_artists ORDER BY created_at DESC"],
  ["Tasks", "SELECT * FROM tasks ORDER BY created_at DESC"],
  ["Documents", "SELECT id, lead_id, original_name, notes, uploaded_at FROM documents ORDER BY uploaded_at DESC"],
  ["ActivityLog", "SELECT * FROM activity_log ORDER BY created_at DESC"],
  ["Announcements", "SELECT * FROM announcements ORDER BY created_at DESC"],
];

async function buildBackupWorkbook() {
  const wb = XLSX.utils.book_new();
  for (const [sheetName, query] of BACKUP_TABLES) {
    try {
      const { rows } = await pool.query(query);
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
    } catch (err) {
      console.error(`Backup: failed to export ${sheetName}:`, err.message);
    }
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function getMailTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Railway's network can't route to some mail providers (e.g. Gmail) over
    // IPv6 -- every send was failing with ENETUNREACH until this was forced.
    family: 4,
  });
}

async function sendNewLeadEmail(lead) {
  const transport = getMailTransport();
  if (!transport) return; // email not configured — the in-app notification still covers it
  const to = process.env.TEAM_NOTIFY_EMAIL || process.env.BACKUP_EMAIL || "togetheroutloudclub@gmail.com";
  const lines = [
    `Name: ${lead.name}`,
    lead.phone ? `Phone: ${lead.phone}` : null,
    lead.email ? `Email: ${lead.email}` : null,
    `Format: ${packageName(lead.event_type)}`,
    lead.city ? `City: ${lead.city}` : null,
    `Date wanted: ${lead.date}`,
    lead.occasion ? `Occasion: ${lead.occasion}` : null,
    lead.guest_range ? `Guests: ${lead.guest_range}` : null,
    lead.budget ? `Budget: ₹${Number(lead.budget).toLocaleString("en-IN")}` : null,
    lead.details ? `\nTheir notes: ${lead.details}` : null,
  ].filter(Boolean);
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `New query — ${lead.name} (${packageName(lead.event_type)})`,
    text: lines.join("\n"),
  });
}

async function sendBackupEmail(recipient) {
  const transport = getMailTransport();
  if (!transport) throw new Error("Email isn't configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing) — set those in Railway's Variables tab first.");
  const to = recipient || process.env.BACKUP_EMAIL || "togetheroutloudclub@gmail.com";
  if (!to) throw new Error("No recipient email configured.");
  const buffer = await buildBackupWorkbook();
  const today = new Date().toISOString().slice(0, 10);
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `Together, Out Loud — data backup (${today})`,
    text: "Attached is a full export of all leads, payments, expenses, team, quotes, assignments, tasks, and activity as of today.",
    attachments: [{ filename: `tol-backup-${today}.xlsx`, content: buffer }],
  });
}

// Sends once per calendar month (checked hourly alongside autoCompletePastEvents),
// tracked via a flag in message_templates so it can't double-send even across
// restarts, and so it retries automatically on the next hourly check if the
// first attempt in a given month fails (e.g. SMTP misconfigured).
async function runMonthlyBackupCheck() {
  try {
    const monthKey = new Date().toISOString().slice(0, 7); // "2026-08"
    const flag = (await pool.query("SELECT template FROM message_templates WHERE key = 'last_backup_sent_month'")).rows[0];
    if (flag?.template === monthKey) return; // already sent this month
    await sendBackupEmail();
    await pool.query(`
      INSERT INTO message_templates (key, template, updated_at) VALUES ('last_backup_sent_month', $1, $2)
      ON CONFLICT (key) DO UPDATE SET template = $1, updated_at = $2
    `, [monthKey, new Date().toISOString()]);
    console.log(`Monthly backup emailed for ${monthKey}`);
  } catch (err) {
    console.error("Monthly backup failed (will retry next hour):", err.message);
  }
}

app.get("/api/admin/backup", requireAuth, requireAdmin, async (req, res) => {
  try {
    const buffer = await buildBackupWorkbook();
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="tol-backup-${today}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/backup/email", requireAuth, requireAdmin, async (req, res) => {
  try {
    await sendBackupEmail(req.body?.email);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Anything unmatched by an API route or a static file gets a branded 404
// instead of Express's bare "Cannot GET /..." — API paths still get JSON so
// client-side error handling isn't affected.
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
});

const PORT = process.env.PORT || 3300;
ready.then(() => {
  app.listen(PORT, () => console.log(`TOL workflow app running on http://localhost:${PORT}`));
  autoCompletePastEvents();
  setInterval(autoCompletePastEvents, 60 * 60 * 1000);
  runMonthlyBackupCheck();
  setInterval(runMonthlyBackupCheck, 60 * 60 * 1000);
});
