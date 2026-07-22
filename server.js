try { require("dotenv").config(); } catch (e) { /* .env is optional */ }
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { v4: uuid } = require("uuid");
const db = require("./db");
const { STAGES, PACKAGES, ADDONS, TEAM, EXPERIENCES, OCCASIONS, GUEST_RANGES, HOW_HEARD } = require("./config");
const { sendQuoteEmail, sendLeadConfirmationEmail, sendTeamNotificationEmail } = require("./mailer");

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
app.get("/api/leads", (req, res) => {
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

  // Fire both emails after responding, so the person submitting the form
  // isn't kept waiting on an SMTP round trip. Failures are logged, never thrown.
  sendLeadConfirmationEmail(created).catch((err) => console.error("Confirmation email failed:", err.message));
  sendTeamNotificationEmail(created).catch((err) => console.error("Team notification email failed:", err.message));
});

app.patch("/api/leads/:id", (req, res) => {
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
// Computes the total from selected package/addon ids, emails it if SMTP is configured,
// and always returns the preview text so the UI can show/copy it either way.
app.post("/api/leads/:id/quote", async (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const { packageIds = [], addonIds = [] } = req.body;
  const chosenPackages = PACKAGES.filter((p) => packageIds.includes(p.id));
  const chosenAddons = ADDONS.filter((a) => addonIds.includes(a.id));
  const total = chosenPackages.reduce((s, p) => s + p.rate, 0) + chosenAddons.reduce((s, a) => s + (a.rate || 0), 0);

  if (total === 0) return res.status(400).json({ error: "Select at least one package or paid add-on" });

  const lines = [...chosenPackages.map((p) => p.name), ...chosenAddons.map((a) => a.name)];
  const subject = `Quotation for ${chosenPackages.map((p) => p.name).join(" / ") || "your event"} — Together Out Loud`;
  const body = [
    `Dear ${lead.name.split(" ")[0] || "there"},`,
    ``,
    `Thank you for reaching out to Together Out Loud. Here is our quotation for your event on ${lead.date} in ${lead.city || ""}:`,
    ``,
    ...lines.map((l) => `- ${l}`),
    ``,
    `Total: ₹${total.toLocaleString("en-IN")}`,
    ``,
    `Excludes travel and accommodation unless noted above. Valid for 7 days.`,
  ].join("\n");

  const newStage = lead.stage === "New" ? "Quoted" : lead.stage;
  db.prepare("UPDATE leads SET quote_amount = ?, stage = ? WHERE id = ?").run(total, newStage, lead.id);

  let emailResult = { sent: false, reason: "SMTP not configured — preview only" };
  if (lead.email) {
    emailResult = await sendQuoteEmail({ to: lead.email, subject, body });
  }

  res.json({
    lead: db.prepare("SELECT * FROM leads WHERE id = ?").get(lead.id),
    total,
    subject,
    body,
    email: emailResult,
  });
});

// ---------- Team ----------
app.get("/api/team", (req, res) => {
  const leads = db.prepare("SELECT * FROM leads WHERE stage NOT IN ('Completed', 'Cancelled')").all();
  const team = db.prepare("SELECT * FROM team").all().map((m) => ({
    ...m,
    activeLeads: leads.filter((l) => l.assigned_to === m.id),
  }));
  res.json(team);
});

// ---------- Calendar ----------
app.get("/api/calendar", (req, res) => {
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
app.get("/api/accounts", (req, res) => {
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
app.get("/api/tasks", (req, res) => {
  const rows = db.prepare("SELECT * FROM tasks ORDER BY done ASC, due_date ASC").all();
  res.json(rows);
});

app.post("/api/tasks", (req, res) => {
  const { leadId, title, dueDate, assignedTo } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });
  const id = uuid();
  db.prepare(`
    INSERT INTO tasks (id, lead_id, title, due_date, assigned_to, done, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(id, leadId || null, title, dueDate || null, assignedTo || null, new Date().toISOString());
  res.status(201).json(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
});

app.patch("/api/tasks/:id", (req, res) => {
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

app.delete("/api/tasks/:id", (req, res) => {
  db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---------- Documents ----------
app.get("/api/documents", (req, res) => {
  const { leadId } = req.query;
  const rows = leadId
    ? db.prepare("SELECT * FROM documents WHERE lead_id = ? ORDER BY uploaded_at DESC").all(leadId)
    : db.prepare("SELECT * FROM documents ORDER BY uploaded_at DESC").all();
  res.json(rows.map((d) => ({ ...d, url: `/uploads/${d.stored_name}` })));
});

app.post("/api/documents", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const id = uuid();
  db.prepare(`
    INSERT INTO documents (id, lead_id, original_name, stored_name, notes, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.body.leadId || null, req.file.originalname, req.file.filename, req.body.notes || null, new Date().toISOString());
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  res.status(201).json({ ...doc, url: `/uploads/${doc.stored_name}` });
});

app.delete("/api/documents/:id", (req, res) => {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
  if (doc) {
    fs.unlink(path.join(UPLOAD_DIR, doc.stored_name), () => {});
    db.prepare("DELETE FROM documents WHERE id = ?").run(req.params.id);
  }
  res.status(204).end();
});

// ---------- Dashboard ----------
app.get("/api/dashboard", (req, res) => {
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
