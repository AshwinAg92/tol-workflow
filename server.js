try { require("dotenv").config(); } catch (e) { /* .env is optional */ }
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { v4: uuid } = require("uuid");
const db = require("./db");
const { STAGES, PACKAGES, ADDONS, TEAM, EXPERIENCES, OCCASIONS, GUEST_RANGES, HOW_HEARD } = require("./config");

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
function getSessionUser(req) {
  const token = parseCookies(req)["tol_session"];
  if (!token) return null;
  const value = unsignValue(token);
  if (!value) return null;
  try {
    const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return db.prepare("SELECT id, username, access_level, team_id FROM users WHERE id = ?").get(payload.uid) || null;
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
function requireAuth(req, res, next) {
  const user = getSessionUser(req);
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
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password are required" });
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
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

app.get("/api/auth/me", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json({ id: user.id, username: user.username, accessLevel: user.access_level });
});

// ---------- User accounts (admin only) — add teammates with their own login ----------
app.get("/api/users", requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT users.id, users.username, users.access_level, users.team_id, team.name AS team_name, team.role AS team_role
    FROM users LEFT JOIN team ON team.id = users.team_id
    ORDER BY users.created_at ASC
  `).all();
  res.json(rows);
});

app.post("/api/users", requireAuth, requireAdmin, (req, res) => {
  const { name, roleTitle, username, password, accessLevel } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: "Name, username, and password are required" });
  if (!["admin", "staff"].includes(accessLevel)) return res.status(400).json({ error: "accessLevel must be 'admin' or 'staff'" });
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) return res.status(400).json({ error: "That username is already taken" });

  const teamId = uuid();
  db.prepare("INSERT INTO team (id, name, role) VALUES (?, ?, ?)").run(teamId, name, roleTitle || null);
  const userId = uuid();
  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare(`
    INSERT INTO users (id, team_id, username, password_hash, access_level, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, teamId, username, passwordHash, accessLevel, new Date().toISOString());

  res.status(201).json({ id: userId, username, accessLevel, teamId, name });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't remove your own login while logged in as it" });
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---------- Config (so the frontend never hardcodes pricing) ----------
app.get("/api/config", (req, res) => {
  res.json({
    stages: STAGES,
    packages: PACKAGES,
    addons: ADDONS,
    experiences: EXPERIENCES,
    occasions: OCCASIONS,
    guestRanges: GUEST_RANGES,
    howHeard: HOW_HEARD,
  });
});

// ---------- Leads ----------
app.get("/api/leads", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM leads ORDER BY date ASC").all();
  res.json(rows);
});

// Public lead-capture endpoint — this is the form link you'd share with a new query.
app.post("/api/leads", (req, res) => {
  const {
    name, phone, email, eventType, city, date, budget, notes,
    venue, occasion, guestRange, details, howHeard, whatsappOptin,
  } = req.body;
  if (!name || !eventType || !date) {
    return res.status(400).json({ error: "name, eventType, and date are required" });
  }
  const id = uuid();
  db.prepare(`
    INSERT INTO leads (
      id, name, phone, email, event_type, city, date, budget, stage, advance, notes, created_at,
      venue, occasion, guest_range, details, how_heard, whatsapp_optin
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'New', 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, phone || null, email || null, eventType, city || null, date, budget || null, notes || null, new Date().toISOString(),
    venue || null, occasion || null, guestRange || null,
    details || null, howHeard || null, whatsappOptin ? 1 : 0
  );
  const created = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
  res.status(201).json(created);
  // New leads show up immediately in the Leads tab and dashboard "new leads"
  // count — no email/notification needed, the team works off the app directly.
});

app.patch("/api/leads/:id", requireAuth, (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const fields = ["stage", "assigned_to", "advance", "quote_amount", "notes"];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    const key = f === "assigned_to" ? "assignedTo" : f === "quote_amount" ? "quoteAmount" : f;
    if (req.body[key] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[key]);
    }
  });
  if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });

  db.prepare(`UPDATE leads SET ${updates.join(", ")} WHERE id = ?`).run(...values, req.params.id);
  res.json(db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id));
});

// ---------- Quotation ----------
// The quote text is built and edited entirely in the browser (so Ashwin can
// change wording, amount, or anything else himself without needing a code
// change). This endpoint just records the amount + stage, and turns the
// final text into a WhatsApp link and a mailto link.
app.post("/api/leads/:id/quote", requireAuth, async (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const { amount, subject, body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Quote text is required" });

  const numericAmount = amount !== undefined && amount !== null && amount !== "" ? Number(amount) : null;
  const finalSubject = subject && subject.trim() ? subject : "Quotation — Together, Out Loud";

  const newStage = lead.stage === "New" ? "Quoted" : lead.stage;
  db.prepare("UPDATE leads SET quote_amount = ?, stage = ? WHERE id = ?").run(numericAmount, newStage, lead.id);

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
    lead: db.prepare("SELECT * FROM leads WHERE id = ?").get(lead.id),
    whatsapp,
    mailto,
  });
});
// ---------- Team ----------
app.get("/api/team", requireAuth, (req, res) => {
  const leads = db.prepare("SELECT * FROM leads WHERE stage NOT IN ('Completed', 'Cancelled')").all();
  const team = db.prepare("SELECT * FROM team").all().map((m) => ({
    ...m,
    activeLeads: leads.filter((l) => l.assigned_to === m.id),
  }));
  res.json(team);
});

// ---------- Calendar ----------
app.get("/api/calendar", requireAuth, (req, res) => {
  const { year, month } = req.query; // month is 1-12
  const rows = db.prepare("SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed')").all();
  const filtered = rows.filter((l) => {
    if (!l.date) return false;
    const d = new Date(l.date + "T00:00:00");
    return (!year || d.getFullYear() === Number(year)) && (!month || d.getMonth() + 1 === Number(month));
  });
  res.json(filtered);
});

// ---------- Accounts ----------
app.get("/api/accounts", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM leads WHERE quote_amount IS NOT NULL").all();
  const totals = rows.reduce(
    (acc, l) => {
      acc.quoted += l.quote_amount || 0;
      acc.received += l.advance || 0;
      return acc;
    },
    { quoted: 0, received: 0 }
  );
  res.json({ bookings: rows, totals: { ...totals, outstanding: totals.quoted - totals.received } });
});

// ---------- Tasks ----------
app.get("/api/tasks", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM tasks ORDER BY done ASC, due_date ASC").all();
  res.json(rows);
});

app.post("/api/tasks", requireAuth, (req, res) => {
  const { leadId, title, dueDate, assignedTo } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });
  const id = uuid();
  db.prepare(`
    INSERT INTO tasks (id, lead_id, title, due_date, assigned_to, done, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(id, leadId || null, title, dueDate || null, assignedTo || null, new Date().toISOString());
  res.status(201).json(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
});

app.patch("/api/tasks/:id", requireAuth, (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  const fields = { done: "done", title: "title", due_date: "dueDate", assigned_to: "assignedTo" };
  const updates = [];
  const values = [];
  Object.entries(fields).forEach(([col, key]) => {
    if (req.body[key] !== undefined) {
      updates.push(`${col} = ?`);
      values.push(col === "done" ? (req.body[key] ? 1 : 0) : req.body[key]);
    }
  });
  if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });
  db.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...values, req.params.id);
  res.json(db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id));
});

app.delete("/api/tasks/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---------- Documents ----------
app.get("/api/documents", requireAuth, (req, res) => {
  const { leadId } = req.query;
  const rows = leadId
    ? db.prepare("SELECT * FROM documents WHERE lead_id = ? ORDER BY uploaded_at DESC").all(leadId)
    : db.prepare("SELECT * FROM documents ORDER BY uploaded_at DESC").all();
  res.json(rows.map((d) => ({ ...d, url: `/uploads/${d.stored_name}` })));
});

app.post("/api/documents", requireAuth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const id = uuid();
  db.prepare(`
    INSERT INTO documents (id, lead_id, original_name, stored_name, notes, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.body.leadId || null, req.file.originalname, req.file.filename, req.body.notes || null, new Date().toISOString());
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  res.status(201).json({ ...doc, url: `/uploads/${doc.stored_name}` });
});

app.delete("/api/documents/:id", requireAuth, (req, res) => {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
  if (doc) {
    fs.unlink(path.join(UPLOAD_DIR, doc.stored_name), () => {});
    db.prepare("DELETE FROM documents WHERE id = ?").run(req.params.id);
  }
  res.status(204).end();
});

// ---------- Dashboard ----------
app.get("/api/dashboard", requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  const upcomingEvents = db.prepare(`
    SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed') AND date >= ? ORDER BY date ASC LIMIT 5
  `).all(today);

  const pendingFollowUps = db.prepare(`SELECT * FROM leads WHERE stage = 'Follow-up' ORDER BY date ASC`).all();

  const accountsRows = db.prepare("SELECT * FROM leads WHERE quote_amount IS NOT NULL").all();
  const totals = accountsRows.reduce(
    (acc, l) => { acc.quoted += l.quote_amount || 0; acc.received += l.advance || 0; return acc; },
    { quoted: 0, received: 0 }
  );

  const tasksDueSoon = db.prepare(`
    SELECT * FROM tasks WHERE done = 0 AND (due_date <= ? OR due_date IS NULL) ORDER BY due_date ASC LIMIT 8
  `).all(weekAhead);

  const newLeadsCount = db.prepare("SELECT COUNT(*) AS c FROM leads WHERE stage = 'New'").get().c;

  res.json({
    upcomingEvents,
    pendingFollowUps,
    tasksDueSoon,
    newLeadsCount,
    outstanding: totals.quoted - totals.received,
  });
});

const PORT = process.env.PORT || 3300;
app.listen(PORT, () => console.log(`TOL workflow app running on http://localhost:${PORT}`));
