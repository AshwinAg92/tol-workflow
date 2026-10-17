try { require("dotenv").config(); } catch (e) { /* .env is optional */ }
// Railway's network can only route outbound to some mail providers (e.g.
// Gmail's SMTP) over IPv4 -- Node 17+'s default DNS ordering can still hand
// back an IPv6 address first, which then fails to connect with ENETUNREACH.
// This forces every dns.lookup() in the process (including nodemailer's,
// which doesn't expose its own IPv4-only option) to prefer IPv4.
require("dns").setDefaultResultOrder("ipv4first");
// A transient DB hiccup (a dropped connection, a momentary network blip to
// Postgres) throws inside some route's async handler. Most routes here
// aren't individually try/caught, so left alone that becomes an unhandled
// promise rejection -- and in this Node version, an unhandled rejection
// crashes the ENTIRE process, taking down every other request in flight
// and putting the whole app into a crash-restart loop over one bad query.
// Logging instead of crashing means a blip costs one failed request, not
// the whole site going down. (The one request that hit the error is left
// hanging without a response rather than getting a clean 500 -- a real but
// much smaller gap than a full outage, and worth tightening later by
// wrapping route handlers properly.)
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection (server stays up):", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server stays up):", err);
});
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const nodemailer = require("nodemailer");
const webpush = require("web-push");
const XLSX = require("xlsx");
const { v4: uuid } = require("uuid");
const { pool, ready } = require("./db");
const { buildFullBackup } = require("./backup-core");
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
      "SELECT id, username, access_level, team_id, permissions, is_performer, nav_favorites FROM users WHERE id = $1",
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

// ---------- Commercial-data guards ----------
// A manager (staff without Leads/Accounts access) must never receive fees, rates,
// quotes, payments or pricing — not even in a response the screen doesn't show,
// since anyone can read raw API responses in their browser. Every route that can
// carry money strips it unless the user has the matching section.
const canSeeMoney = (user) => userHasSection(user, "accounts");
// Money on a lead row (what the client budgeted / was quoted / pays). Anyone without
// Accounts access (a manager, say) never receives these, whichever endpoint asks.
const LEAD_MONEY_FIELDS = ["quote_amount", "final_amount", "budget", "advance", "advance_date", "received", "reimbursement_due"];
function stripLeadMoney(l, user) {
  if (!l || canSeeMoney(user)) return l;
  const o = { ...l };
  LEAD_MONEY_FIELDS.forEach((k) => delete o[k]);
  return o;
}
function requireMoneyAccess(req, res, next) {
  if (canSeeMoney(req.user)) return next();
  return res.status(403).json({ error: "Amounts and quotes are only available with Accounts access" });
}
function restrictedLeadView(l) {
  return {
    id: l.id, name: l.name, date: l.date, city: l.city, event_type: l.event_type, stage: l.stage,
    event_time: l.event_time, soundcheck_time: l.soundcheck_time, occasion: l.occasion, venue: l.venue,
    combo_group_id: l.combo_group_id, is_combo_primary: l.is_combo_primary, pcs: l.pcs, duration: l.duration,
    sound_manager_name: l.sound_manager_name, sound_manager_phone: l.sound_manager_phone,
    coordinator_name: l.coordinator_name, coordinator_phone: l.coordinator_phone, contacts: l.contacts,
  };
}
// Events a team member is allotted to (not declined). null = no roster link, i.e. no scoping possible.
async function assignedLeadIdSet(user) {
  if (!user.team_id) return null;
  const rows = (await pool.query("SELECT lead_id FROM event_assignments WHERE team_id = $1 AND status <> 'declined'", [user.team_id])).rows;
  return new Set(rows.map((r) => r.lead_id));
}
// A manager who is also on the team roster only manages events allotted to them (not declined)
// — no pipeline, no other events. Managers not on the roster keep the company-wide ops view.
const isScopedManager = (user) => user.access_level === "staff" && userHasSection(user, "assign_team") && !!user.team_id;
async function leadInManagerScope(user, leadId) {
  if (!isScopedManager(user)) return true;
  const ids = await assignedLeadIdSet(user);
  return !!ids && ids.has(leadId);
}
async function assignmentInManagerScope(user, assignmentId) {
  if (!isScopedManager(user)) return true;
  const a = (await pool.query("SELECT lead_id FROM event_assignments WHERE id = $1", [assignmentId])).rows[0];
  return !a || (await leadInManagerScope(user, a.lead_id));
}
const scopeDeny = (res) => res.status(403).json({ error: "You can only manage events allotted to you" });
// Travel notes are the admin's private remarks — nobody else gets them.
// Managers (assign_team) additionally see the manager_notes they and other managers write.
function legForUser(leg, user) {
  if (user.access_level === "admin") return leg;
  const { notes, manager_notes, ...rest } = leg;
  return userHasSection(user, "assign_team") ? { ...rest, manager_notes } : rest;
}
function requireAnySection(sections) {
  return (req, res, next) => {
    if (sections.some((sec) => userHasSection(req.user, sec))) return next();
    return res.status(403).json({ error: "You don't have access to that" });
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

// Adds/updates a B2B directory entry for a phone number — matched on phone
// so re-marking the same person never creates a duplicate. Used both when a
// lead comes in via the public form's Event Manager path, and when a lead is
// retroactively marked B2B from Edit lead (name/city/phone come from the
// lead itself in that case, since there's no separate manager-only form).
async function upsertB2bContact({ name, phone, company, city, instagram }) {
  if (!phone) return;
  try {
    const { rows } = await pool.query("SELECT id FROM b2b_contacts WHERE phone = $1 LIMIT 1", [phone]);
    if (rows[0]) {
      await pool.query(
        `UPDATE b2b_contacts SET name = $1, company = COALESCE($2, company), city = COALESCE($3, city), instagram = COALESCE($4, instagram) WHERE id = $5`,
        [name, company || null, city || null, instagram || null, rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO b2b_contacts (id, name, company, phone, city, instagram, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uuid(), name, company || null, phone, city || null, instagram || null, new Date().toISOString()]
      );
    }
  } catch (err) {
    console.error("B2B contact upsert failed:", err.message);
  }
}

const app = express();
app.use(cors());
app.use(express.json());
// A dropped DB connection mid-query throws inside a route handler that has
// no individual try/catch. The global unhandledRejection listener above
// stops that from crashing the whole process, but it can't send a response
// either -- so without this, that one request just hangs until the browser
// or Railway's edge gives up (we saw this as 125-second "Still loading..."
// hangs in production). This makes any request that doesn't finish in 20s
// fail fast with a clear error instead of hanging indefinitely.
app.use((req, res, next) => {
  res.setTimeout(20000, () => {
    if (!res.headersSent) {
      console.error(`Request timed out after 20s: ${req.method} ${req.path}`);
      res.status(503).json({ error: "Request timed out — please try again." });
    }
  });
  next();
});
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});
// app.js and index.html change on every deploy but have no cache-busting
// filename (no hash in the URL), so browsers were caching stale copies for
// days — this forces a fresh fetch every time, ending that recurring issue.
app.use(["/app.js", "/index.html", "/home.html", "/styles.css"], (req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  next();
});
// Served explicitly (ahead of express.static) with Range support turned off.
// WhatsApp's own in-app link-preview crawler was fetching this file with a
// Range header and getting back 206 Partial Content from express.static's
// default handling — some WhatsApp builds then refuse to open the link at
// all ("This link couldn't be opened"). A plain, always-200 response avoids
// that class of failure entirely.
// Personalised link preview for artists: the card carries their first name + the
// event (never client name, venue or fees), rendered server-side as a PNG.
let _resvg = null;
function renderArtistCardPng(first, experience, dateLong, city) {
  if (!_resvg) _resvg = require("@resvg/resvg-js").Resvg;
  const esc = (v) => String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const logo = fs.readFileSync(path.join(__dirname, "public", "logo.png")).toString("base64");
  const fs1 = first.length > 14 ? 58 : 76;
  const exp = String(experience || "");
  const es = exp.length > 24 ? 40 : 50;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FEF6ED"/><stop offset="1" stop-color="#F6E0C2"/></linearGradient>
<radialGradient id="gl" cx="1100" cy="80" r="380" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#F0A438" stop-opacity="0.38"/><stop offset="1" stop-color="#F0A438" stop-opacity="0"/></radialGradient></defs>
<rect width="1200" height="630" fill="url(#bg)"/><rect width="1200" height="630" fill="url(#gl)"/>
<rect x="24" y="24" width="1152" height="582" fill="none" stroke="#C1602B" stroke-width="3"/>
<rect x="36" y="36" width="1128" height="558" fill="none" stroke="#C1602B" stroke-opacity="0.35" stroke-width="1.5"/>
<image href="data:image/png;base64,${logo}" x="${600 - 45}" y="48" width="90" height="92"/>
<text x="600" y="176" text-anchor="middle" font-family="Poppins" font-weight="700" font-size="20" letter-spacing="6" fill="#2B2420">TOGETHER, OUT LOUD</text>
<text x="600" y="218" text-anchor="middle" font-family="Poppins" font-weight="700" font-size="18" letter-spacing="4" fill="#C1602B">YOUR PERFORMANCE</text>
<text x="600" y="310" text-anchor="middle" font-family="Lora" font-weight="700" font-size="${fs1}" fill="#2B2420">Hi ${esc(first)}!</text>
<line x1="480" y1="350" x2="582" y2="350" stroke="#F0A438" stroke-width="3"/><line x1="618" y1="350" x2="720" y2="350" stroke="#F0A438" stroke-width="3"/><circle cx="600" cy="350" r="6" fill="#F0A438"/>
<text x="600" y="422" text-anchor="middle" font-family="Lora" font-weight="700" font-size="${es}" fill="#C1602B">${esc(exp)}</text>
<text x="600" y="478" text-anchor="middle" font-family="Poppins" font-weight="500" font-size="32" fill="#2B2420">${esc([dateLong, city].filter(Boolean).join("  \u00b7  "))}</text>
<text x="600" y="556" text-anchor="middle" font-family="Lora" font-style="italic" font-size="28" fill="#8A6A54">Tap to confirm or decline \u2014 Team TOL</text>
</svg>`;
  const fontDir = path.join(__dirname, "fonts");
  const r = new _resvg(svg, { font: { fontFiles: ["Poppins-Bold.ttf", "Poppins-Medium.ttf", "Lora-Variable.ttf", "Lora-Italic-Variable.ttf"].map((f) => path.join(fontDir, f)), loadSystemFonts: false, defaultFontFamily: "Poppins" } });
  return r.render().asPng();
}
function renderTripCardPng(o) {
  if (!_resvg) _resvg = require("@resvg/resvg-js").Resvg;
  const esc = (v) => String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const logo = fs.readFileSync(path.join(__dirname, "public", "logo.png")).toString("base64");
  const name = String(o.client || "");
  const ns = name.length > 26 ? 44 : name.length > 18 ? 54 : 64;
  const sub = [o.experience, o.dateLong, o.city].filter(Boolean).join("  \u00b7  ");
  const routes = (o.routes || []).slice(0, 3);
  const rowY = routes.length === 1 ? [455] : routes.length === 2 ? [440, 490] : [425, 470, 515];
  const routeSvg = routes.map((r, i) => { const y = rowY[i]; const [from, to] = String(r.route).split(" \u2192 "); return `<text x="360" y="${y}" text-anchor="end" font-family="Poppins" font-weight="500" font-size="24" fill="#8A6A54">${esc(r.date)}</text><text x="570" y="${y}" text-anchor="end" font-family="Poppins" font-weight="700" font-size="30" fill="#2B2420">${esc(from)}</text><path d="M585 ${y - 10} H625 M613 ${y - 21} L626 ${y - 10} L613 ${y + 1}" fill="none" stroke="#C1602B" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><text x="642" y="${y}" text-anchor="start" font-family="Poppins" font-weight="700" font-size="30" fill="#2B2420">${esc(to)}</text>`; }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FEF6ED"/><stop offset="1" stop-color="#F6E0C2"/></linearGradient>
<radialGradient id="gl" cx="1100" cy="80" r="380" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#F0A438" stop-opacity="0.38"/><stop offset="1" stop-color="#F0A438" stop-opacity="0"/></radialGradient></defs>
<rect width="1200" height="630" fill="url(#bg)"/><rect width="1200" height="630" fill="url(#gl)"/>
<rect x="24" y="24" width="1152" height="582" fill="none" stroke="#C1602B" stroke-width="3"/>
<rect x="36" y="36" width="1128" height="558" fill="none" stroke="#C1602B" stroke-opacity="0.35" stroke-width="1.5"/>
<image href="data:image/png;base64,${logo}" x="555" y="48" width="90" height="92"/>
<text x="600" y="172" text-anchor="middle" font-family="Poppins" font-weight="700" font-size="20" letter-spacing="6" fill="#2B2420">TOGETHER, OUT LOUD</text>
<text x="600" y="212" text-anchor="middle" font-family="Poppins" font-weight="700" font-size="18" letter-spacing="4" fill="#C1602B">TRAVEL DETAILS &amp; IDS</text>
<text x="600" y="296" text-anchor="middle" font-family="Lora" font-weight="700" font-size="${ns}" fill="#2B2420">${esc(name)}</text>
<text x="600" y="346" text-anchor="middle" font-family="Poppins" font-weight="500" font-size="26" fill="#C1602B">${esc(sub)}</text>
<line x1="480" y1="378" x2="582" y2="378" stroke="#F0A438" stroke-width="3"/><line x1="618" y1="378" x2="720" y2="378" stroke="#F0A438" stroke-width="3"/><circle cx="600" cy="378" r="6" fill="#F0A438"/>
${routeSvg}
<text x="600" y="570" text-anchor="middle" font-family="Lora" font-style="italic" font-size="26" fill="#8A6A54">${esc(o.count ? `Team of ${o.count} travelling \u2014 IDs & details inside` : "Travel details inside")}</text>
</svg>`;
  const fontDir = path.join(__dirname, "fonts");
  const r = new _resvg(svg, { font: { fontFiles: ["Poppins-Bold.ttf", "Poppins-Medium.ttf", "Lora-Variable.ttf", "Lora-Italic-Variable.ttf"].map((f) => path.join(fontDir, f)), loadSystemFonts: false, defaultFontFamily: "Poppins" } });
  return r.render().asPng();
}
async function tripCardInfo(token) {
  const sh = await loadTravelShare(token);
  if (!sh) return null;
  const lead = (await pool.query("SELECT name, date, city, event_type FROM leads WHERE id = $1", [sh.lead_id])).rows[0];
  if (!lead) return null;
  const ids = JSON.parse(sh.team_ids || "[]");
  const teamIds = ids.filter((x) => !String(x).startsWith("g:"));
  const legs = (await pool.query(`SELECT travel_legs.from_city, travel_legs.to_city, travel_legs.departure_at FROM travel_legs
    WHERE lead_id = $1 AND EXISTS (SELECT 1 FROM travel_leg_members m WHERE m.leg_id = travel_legs.id AND m.team_id = ANY($2))
    ORDER BY departure_at ASC NULLS LAST, created_at ASC`, [sh.lead_id, teamIds])).rows;
  const short = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || ""); return m ? `${Number(m[3])} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m[2]) - 1]}` : ""; };
  const routes = legs.filter((l) => l.from_city && l.to_city).map((l) => ({ route: `${String(l.from_city).trim()} \u2192 ${String(l.to_city).trim()}`, date: short(l.departure_at) }));
  const dateLong = lead.date ? new Date(lead.date + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "";
  return { client: lead.name, experience: packageName(lead.event_type), dateLong, city: String(lead.city || "").trim(), count: ids.length, routes };
}
app.get("/trip-card/:token.png", async (req, res) => {
  try {
    const info = await tripCardInfo(req.params.token);
    if (!info) return res.redirect(302, "/og-image.png");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.send(Buffer.from(renderTripCardPng(info)));
  } catch (err) { console.error("trip-card error:", err.message); res.redirect(302, "/og-image.png"); }
});
async function artistCardInfo(token) {
  const row = (await pool.query(`SELECT team.name AS team_name, leads.event_type, leads.city, leads.date
    FROM event_assignments JOIN team ON team.id = event_assignments.team_id JOIN leads ON leads.id = event_assignments.lead_id
    WHERE event_assignments.confirm_token = $1`, [token])).rows[0];
  if (!row) return null;
  const first = String(row.team_name || "").trim().split(/\s+/)[0] || "there";
  const dateLong = row.date ? new Date(row.date + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "";
  return { first, experience: packageName(row.event_type), dateLong, city: row.city || "" };
}
app.get("/confirm-card/:token.png", async (req, res) => {
  try {
    const info = await artistCardInfo(req.params.token);
    if (!info) return res.redirect(302, "/og-image.png");
    const png = renderArtistCardPng(info.first, info.experience, info.dateLong, info.city);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(png));
  } catch (err) {
    console.error("confirm-card error:", err.message);
    res.redirect(302, "/og-image.png");
  }
});
app.get("/confirm.html", async (req, res) => {
  const file = path.join(__dirname, "public", "confirm.html");
  const token = String(req.query.token || "");
  let info = null;
  if (token) { try { info = await artistCardInfo(token); } catch { info = null; } }
  if (!info) return res.sendFile(file, { acceptRanges: false });
  const host = `https://${req.headers["x-forwarded-host"] || req.get("host")}`;
  const escA = (v) => String(v || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const title = `Hi ${info.first} \u2014 confirm your performance`;
  const desc = `${info.experience}${info.dateLong ? " on " + info.dateLong : ""}${info.city ? " in " + info.city : ""} \u2014 Together, Out Loud`;
  const img = `${host}/confirm-card/${encodeURIComponent(token)}.png`;
  let html = fs.readFileSync(file, "utf8");
  html = html
    .replace(/(<meta property="og:title" content=")[^"]*/, `$1${escA(title)}`)
    .replace(/(<meta name="twitter:title" content=")[^"]*/, `$1${escA(title)}`)
    .replace(/(<meta property="og:description" content=")[^"]*/, `$1${escA(desc)}`)
    .replace(/(<meta property="og:image" content=")[^"]*/, `$1${img}`)
    .replace(/(<meta name="twitter:image" content=")[^"]*/, `$1${img}`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
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
  let navFavorites = [];
  try { navFavorites = user.nav_favorites ? JSON.parse(user.nav_favorites) : []; } catch { navFavorites = []; }
  res.json({ id: user.id, username: user.username, accessLevel: user.access_level, name, permissions, isPerformer: !!user.is_performer, teamId: user.team_id || null, navFavorites });
});

// A user's own choice of which sidebar sections to pin to the top —
// personal preference, no admin gating needed beyond being logged in.
app.put("/api/my/nav-favorites", requireAuth, async (req, res) => {
  const { favorites } = req.body;
  if (!Array.isArray(favorites) || !favorites.every((f) => typeof f === "string")) {
    return res.status(400).json({ error: "favorites must be an array of strings" });
  }
  await pool.query("UPDATE users SET nav_favorites = $1 WHERE id = $2", [JSON.stringify(favorites), req.user.id]);
  res.json({ favorites });
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
  const { name, roleTitle, phone, specialty, baseCity, username, password, accessLevel, existingTeamId, permissions, isPerformer } = req.body;
  const localFee = canSeeMoney(req.user) ? req.body.localFee : undefined;
  const outstationFee = canSeeMoney(req.user) ? req.body.outstationFee : undefined;
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
    await pool.query("INSERT INTO team (id, name, role, phone, specialty, base_city, local_fee, outstation_fee) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [teamId, name, roleTitle || null, phone || null, specialty || null, baseCity || null, localFee || null, outstationFee || null]);
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

// Add a person to the single people list WITHOUT a login (core band member or freelancer).
app.post("/api/team", requireAuth, requireCapability("manage_team"), async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required" });
  const kind = ["core", "freelance"].includes(b.kind) ? b.kind : "freelance";
  const instruments = String(b.instruments || "").split(",").map((x) => x.trim()).filter(Boolean).join(", ");
  const money = canSeeMoney(req.user);
  const id = uuid();
  await pool.query(`INSERT INTO team (id, name, role, phone, email, specialty, base_city, local_fee, outstation_fee, kind, instruments, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, name, (b.role || "").trim() || instruments || "Musician", (b.phone || "").trim() || null, (b.email || "").trim() || null, instruments || null,
     (b.baseCity || "").trim() || null, money ? (b.localFee || null) : null, money ? (b.outstationFee || null) : null, kind, instruments || null,
     req.user.access_level === "admin" ? ((b.notes || "").trim() || null) : null]);
  logActivity(req, `Added ${name} to Team (${kind === "core" ? "core" : "freelance"})`, null);
  res.status(201).json({ id });
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
  const { name, role, phone, email, specialty, baseCity } = req.body;
  if (req.body.kind !== undefined && ["core", "freelance"].includes(req.body.kind)) await pool.query("UPDATE team SET kind = $1 WHERE id = $2", [req.body.kind, member.id]);
  if (req.body.instruments !== undefined) await pool.query("UPDATE team SET instruments = $1 WHERE id = $2", [String(req.body.instruments || "").trim() || null, member.id]);
  if (req.body.notes !== undefined && req.user.access_level === "admin") await pool.query("UPDATE team SET notes = $1 WHERE id = $2", [String(req.body.notes || "").trim() || null, member.id]);
  // Fee rates are commercial — only someone with Accounts access can change them.
  const feeAllowed = canSeeMoney(req.user);
  const localFee = feeAllowed ? req.body.localFee : undefined;
  const outstationFee = feeAllowed ? req.body.outstationFee : undefined;
  await pool.query(`UPDATE team SET name = $1, role = $2, phone = $3, email = $4, specialty = $5, base_city = $6, local_fee = $7, outstation_fee = $8 WHERE id = $9`, [
    name || member.name,
    role !== undefined ? role : member.role,
    phone !== undefined ? phone : member.phone,
    email !== undefined ? email : member.email,
    specialty !== undefined ? specialty : member.specialty,
    baseCity !== undefined ? baseCity : member.base_city,
    localFee !== undefined ? (localFee || null) : member.local_fee,
    outstationFee !== undefined ? (outstationFee || null) : member.outstation_fee,
    member.id,
  ]);
  const { local_fee, outstation_fee, ...savedMember } = (await pool.query("SELECT * FROM team WHERE id = $1", [member.id])).rows[0];
  res.json(feeAllowed ? { ...savedMember, local_fee, outstation_fee } : savedMember);
});

// Remove a team member entirely — also removes any login tied to them.
function normPersonName(n) { return String(n || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function phoneKey(ph) { const d = String(ph || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; }

// Possible duplicate people (same name or same phone) — admin only.
app.get("/api/team/duplicates", requireAuth, requireAdmin, async (req, res) => {
  const people = (await pool.query("SELECT id, name, phone, email, kind, base_city, instruments FROM team")).rows;
  const users = (await pool.query("SELECT team_id FROM users")).rows.map((u) => u.team_id);
  const up = (await pool.query(`SELECT event_assignments.team_id AS tid, COUNT(*) AS c FROM event_assignments JOIN leads ON leads.id = event_assignments.lead_id WHERE leads.stage = 'Confirmed' GROUP BY 1`)).rows;
  const counts = Object.fromEntries(up.map((r) => [r.tid, Number(r.c)]));
  const parent = {};
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  people.forEach((p) => (parent[p.id] = p.id));
  const seen = {};
  for (const p of people) {
    for (const k of [normPersonName(p.name) && "n:" + normPersonName(p.name), phoneKey(p.phone) && "p:" + phoneKey(p.phone)]) {
      if (!k) continue;
      if (seen[k]) parent[find(p.id)] = find(seen[k]); else seen[k] = p.id;
    }
  }
  const groups = {};
  people.forEach((p) => { (groups[find(p.id)] = groups[find(p.id)] || []).push({ ...p, hasLogin: users.includes(p.id), events: counts[p.id] || 0 }); });
  res.json(Object.values(groups).filter((g) => g.length > 1));
});

// Merge person `fromId` into person `:id`; everything linked to fromId moves across.
app.post("/api/team/:id/merge", requireAuth, requireAdmin, async (req, res) => {
  const keepId = req.params.id, fromId = req.body && req.body.fromId;
  if (!fromId || fromId === keepId) return res.status(400).json({ error: "Pick a different person to merge" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const keep = (await client.query("SELECT * FROM team WHERE id = $1", [keepId])).rows[0];
    const from = (await client.query("SELECT * FROM team WHERE id = $1", [fromId])).rows[0];
    if (!keep || !from) throw new Error("Person not found");
    const ku = (await client.query("SELECT id FROM users WHERE team_id = $1", [keepId])).rows[0];
    const fu = (await client.query("SELECT id FROM users WHERE team_id = $1", [fromId])).rows[0];
    if (ku && fu) throw new Error("Both people have logins — remove one login first, then merge.");
    if (fu) await client.query("UPDATE users SET team_id = $1 WHERE id = $2", [keepId, fu.id]);
    // assignments: keep the existing one if both were on the same event
    const fa = (await client.query("SELECT * FROM event_assignments WHERE team_id = $1", [fromId])).rows;
    for (const a of fa) {
      const dup = (await client.query("SELECT id FROM event_assignments WHERE lead_id = $1 AND team_id = $2", [a.lead_id, keepId])).rows[0];
      if (dup) await client.query("DELETE FROM event_assignments WHERE id = $1", [a.id]);
      else await client.query("UPDATE event_assignments SET team_id = $1 WHERE id = $2", [keepId, a.id]);
    }
    for (const [t, c] of [["expenses","team_id"],["notifications","team_id"],["notifications","from_team_id"],["travel_legs","team_id"],["team_id_docs","team_id"],["musicians","team_id"],["tasks","assigned_to"],["leads","assigned_to"]]) {
      await client.query(`UPDATE ${t} SET ${c} = $1 WHERE ${c} = $2`, [keepId, fromId]);
    }
    await client.query("DELETE FROM travel_leg_members WHERE team_id = $1 AND leg_id IN (SELECT leg_id FROM travel_leg_members WHERE team_id = $2)", [fromId, keepId]);
    await client.query("UPDATE travel_leg_members SET team_id = $1 WHERE team_id = $2", [keepId, fromId]);
    const shares = (await client.query("SELECT token, team_ids FROM travel_shares")).rows;
    for (const sh of shares) {
      let ids; try { ids = JSON.parse(sh.team_ids || "[]"); } catch { continue; }
      if (!ids.includes(fromId)) continue;
      ids = [...new Set(ids.map((i) => (i === fromId ? keepId : i)))];
      await client.query("UPDATE travel_shares SET team_ids = $1 WHERE token = $2", [JSON.stringify(ids), sh.token]);
    }
    await client.query("UPDATE member_registrations SET team_id = $1 WHERE team_id = $2", [keepId, fromId]);
    // fill blanks on the kept person
    const inst = [...new Set(`${keep.instruments || ""},${from.instruments || ""}`.split(",").map((x) => x.trim()).filter(Boolean))].join(", ");
    const notes = [keep.notes, from.notes].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" | ");
    await client.query(`UPDATE team SET phone = COALESCE(NULLIF(phone,''), $1), email = COALESCE(NULLIF(email,''), $2), base_city = COALESCE(NULLIF(base_city,''), $3),
      specialty = COALESCE(NULLIF(specialty,''), $4), local_fee = COALESCE(local_fee, $5), outstation_fee = COALESCE(outstation_fee, $6),
      reg_details = COALESCE(reg_details, $7), legacy_musician_id = COALESCE(legacy_musician_id, $8), instruments = $9, notes = $10 WHERE id = $11`,
      [from.phone, from.email, from.base_city, from.specialty, from.local_fee, from.outstation_fee, from.reg_details, from.legacy_musician_id, inst || null, notes || null, keepId]);
    await client.query("DELETE FROM team WHERE id = $1", [fromId]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

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
  // Public (the enquiry form reads it), so the rate card must not be: package rates,
  // add-on rates and the pricing matrix only go to logged-in people who quote or
  // handle money.
  const viewer = await getSessionUser(req);
  const seesRates = !!viewer && userHasSection(viewer, "accounts");
  if (!seesRates) {
    return res.json({
      stages: STAGES,
      packages: PACKAGES.map(({ id, name }) => ({ id, name })),
      addons: ADDONS.map(({ id, name }) => ({ id, name })),
      pricing: {},
      experiences: EXPERIENCES,
      occasions: OCCASIONS,
      guestRanges: GUEST_RANGES,
      howHeard: HOW_HEARD,
    });
  }
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
  // "received" only counts money actually in hand (fee payments + reimbursements
  // marked received); a reimbursement still logged as 'due' is exposed
  // separately so Balance can count it as outstanding without it looking
  // like money already collected.
  // Fee payments only — a reimbursement, once received, is money that was
  // never part of Final in the first place (it's a cost pass-through, not
  // revenue), so mixing it in here would make Balance (Final − Received +
  // Reimbursement due) go permanently negative by the reimbursed amount the
  // moment a reimbursement is settled, even though nothing is actually owed.
  const paymentSums = (await pool.query("SELECT lead_id, COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'received' AND type = 'payment' GROUP BY lead_id")).rows;
  const receivedByLead = {};
  paymentSums.forEach((p) => (receivedByLead[p.lead_id] = Number(p.total)));
  const dueReimbursementSums = (await pool.query("SELECT lead_id, COALESCE(SUM(amount), 0) AS total FROM payments WHERE type = 'client_reimbursement' AND status = 'due' GROUP BY lead_id")).rows;
  const dueReimbursementByLead = {};
  dueReimbursementSums.forEach((p) => (dueReimbursementByLead[p.lead_id] = Number(p.total)));
  // So the Leads tab can show "when did I last quote this person" -- helps
  // judge when a follow-up is actually due instead of guessing.
  const lastQuoted = (await pool.query("SELECT lead_id, MAX(created_at) AS last_quoted_at, COUNT(*) AS quote_count FROM quotes GROUP BY lead_id")).rows;
  const lastQuotedByLead = {};
  lastQuoted.forEach((q) => (lastQuotedByLead[q.lead_id] = { last_quoted_at: q.last_quoted_at, quote_count: Number(q.quote_count) }));
  const teamCounts = (await pool.query(`SELECT lead_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'accepted') AS accepted, COUNT(*) FILTER (WHERE status = 'declined') AS declined FROM event_assignments GROUP BY lead_id`)).rows;
  const teamByLead = {};
  teamCounts.forEach((t) => (teamByLead[t.lead_id] = { total: Number(t.total), accepted: Number(t.accepted), declined: Number(t.declined) }));
  const travelCounts = (await pool.query(`SELECT travel_legs.lead_id, COUNT(*) AS total,
      COUNT(*) FILTER (WHERE travel_legs.status IN ('booked','self_arranged')) AS booked,
      COUNT(*) FILTER (WHERE travel_legs.status = 'self_arranged' OR (travel_legs.status = 'booked' AND EXISTS (SELECT 1 FROM documents d WHERE d.travel_leg_id = travel_legs.id))) AS done
    FROM travel_legs WHERE travel_legs.lead_id IS NOT NULL GROUP BY travel_legs.lead_id`)).rows;
  const travelByLead = {};
  travelCounts.forEach((t) => (travelByLead[t.lead_id] = { total: Number(t.total), booked: Number(t.booked), done: Number(t.done) }));
  // Admin-only: other events' travel that overlaps a still-open lead's date, so a
  // new enquiry for a day the team is already on the road gets flagged. Managers
  // never get this (it would expose admin travel).
  const travelClashByLead = {};
  if (req.user.access_level === "admin") {
    const legRows = (await pool.query(`SELECT tl.lead_id, tl.from_city, tl.to_city,
        LEFT(tl.departure_at, 10) AS d1, LEFT(COALESCE(NULLIF(tl.arrival_at, ''), tl.departure_at), 10) AS d2,
        l.name AS lead_name, l.combo_group_id
      FROM travel_legs tl JOIN leads l ON l.id = tl.lead_id
      WHERE tl.departure_at IS NOT NULL AND tl.departure_at <> ''`)).rows;
    rows.forEach((l) => {
      if (!l.date || !["New", "Follow-up", "Interested", "Tentative"].includes(l.stage)) return;
      const seen = new Set();
      const hits = legRows.filter((g) => {
        if (g.lead_id === l.id || (l.combo_group_id && g.combo_group_id === l.combo_group_id)) return false;
        const end = g.d2 && g.d2 >= g.d1 ? g.d2 : g.d1;
        if (!(g.d1 <= l.date && l.date <= end)) return false;
        if (seen.has(g.lead_id)) return false;
        seen.add(g.lead_id); return true;
      });
      if (hits.length) travelClashByLead[l.id] = hits.slice(0, 2).map((g) => ({ lead: g.lead_name, from: (g.from_city || "").trim(), to: (g.to_city || "").trim(), start: g.d1, end: g.d2 && g.d2 >= g.d1 ? g.d2 : g.d1 }));
    });
  }
  const withReceived = rows.map((l) => ({
    ...l,
    travel_clash: travelClashByLead[l.id] || null,
    travel_total: travelByLead[l.id]?.total || 0,
    travel_booked: travelByLead[l.id]?.booked || 0,
    travel_done: travelByLead[l.id]?.done || 0,
    team_total: teamByLead[l.id]?.total || 0,
    team_accepted: teamByLead[l.id]?.accepted || 0,
    team_declined: teamByLead[l.id]?.declined || 0,
    received: receivedByLead[l.id] || 0,
    reimbursement_due: dueReimbursementByLead[l.id] || 0,
    last_quoted_at: lastQuotedByLead[l.id]?.last_quoted_at || null,
    quote_count: lastQuotedByLead[l.id]?.quote_count || 0,
  }));

  let hasLeadsAccess = true;
  if (req.user.access_level === "staff") {
    let perms = null;
    try { perms = req.user.permissions ? JSON.parse(req.user.permissions) : null; } catch { perms = null; }
    if (perms && !perms.includes("leads")) hasLeadsAccess = false;
  }
  if (isScopedManager(req.user)) hasLeadsAccess = false;
  if (hasLeadsAccess) return res.json(withReceived.map((l) => stripLeadMoney(l, req.user)));
  // Restricted staff (e.g. a manager who can assign team but not view the pipeline)
  // still need basic event info for the calendar and team assignment — nothing sensitive.
  // And if they're on the team roster themselves, only the events they've been
  // allotted (and haven't declined) — not the whole company calendar.
  let visible = withReceived;
  if (userHasSection(req.user, "assign_team") && !isScopedManager(req.user)) {
    // Someone who plans the team needs every confirmed event to plan it for — operations details only.
    visible = withReceived.filter((l) => ["Confirmed", "Completed"].includes(l.stage));
  } else {
    const mineIds = await assignedLeadIdSet(req.user);
    if (mineIds) visible = withReceived.filter((l) => mineIds.has(l.id));
    if (isScopedManager(req.user)) visible = visible.filter((l) => ["Confirmed", "Completed"].includes(l.stage));
  }
  const withCounts = userHasSection(req.user, "assign_team")
    ? (l) => ({ ...restrictedLeadView(l), team_total: l.team_total, team_accepted: l.team_accepted, team_declined: l.team_declined, travel_total: l.travel_total, travel_booked: l.travel_booked, travel_done: l.travel_done })
    : restrictedLeadView;
  res.json(visible.map(withCounts));
});

// Public lead-capture endpoint — this is the form link you'd share with a new query.
// Public — lets the enquiry form warn a customer their date is already booked
// and offer to submit anyway with a flexible alternative date.
app.get("/api/availability", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });
  const row = (await pool.query("SELECT name FROM leads WHERE date = $1 AND stage = 'Confirmed' LIMIT 1", [date])).rows[0];
  const blocked = (await pool.query("SELECT 1 FROM blocked_dates WHERE $1 BETWEEN start_date AND end_date LIMIT 1", [date])).rows[0];
  res.json({ booked: !!row || !!blocked });
});

// ---------- Blocked dates (personal/off-limits — vacations, etc.) ----------
app.get("/api/blocked-dates", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM blocked_dates ORDER BY start_date ASC");
  res.json(rows);
});

app.post("/api/blocked-dates", requireAuth, requireAdmin, async (req, res) => {
  const { startDate, endDate, reason } = req.body;
  if (!startDate) return res.status(400).json({ error: "startDate is required" });
  const finalEnd = endDate || startDate;
  if (finalEnd < startDate) return res.status(400).json({ error: "End date can't be before the start date" });
  const id = uuid();
  await pool.query(`
    INSERT INTO blocked_dates (id, start_date, end_date, reason, created_by, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [id, startDate, finalEnd, reason || null, await actorName(req.user), new Date().toISOString()]);
  logActivity(req, `Blocked ${startDate}${finalEnd !== startDate ? ` – ${finalEnd}` : ""}${reason ? ` (${reason})` : ""}`, null);
  res.status(201).json((await pool.query("SELECT * FROM blocked_dates WHERE id = $1", [id])).rows[0]);
});

app.delete("/api/blocked-dates/:id", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM blocked_dates WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// ---------- B2B contacts (event managers, agencies, etc.) ----------
// Business generated per contact is tracked by matching leads.phone to the
// contact's phone — a manager submitting via the "Event Manager" path on the
// public form has their own name/phone on the lead itself (see /api/leads),
// so this join needs no separate linking field.
app.get("/api/b2b-contacts", requireAuth, requireSection("b2b"), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.*,
      COALESCE(s.lead_count, 0) AS lead_count,
      COALESCE(s.confirmed_count, 0) AS confirmed_count,
      COALESCE(s.total_revenue, 0) AS total_revenue,
      s.last_event_date,
      s.last_enquiry_at
    FROM b2b_contacts c
    LEFT JOIN (
      SELECT phone,
        COUNT(*) AS lead_count,
        COUNT(*) FILTER (WHERE stage IN ('Confirmed', 'Completed')) AS confirmed_count,
        SUM(CASE WHEN stage IN ('Confirmed', 'Completed') THEN COALESCE(final_amount, quote_amount, 0) ELSE 0 END) AS total_revenue,
        MAX(date) AS last_event_date,
        MAX(created_at) AS last_enquiry_at
      FROM leads
      WHERE phone IS NOT NULL
      GROUP BY phone
    ) s ON s.phone = c.phone
    ORDER BY c.name ASC
  `);
  res.json(rows);
});

// Every lead + quote tied to this contact (matched by phone) — what's
// generated the "how much business has this manager brought us" view.
app.get("/api/b2b-contacts/:id/history", requireAuth, requireSection("b2b"), async (req, res) => {
  const contact = (await pool.query("SELECT * FROM b2b_contacts WHERE id = $1", [req.params.id])).rows[0];
  if (!contact) return res.status(404).json({ error: "Contact not found" });
  if (!contact.phone) return res.json({ leads: [], quotes: [] });
  const leads = (await pool.query("SELECT * FROM leads WHERE phone = $1 ORDER BY date DESC", [contact.phone])).rows;
  const leadIds = leads.map((l) => l.id);
  const quotes = leadIds.length
    ? (await pool.query("SELECT * FROM quotes WHERE lead_id = ANY($1::text[]) ORDER BY created_at DESC", [leadIds])).rows
    : [];
  res.json({ leads, quotes });
});

app.post("/api/b2b-contacts", requireAuth, requireSection("b2b"), async (req, res) => {
  const { name, company, phone, email, city, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });
  const id = uuid();
  await pool.query(`
    INSERT INTO b2b_contacts (id, name, company, phone, email, city, notes, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [id, name.trim(), company || null, phone || null, email || null, city || null, notes || null, new Date().toISOString()]);
  logActivity(req, `Added B2B contact: ${name.trim()}${company ? ` (${company})` : ""}`, null);
  res.status(201).json((await pool.query("SELECT * FROM b2b_contacts WHERE id = $1", [id])).rows[0]);
});

app.patch("/api/b2b-contacts/:id", requireAuth, requireSection("b2b"), async (req, res) => {
  const contact = (await pool.query("SELECT * FROM b2b_contacts WHERE id = $1", [req.params.id])).rows[0];
  if (!contact) return res.status(404).json({ error: "Contact not found" });
  const fields = ["name", "company", "phone", "email", "city", "notes", "last_contacted_at", "last_rate_card_sent_at", "last_rate_card_snapshot"];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    const bodyKey = f === "last_contacted_at" ? "lastContactedAt" : f === "last_rate_card_sent_at" ? "lastRateCardSentAt" : f === "last_rate_card_snapshot" ? "lastRateCardSnapshot" : f;
    if (req.body[bodyKey] !== undefined) {
      values.push(req.body[bodyKey] || null);
      updates.push(`${f} = $${values.length}`);
    }
  });
  if (updates.length === 0) return res.json(contact);
  values.push(req.params.id);
  await pool.query(`UPDATE b2b_contacts SET ${updates.join(", ")} WHERE id = $${values.length}`, values);
  res.json((await pool.query("SELECT * FROM b2b_contacts WHERE id = $1", [req.params.id])).rows[0]);
});

app.delete("/api/b2b-contacts/:id", requireAuth, requireSection("b2b"), async (req, res) => {
  await pool.query("DELETE FROM b2b_contacts WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// ---------- Musicians directory (freelance pool, filterable by city/instrument) ----------
// Separate from Team — a wider roster of musicians you've come across, not
// just the ones actively performing with you. A musician can be promoted
// into Team (team_id gets set) without a login being created; a login is
// added separately, whenever wanted, from the Team tab's existing flow.
app.get("/api/musicians", requireAuth, requireAdmin, async (req, res) => {
  const { rows: musicians } = await pool.query(`
    SELECT musicians.*, team.name AS team_name
    FROM musicians
    LEFT JOIN team ON team.id = musicians.team_id
    ORDER BY musicians.name ASC
  `);
  const ids = musicians.map((m) => m.id);
  const instrumentRows = ids.length > 0
    ? (await pool.query(`SELECT musician_id, instrument FROM musician_instruments WHERE musician_id = ANY($1) ORDER BY instrument ASC`, [ids])).rows
    : [];
  const showMoney = canSeeMoney(req.user);
  res.json(musicians.map(({ rate_local, rate_outstation, ...m }) => ({
    ...m,
    ...(showMoney ? { rate_local, rate_outstation } : {}),
    instruments: instrumentRows.filter((i) => i.musician_id === m.id).map((i) => i.instrument),
  })));
});

app.post("/api/musicians", requireAuth, requireAdmin, async (req, res) => {
  const { name, phone, city, notes, instruments } = req.body;
  const rateLocal = canSeeMoney(req.user) ? req.body.rateLocal : undefined;
  const rateOutstation = canSeeMoney(req.user) ? req.body.rateOutstation : undefined;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });
  const id = uuid();
  await pool.query(`
    INSERT INTO musicians (id, name, phone, city, rate_local, rate_outstation, notes, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [id, name.trim(), phone || null, city || null, rateLocal || null, rateOutstation || null, notes || null, new Date().toISOString()]);
  const instrumentList = Array.isArray(instruments) ? [...new Set(instruments.map((i) => i.trim()).filter(Boolean))] : [];
  for (const instrument of instrumentList) {
    await pool.query(`INSERT INTO musician_instruments (id, musician_id, instrument) VALUES ($1, $2, $3)`, [uuid(), id, instrument]);
  }
  logActivity(req, `Added musician: ${name.trim()}${instrumentList.length ? ` (${instrumentList.join(", ")})` : ""}`, null);
  res.status(201).json({ id });
});

app.patch("/api/musicians/:id", requireAuth, requireAdmin, async (req, res) => {
  const musician = (await pool.query("SELECT * FROM musicians WHERE id = $1", [req.params.id])).rows[0];
  if (!musician) return res.status(404).json({ error: "Musician not found" });
  const fields = ["name", "phone", "city", "rate_local", "rate_outstation", "notes"];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    const bodyKey = f === "rate_local" ? "rateLocal" : f === "rate_outstation" ? "rateOutstation" : f;
    if ((f === "rate_local" || f === "rate_outstation") && !canSeeMoney(req.user)) return; // rates are commercial
    if (req.body[bodyKey] !== undefined) {
      values.push(req.body[bodyKey] || null);
      updates.push(`${f} = $${values.length}`);
    }
  });
  if (updates.length > 0) {
    values.push(req.params.id);
    await pool.query(`UPDATE musicians SET ${updates.join(", ")} WHERE id = $${values.length}`, values);
  }
  if (Array.isArray(req.body.instruments)) {
    await pool.query("DELETE FROM musician_instruments WHERE musician_id = $1", [req.params.id]);
    const instrumentList = [...new Set(req.body.instruments.map((i) => i.trim()).filter(Boolean))];
    for (const instrument of instrumentList) {
      await pool.query(`INSERT INTO musician_instruments (id, musician_id, instrument) VALUES ($1, $2, $3)`, [uuid(), req.params.id, instrument]);
    }
  }
  const updated = (await pool.query("SELECT * FROM musicians WHERE id = $1", [req.params.id])).rows[0];
  const instruments = (await pool.query("SELECT instrument FROM musician_instruments WHERE musician_id = $1 ORDER BY instrument ASC", [req.params.id])).rows.map((r) => r.instrument);
  const { rate_local: rl, rate_outstation: ro, ...updatedRest } = updated;
  res.json({ ...updatedRest, ...(canSeeMoney(req.user) ? { rate_local: rl, rate_outstation: ro } : {}), instruments });
});

app.delete("/api/musicians/:id", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM musicians WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// Past + upcoming events for one artist. Team members: events they're assigned to, plus any
// guest gigs they did before being promoted from Musicians. Musicians: guest gigs, plus their
// Team assignments if they've been promoted.
async function artistHistory({ teamId, musicianId }) {
  const rows = [];
  if (teamId) {
    const a = (await pool.query(`SELECT leads.id, leads.name, leads.date, leads.city, leads.event_type, leads.stage, event_assignments.status AS status
      FROM event_assignments JOIN leads ON leads.id = event_assignments.lead_id WHERE event_assignments.team_id = $1`, [teamId])).rows;
    a.forEach((r) => rows.push({ ...r, as: "Team" }));
  }
  const guestWhere = (musicianId ? "ta.musician_id = $1" : "ta.musician_id IN (SELECT id FROM musicians WHERE team_id = $1)") + " AND ta.migrated_assignment_id IS NULL";
  const g = (await pool.query(`SELECT leads.id, leads.name, leads.date, leads.city, leads.event_type, leads.stage
    FROM temp_artists ta JOIN leads ON leads.id = ta.lead_id WHERE ${guestWhere}`, [musicianId || teamId])).rows;
  g.forEach((r) => rows.push({ ...r, status: null, as: "Guest" }));
  const seen = new Set();
  return rows.filter((r) => { const k = r.id + r.as; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => String(y.date || "").localeCompare(String(x.date || "")));
}
app.get("/api/team/:id/history", requireAuth, requireAdmin, async (req, res) => {
  res.json(await artistHistory({ teamId: req.params.id }));
});
app.get("/api/musicians/:id/history", requireAuth, requireAdmin, async (req, res) => {
  const m = (await pool.query("SELECT team_id FROM musicians WHERE id = $1", [req.params.id])).rows[0];
  if (!m) return res.status(404).json({ error: "Musician not found" });
  res.json(await artistHistory({ teamId: m.team_id || null, musicianId: req.params.id }));
});
app.get("/api/musicians/:id/id-docs", requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT id, label, original_name, mime_type, uploaded_at FROM team_id_docs WHERE musician_id = $1 ORDER BY uploaded_at ASC", [req.params.id]);
  res.json(rows.map((d) => ({ ...d, url: `/api/team-id-docs/${d.id}/file` })));
});
app.post("/api/musicians/:id/id-docs", requireAuth, requireAdmin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (!ID_DOC_MIMES.test(req.file.mimetype || "")) return res.status(400).json({ error: "Please upload a photo (JPG/PNG) or a PDF." });
  const m = (await pool.query("SELECT team_id FROM musicians WHERE id = $1", [req.params.id])).rows[0];
  if (!m) return res.status(404).json({ error: "Musician not found" });
  // Already in Team? Keep the ID with the team member so travel sharing finds it.
  await pool.query("INSERT INTO team_id_docs (id, team_id, musician_id, label, original_name, mime_type, file_data, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [uuid(), m.team_id || null, m.team_id ? null : req.params.id, (req.body.label || "").trim() || null, req.file.originalname, req.file.mimetype, req.file.buffer, new Date().toISOString()]);
  res.status(201).json({ ok: true });
});

// Promotes a musician into Team — creates the team row (no login) and links
// it back on the musician record. Gated by manage_team (not just the
// "musicians" section) since it's really a Team-management action.
app.post("/api/musicians/:id/promote", requireAuth, requireAdmin, async (req, res) => {
  const musician = (await pool.query("SELECT * FROM musicians WHERE id = $1", [req.params.id])).rows[0];
  if (!musician) return res.status(404).json({ error: "Musician not found" });
  if (musician.team_id) return res.status(400).json({ error: "Already added to Team" });
  const instruments = (await pool.query("SELECT instrument FROM musician_instruments WHERE musician_id = $1 ORDER BY instrument ASC", [req.params.id])).rows.map((r) => r.instrument);
  const teamId = uuid();
  await pool.query(`
    INSERT INTO team (id, name, role, phone, specialty, base_city, local_fee, outstation_fee)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [teamId, musician.name, instruments.length ? `${instruments.join(", ")} player` : "Musician", musician.phone || null, instruments.join(", ") || null, musician.city || null, musician.rate_local || null, musician.rate_outstation || null]);
  await pool.query("UPDATE musicians SET team_id = $1 WHERE id = $2", [teamId, req.params.id]);
  // Carry over registration details, email and any saved IDs so nothing is re-entered.
  await pool.query("UPDATE team SET reg_details = $1, email = COALESCE($2, email) WHERE id = $3", [musician.reg_details || null, musician.email || null, teamId]);
  await pool.query("UPDATE team_id_docs SET team_id = $1, musician_id = NULL WHERE musician_id = $2", [teamId, req.params.id]);
  logActivity(req, `Added ${musician.name} to Team from the Musicians directory`, null);
  res.status(201).json({ teamId });
});

app.post("/api/leads", async (req, res) => {
  const {
    name, phone, email, eventType, city, state, date, budget, notes,
    venue, occasion, guestRange, details, howHeard, whatsappOptin, altDate, whatsappNumber, pcs,
    isEventManager, managerCompany, managerCity, managerInstagram,
  } = req.body;
  if (!name || !eventType || !date) {
    return res.status(400).json({ error: "name, eventType, and date are required" });
  }
  // Reject any enquiry for a date that's already passed — a past date can't
  // be booked, and letting it through just clutters the pipeline. Uses the
  // same UTC-date convention as the rest of the app for consistency.
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) {
    return res.status(400).json({ error: "That event date has already passed. Please choose today's date or a future date." });
  }
  if (altDate && altDate < today) {
    return res.status(400).json({ error: "The alternative date has already passed. Please choose today's date or a future date." });
  }
  // Don't accept a new enquiry for a date we're already Confirmed for, or a
  // date deliberately blocked off (e.g. a personal trip) — unless they've
  // also given a valid alternative date, matching the flexibility the form
  // itself offers. Blocking outright even when a good alternative was given
  // would make that field pointless. The rejection message is the same
  // either way — no need to explain why a date isn't available.
  const isDateUnavailable = async (d) => {
    const taken = (await pool.query("SELECT 1 FROM leads WHERE stage = 'Confirmed' AND date = $1 LIMIT 1", [d])).rows[0];
    if (taken) return true;
    const blocked = (await pool.query("SELECT 1 FROM blocked_dates WHERE $1 BETWEEN start_date AND end_date LIMIT 1", [d])).rows[0];
    return !!blocked;
  };
  if (await isDateUnavailable(date)) {
    const altTaken = altDate ? await isDateUnavailable(altDate) : true;
    if (!altDate || altTaken) {
      return res.status(409).json({
        error: altDate
          ? "We're already booked for both that date and the alternative you gave. Please try a different date."
          : "We're already booked for that date. Please choose a different date, or enter an alternate date below.",
      });
    }
  }
  const id = uuid();
  const autoNote = isEventManager
    ? `📇 Submitted via Event Manager/Artist Manager: ${name}${managerCompany ? ` (${managerCompany})` : ""}${managerInstagram ? ` — IG: ${managerInstagram}` : ""}`
    : null;
  await pool.query(`
    INSERT INTO leads (
      id, name, phone, email, event_type, city, state, date, budget, stage, advance, notes, created_at,
      venue, occasion, guest_range, details, how_heard, whatsapp_optin, alt_date, whatsapp_number, pcs, is_b2b
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'New', 0, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
  `, [
    id, name, phone || null, email || null, eventType, city || null, state || null, date, budget || null, autoNote || notes || null, new Date().toISOString(),
    venue || null, occasion || null, guestRange || null,
    details || null, howHeard || null, whatsappOptin ? 1 : 0, altDate || null, whatsappNumber || null, pcs || null, isEventManager ? 1 : 0,
  ]);
  const created = (await pool.query("SELECT * FROM leads WHERE id = $1", [id])).rows[0];
  res.status(201).json(created);
  // Date already held by another open lead? Say so in the alert + log (the lead card also shows it live).
  let clashNote = "";
  try {
    const held = (await pool.query("SELECT name, stage FROM leads WHERE date = $1 AND id <> $2 AND stage IN ('New','Follow-up','Interested','Tentative','Confirmed') LIMIT 3", [date, id])).rows;
    if (held.length) clashNote = ` ⚠️ Same date as ${held.map((h) => `${h.name} (${h.stage})`).join(", ")}`;
  } catch (e) { /* non-fatal */ }
  logActivity({ user: null }, `New query received: ${name} — ${packageName(eventType)}${city ? ` in ${city}` : ""}${clashNote}`, id);

  // Submitted by an Event Manager / Artist Manager on a client's behalf —
  // save them to the B2B directory so future outreach (rate cards, etc.)
  // doesn't need them re-entered by hand. Matched on phone number so the
  // same manager submitting again updates their existing record instead of
  // piling up duplicates.
  if (isEventManager && phone) {
    upsertB2bContact({ name, phone, company: managerCompany, city: managerCity, instagram: managerInstagram });
  }

  // Flashing in-app alert (same feed used for team responses) plus an email —
  // so a new query is hard to miss whether you're in the app or not.
  // Admin-only — a new sales enquiry isn't a manager's concern, unlike the
  // event-coordination notifications below which they now share with admin.
  pool.query(`
    INSERT INTO admin_notifications (id, message, assignment_id, audience, created_at)
    VALUES ($1, $2, NULL, 'admin', $3)
  `, [uuid(), `New query: ${name} — ${packageName(eventType)}${city ? ` in ${city}` : ""}, wants ${date}${clashNote}`, new Date().toISOString()]
  ).catch((err) => console.error("Failed to create new-lead notification:", err.message));

  sendNewLeadEmail(created).catch((err) => console.error("New-lead email failed (not fatal):", err.message));
  notifyNewQuery(created).catch((err) => console.error("Push notification failed (not fatal):", err.message));
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

// Windsor.ai's free plan caps out at 1 connected source — GA4 now reads
// directly from Google instead (see fetchWebsiteTraffic below) precisely so
// Instagram keeps that one free Windsor slot to itself. Still worth
// detecting the plan-limit error text here in case that ever changes, so a
// billing message never gets parsed as if it were a real stat.
function isWindsorPlanLimitError(json) {
  return /free plan|upgrade|onboard\.windsor\.ai/i.test(JSON.stringify(json));
}

async function fetchLiveInstagramStats() {
  const apiKey = process.env.WINDSOR_API_KEY;
  if (!apiKey) return null;
  const url = `https://connectors.windsor.ai/instagram_public?api_key=${apiKey}&fields=media_like_count,profile_followers_count,profile_media_count&date_preset=last_2years&_renderer=json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Windsor.ai returned ${resp.status}`);
  const json = await resp.json();
  if (isWindsorPlanLimitError(json)) throw new Error("Windsor.ai account/plan limit reached");
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

// ---------- Live reels (Windsor.ai) — auto-refreshing, replaces the hardcoded embed list ----------
let reelsCache = { data: null, fetchedAt: 0 };
const REELS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours, same cadence as the stats above

async function fetchLatestReels() {
  const apiKey = process.env.WINDSOR_API_KEY;
  if (!apiKey) return null;
  const fields = "media_id,media_permalink,media_type,media_timestamp,media_caption,media_thumbnail_url,media_like_count";
  const url = `https://connectors.windsor.ai/instagram_public?api_key=${apiKey}&fields=${fields}&date_preset=last_2years&_renderer=json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Windsor.ai returned ${resp.status}`);
  const json = await resp.json();
  if (isWindsorPlanLimitError(json)) throw new Error("Windsor.ai account/plan limit reached");
  const rows = Array.isArray(json) ? json : (json.data || []);
  return rows
    .filter((r) => r.media_type === "REEL" && r.media_permalink)
    .sort((a, b) => new Date(b.media_timestamp) - new Date(a.media_timestamp))
    .slice(0, 12)
    .map((r) => ({
      id: r.media_id,
      permalink: r.media_permalink,
      caption: r.media_caption || "",
      thumbnailUrl: r.media_thumbnail_url || null,
      timestamp: r.media_timestamp || null,
      likeCount: Number(r.media_like_count) || 0,
    }));
}

app.get("/api/public/reels", async (req, res) => {
  const isFresh = reelsCache.data && (Date.now() - reelsCache.fetchedAt) < REELS_TTL_MS;
  if (isFresh) return res.json({ reels: reelsCache.data });
  try {
    const reels = await fetchLatestReels();
    if (reels && reels.length) {
      reelsCache = { data: reels, fetchedAt: Date.now() };
      return res.json({ reels });
    }
    return res.json({ reels: reelsCache.data || [] });
  } catch (err) {
    console.error("Live reels fetch failed:", err.message);
    return res.json({ reels: reelsCache.data || [] });
  }
});

// ---------- Google Calendar sync (Confirmed/Completed events) ----------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://www.togetheroutloud.in/api/google-calendar/callback";
const GOOGLE_CALENDAR_AUTH_ROW_ID = "singleton";
const GOOGLE_ANALYTICS_REDIRECT_URI = process.env.GOOGLE_ANALYTICS_REDIRECT_URI || "https://www.togetheroutloud.in/api/google-analytics/callback";
const GOOGLE_ANALYTICS_AUTH_ROW_ID = "singleton";

app.get("/api/google-calendar/status", requireAuth, requireAdmin, async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.json({ configured: false, connected: false });
  const row = (await pool.query("SELECT connected_by, connected_at FROM google_calendar_auth WHERE id = $1", [GOOGLE_CALENDAR_AUTH_ROW_ID])).rows[0];
  res.json({ configured: true, connected: !!row, connectedBy: row?.connected_by || null, connectedAt: row?.connected_at || null });
});

app.get("/api/google-calendar/connect", requireAuth, requireAdmin, (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).send("Google Calendar isn't configured yet — GOOGLE_CLIENT_ID is missing.");
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.events",
    access_type: "offline",
    prompt: "consent",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/api/google-calendar/callback", requireAuth, requireAdmin, async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?googleCalendar=error&reason=${encodeURIComponent(error)}`);
  if (!code) return res.redirect(`/?googleCalendar=error&reason=no_code`);
  try {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI, grant_type: "authorization_code",
      }),
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok || !tokenJson.refresh_token) {
      // No refresh_token usually means Google already had a prior grant and
      // didn't re-issue one — prompt=consent above should prevent this, but
      // if it still happens, the fix is disconnecting in Google's own
      // account permissions page, then reconnecting here.
      return res.redirect(`/?googleCalendar=error&reason=${encodeURIComponent(tokenJson.error || "no_refresh_token")}`);
    }
    const actor = await actorName(req.user);
    await pool.query(`
      INSERT INTO google_calendar_auth (id, access_token, refresh_token, expires_at, connected_by, connected_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET access_token = $2, refresh_token = $3, expires_at = $4, connected_by = $5, connected_at = $6
    `, [GOOGLE_CALENDAR_AUTH_ROW_ID, tokenJson.access_token, tokenJson.refresh_token, Date.now() + tokenJson.expires_in * 1000, actor, new Date().toISOString()]);
    res.redirect(`/?googleCalendar=connected`);
  } catch (err) {
    console.error("Google Calendar connect failed:", err.message);
    res.redirect(`/?googleCalendar=error&reason=${encodeURIComponent(err.message)}`);
  }
});

app.post("/api/google-calendar/disconnect", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM google_calendar_auth WHERE id = $1", [GOOGLE_CALENDAR_AUTH_ROW_ID]);
  res.json({ ok: true });
});

// ---------- Google Analytics (GA4) — direct, free API access ----------
// Deliberately NOT routed through Windsor.ai (see fetchWebsiteTraffic below):
// this reuses the same Google Cloud OAuth app as Calendar above, just a
// different scope + its own token row, so it costs nothing.
app.get("/api/google-analytics/status", requireAuth, requireAdmin, async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.json({ configured: false, connected: false });
  const row = (await pool.query("SELECT connected_by, connected_at, property_id FROM google_analytics_auth WHERE id = $1", [GOOGLE_ANALYTICS_AUTH_ROW_ID])).rows[0];
  res.json({ configured: true, connected: !!row, connectedBy: row?.connected_by || null, connectedAt: row?.connected_at || null, propertyId: row?.property_id || null });
});

app.get("/api/google-analytics/connect", requireAuth, requireAdmin, (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).send("Google Analytics isn't configured yet — GOOGLE_CLIENT_ID is missing.");
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_ANALYTICS_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    access_type: "offline",
    prompt: "consent",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/api/google-analytics/callback", requireAuth, requireAdmin, async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?googleAnalytics=error&reason=${encodeURIComponent(error)}`);
  if (!code) return res.redirect(`/?googleAnalytics=error&reason=no_code`);
  try {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_ANALYTICS_REDIRECT_URI, grant_type: "authorization_code",
      }),
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok || !tokenJson.refresh_token) {
      return res.redirect(`/?googleAnalytics=error&reason=${encodeURIComponent(tokenJson.error || "no_refresh_token")}`);
    }
    // Auto-discover the GA4 property so Ashwin doesn't have to hunt for the
    // numeric property ID himself — take the first property Google returns,
    // since togetheroutloud.in is the only site being tracked.
    let propertyId = null;
    try {
      const summaryResp = await fetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries", {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      const summaryJson = await summaryResp.json();
      const firstProperty = (summaryJson.accountSummaries || []).flatMap((a) => a.propertySummaries || [])[0];
      if (firstProperty) propertyId = firstProperty.property.replace("properties/", "");
    } catch (err) {
      console.error("GA4 property auto-discovery failed:", err.message);
    }
    const actor = await actorName(req.user);
    await pool.query(`
      INSERT INTO google_analytics_auth (id, access_token, refresh_token, expires_at, property_id, connected_by, connected_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET access_token = $2, refresh_token = $3, expires_at = $4,
        property_id = COALESCE($5, google_analytics_auth.property_id), connected_by = $6, connected_at = $7
    `, [GOOGLE_ANALYTICS_AUTH_ROW_ID, tokenJson.access_token, tokenJson.refresh_token, Date.now() + tokenJson.expires_in * 1000, propertyId, actor, new Date().toISOString()]);
    res.redirect(propertyId ? `/?googleAnalytics=connected` : `/?googleAnalytics=connected_no_property`);
  } catch (err) {
    console.error("Google Analytics connect failed:", err.message);
    res.redirect(`/?googleAnalytics=error&reason=${encodeURIComponent(err.message)}`);
  }
});

app.post("/api/google-analytics/disconnect", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM google_analytics_auth WHERE id = $1", [GOOGLE_ANALYTICS_AUTH_ROW_ID]);
  res.json({ ok: true });
});

// Manual fallback for when auto-discovery (via the Analytics Admin API)
// comes back empty — usually because that API isn't enabled yet on the
// Google Cloud project, which is a separate switch from OAuth login working.
// The property ID is visible in Google Analytics itself (Admin > Property
// Settings) or, in this case, was already visible via Windsor's account picker.
app.patch("/api/google-analytics/property", requireAuth, requireAdmin, async (req, res) => {
  const { propertyId } = req.body;
  if (!propertyId || !/^\d+$/.test(String(propertyId).trim())) {
    return res.status(400).json({ error: "propertyId must be a numeric GA4 property ID" });
  }
  const result = await pool.query(
    "UPDATE google_analytics_auth SET property_id = $1 WHERE id = $2",
    [String(propertyId).trim(), GOOGLE_ANALYTICS_AUTH_ROW_ID]
  );
  if (result.rowCount === 0) return res.status(400).json({ error: "Not connected yet — connect first, then set the property ID." });
  websiteTrafficCache = { data: null, fetchedAt: 0 }; // force a fresh fetch with the new property
  res.json({ ok: true });
});

async function getGoogleAnalyticsAuth() {
  const row = (await pool.query("SELECT * FROM google_analytics_auth WHERE id = $1", [GOOGLE_ANALYTICS_AUTH_ROW_ID])).rows[0];
  if (!row) return null;
  if (row.expires_at > Date.now() + 60000) return { accessToken: row.access_token, propertyId: row.property_id };
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: row.refresh_token, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  const json = await resp.json();
  if (!resp.ok) {
    if (json.error === "invalid_grant") await pool.query("DELETE FROM google_analytics_auth WHERE id = $1", [GOOGLE_ANALYTICS_AUTH_ROW_ID]);
    throw new Error(`Google Analytics token refresh failed: ${json.error || resp.status}`);
  }
  await pool.query("UPDATE google_analytics_auth SET access_token = $1, expires_at = $2 WHERE id = $3",
    [json.access_token, Date.now() + json.expires_in * 1000, GOOGLE_ANALYTICS_AUTH_ROW_ID]);
  return { accessToken: json.access_token, propertyId: row.property_id };
}

// One-off backfill for events that were Confirmed/Completed before the sync
// was connected — normal syncing only fires on a stage change going forward,
// so anything already sitting in those stages needs this to catch up.
// Runs in the background (it can take well over the 20s request timeout when
// there are many events) — the page polls /backfill/status for progress.
let gcalBackfill = { running: false, total: 0, done: 0, created: 0, updated: 0, failed: 0, finishedAt: null };
app.post("/api/google-calendar/backfill", requireAuth, requireAdmin, async (req, res) => {
  if (gcalBackfill.running) return res.json({ started: false, ...gcalBackfill });
  const leads = (await pool.query("SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed') ORDER BY date ASC")).rows;
  gcalBackfill = { running: true, total: leads.length, done: 0, created: 0, updated: 0, failed: 0, finishedAt: null };
  res.json({ started: true, ...gcalBackfill });
  (async () => {
    const queue = leads.slice();
    const worker = async () => {
      while (queue.length) {
        const lead = queue.shift();
        const hadEventId = !!lead.google_event_id;
        try {
          await syncLeadToGoogleCalendar(lead);
          const after = (await pool.query("SELECT google_event_id FROM leads WHERE id = $1", [lead.id])).rows[0];
          if (after && after.google_event_id) { hadEventId ? gcalBackfill.updated++ : gcalBackfill.created++; }
          else gcalBackfill.failed++;
        } catch (err) {
          gcalBackfill.failed++;
        }
        gcalBackfill.done++;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    gcalBackfill.running = false;
    gcalBackfill.finishedAt = new Date().toISOString();
  })().catch((err) => { console.error("Google Calendar backfill crashed:", err.message); gcalBackfill.running = false; });
});
app.get("/api/google-calendar/backfill/status", requireAuth, requireAdmin, (req, res) => res.json(gcalBackfill));

async function getGoogleAccessToken() {
  const row = (await pool.query("SELECT * FROM google_calendar_auth WHERE id = $1", [GOOGLE_CALENDAR_AUTH_ROW_ID])).rows[0];
  if (!row) return null;
  if (row.expires_at > Date.now() + 60000) return row.access_token;
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: row.refresh_token, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  const json = await resp.json();
  if (!resp.ok) {
    // Refresh token itself got revoked (e.g. Ashwin removed TOL's access in
    // his Google account) — clear the row so status shows "disconnected"
    // instead of silently failing forever.
    if (json.error === "invalid_grant") await pool.query("DELETE FROM google_calendar_auth WHERE id = $1", [GOOGLE_CALENDAR_AUTH_ROW_ID]);
    throw new Error(`Google token refresh failed: ${json.error || resp.status}`);
  }
  await pool.query("UPDATE google_calendar_auth SET access_token = $1, expires_at = $2 WHERE id = $3",
    [json.access_token, Date.now() + json.expires_in * 1000, GOOGLE_CALENDAR_AUTH_ROW_ID]);
  return json.access_token;
}

// Keeps one Google Calendar event per Confirmed/Completed lead in sync —
// creates it, updates it on further edits, and removes it if the lead moves
// away from those stages (e.g. cancelled). All-day event on the event date,
// since leads don't reliably have a specific start time.
async function syncLeadToGoogleCalendar(lead) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return;
  let accessToken;
  try {
    accessToken = await getGoogleAccessToken();
  } catch (err) {
    console.error("Google Calendar sync skipped:", err.message);
    return;
  }
  if (!accessToken) return; // not connected — nothing to do

  const isBooked = lead.stage === "Confirmed" || lead.stage === "Completed";
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

  if (!isBooked) {
    if (lead.google_event_id) {
      await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${lead.google_event_id}`, { method: "DELETE", headers })
        .catch((err) => console.error("Google Calendar delete failed:", err.message));
      await pool.query("UPDATE leads SET google_event_id = NULL WHERE id = $1", [lead.id]);
    }
    return;
  }

  if (!lead.date) return;
  const nextDay = new Date(lead.date + "T00:00:00Z");
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const RATE_INCLUSION_LABELS = { travel: "Travel", local_transfers: "Local transfers", hotel: "Hotel / accommodation", food: "Food" };
  let inclusionsText = null;
  if (lead.rate_inclusions !== null && lead.rate_inclusions !== undefined) {
    let list = [];
    try { list = JSON.parse(lead.rate_inclusions) || []; } catch { list = []; }
    inclusionsText = list.length > 0
      ? `Includes: ${list.map((id) => RATE_INCLUSION_LABELS[id] || id).join(", ")}`
      : "Billed separately — travel, stay & food not included";
  }
  const descriptionLines = [
    `Client: ${lead.name}`,
    lead.phone ? `Phone: ${lead.phone}` : null,
    (lead.final_amount || lead.quote_amount) ? `Amount: ₹${Number(lead.final_amount || lead.quote_amount).toLocaleString("en-IN")}` : null,
    inclusionsText,
    lead.rate_note ? `Note: ${lead.rate_note}` : null,
    lead.notes ? `Notes: ${lead.notes}` : null,
  ].filter(Boolean);
  const body = {
    summary: `${lead.city || "Unknown city"} — ${packageName(lead.event_type)}`,
    location: [lead.venue, lead.city, lead.state].filter(Boolean).join(", "),
    description: descriptionLines.join("\n"),
    start: { date: lead.date },
    end: { date: nextDay.toISOString().slice(0, 10) },
  };

  try {
    if (lead.google_event_id) {
      const resp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${lead.google_event_id}`, {
        method: "PATCH", headers, body: JSON.stringify(body),
      });
      if (resp.status === 404) {
        // Someone deleted it directly in Google Calendar — recreate rather than error out.
        lead.google_event_id = null;
      } else if (!resp.ok) {
        throw new Error(`Update failed: ${resp.status}`);
      } else {
        return;
      }
    }
    const createResp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    const createJson = await createResp.json();
    if (!createResp.ok) throw new Error(`Create failed: ${createJson.error?.message || createResp.status}`);
    await pool.query("UPDATE leads SET google_event_id = $1 WHERE id = $2", [createJson.id, lead.id]);
  } catch (err) {
    console.error("Google Calendar sync failed for lead", lead.id, ":", err.message);
  }
}

// ---------- Push notifications (new-query alerts to the home-screen PWA) ----------
// iOS 16.4+ supports Web Push for Safari PWAs added to the home screen (not
// in a regular Safari tab), which is how Ashwin/Prakriti use this app.
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:togetheroutloudclub@gmail.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

app.get("/api/push/vapid-public-key", requireAuth, (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

app.post("/api/push/subscribe", requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) return res.status(400).json({ error: "Invalid subscription" });
  await pool.query(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $2, p256dh = $4, auth = $5`,
    [uuid(), req.user.id, endpoint, keys.p256dh, keys.auth, new Date().toISOString()]
  );
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
  res.json({ ok: true });
});

// Sends to every registered subscription (any logged-in user who's opted in
// on their device) — a new-query alert carries no financial/fee data, so
// there's no role-visibility reason to restrict it to admins only.
async function sendPushToAll(title, body, url = "/login", { adminOnly = false } = {}) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  const { rows } = adminOnly
    ? (await pool.query(`SELECT push_subscriptions.* FROM push_subscriptions JOIN users ON users.id = push_subscriptions.user_id WHERE users.access_level = 'admin'`))
    : (await pool.query(`SELECT * FROM push_subscriptions`));
  if (rows.length === 0) return;
  const payload = JSON.stringify({ title, body, url });
  await Promise.all(rows.map(async (sub) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
    } catch (err) {
      // 404/410 means the subscription is gone (uninstalled, permission revoked, etc.) — clean it up.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);
      } else {
        console.error("Push send failed:", err.message);
      }
    }
  }));
}
async function notifyNewQuery(lead) {
  await sendPushToAll("New query received", `${lead.name} — ${packageName(lead.event_type)} in ${lead.city || "?"}`, "/login");
}


// Internal-only (unlike Instagram stats above, which feed the public site) —
// this powers a Dashboard card so Ashwin/Prakriti can see visits and traffic
// sources without leaving the CRM to check analytics.google.com. Cached for
// an hour since GA4 itself only settles data every few hours anyway.
let websiteTrafficCache = { data: null, fetchedAt: 0 };
const WEBSITE_TRAFFIC_TTL_MS = 60 * 60 * 1000; // 1 hour

// Windsor.ai's GA4 connector can return the date dimension as either
// "YYYY-MM-DD" or the raw GA4 "YYYYMMDD" — normalize once here so nothing
// downstream has to guess the format (a previous mismatch here caused dates
// to render as NaN in the dashboard chart).
function normalizeTrafficDate(d) {
  const s = String(d || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

// Reads GA4 directly via Google's own free Analytics Data API — not through
// Windsor.ai. Windsor's free plan caps out at 1 connected source, and
// Instagram already uses that slot for the live site stats, so GA4 needed
// its own free path rather than competing for that slot (or paying Windsor).
async function fetchWebsiteTraffic() {
  const auth = await getGoogleAnalyticsAuth();
  if (!auth) return { notConnected: true };
  if (!auth.propertyId) return { notConnected: true, noProperty: true };
  const { accessToken, propertyId } = auth;
  const runReport = (body) => fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const [byDayResp, byChannelResp] = await Promise.all([
    runReport({
      dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
    }),
    runReport({
      dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    }),
  ]);
  if (!byDayResp.ok) throw new Error(`GA4 returned ${byDayResp.status}`);
  if (!byChannelResp.ok) throw new Error(`GA4 returned ${byChannelResp.status}`);
  const byDayJson = await byDayResp.json();
  const byChannelJson = await byChannelResp.json();
  const byDay = (byDayJson.rows || [])
    .map((r) => ({
      date: normalizeTrafficDate(r.dimensionValues[0].value),
      sessions: Number(r.metricValues[0].value) || 0,
      activeUsers: Number(r.metricValues[1].value) || 0,
      pageViews: Number(r.metricValues[2].value) || 0,
    }))
    .sort((a, b) => (a.date > b.date ? 1 : -1));
  const byChannel = (byChannelJson.rows || [])
    .map((r) => ({ channel: r.dimensionValues[0].value || "Unassigned", sessions: Number(r.metricValues[0].value) || 0 }))
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
    if (traffic && !traffic.notConnected) {
      websiteTrafficCache = { data: traffic, fetchedAt: Date.now() };
      return res.json(traffic);
    }
    if (traffic && traffic.notConnected) return res.json(traffic);
    return res.json(websiteTrafficCache.data || { byDay: [], byChannel: [], totalSessions: 0, totalUsers: 0, totalPageViews: 0, unavailable: true });
  } catch (err) {
    console.error("Website traffic fetch failed:", err.message);
    return res.json(websiteTrafficCache.data || { byDay: [], byChannel: [], totalSessions: 0, totalUsers: 0, totalPageViews: 0, unavailable: true });
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

// ---------- Real event locations (feeds the public global map — free, self-hosted) ----------
// Nominatim's usage policy caps free requests at ~1/sec, so lookups for new
// city names are serialized through this single promise chain rather than
// fired in parallel; already-cached cities (the common case after the first
// run) skip the network call entirely and cost nothing.
let geocodeQueue = Promise.resolve();
async function geocodeCityCached(cityRaw) {
  const key = String(cityRaw || "").trim().toLowerCase();
  if (!key) return null;
  const cached = (await pool.query("SELECT * FROM city_geocode_cache WHERE city_key = $1", [key])).rows[0];
  if (cached) return cached.found ? cached : null;
  geocodeQueue = geocodeQueue.then(() => new Promise((r) => setTimeout(r, 1100)));
  await geocodeQueue;
  try {
    // accept-language=en so the country name always comes back in English
    // (e.g. "Nepal" not "नेपाल") — without it Nominatim's language depends on
    // server config, which was silently breaking country-based dedup/flagging
    // for at least one city.
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityRaw)}&format=jsonv2&addressdetails=1&accept-language=en&limit=1`;
    const resp = await fetch(url, { headers: { "User-Agent": "TogetherOutLoudWebsite/1.0 (togetheroutloudclub@gmail.com)" } });
    if (!resp.ok) throw new Error(`Nominatim returned ${resp.status}`);
    const results = await resp.json();
    const hit = results[0];
    // Fall back to the last comma-separated part of display_name on the rare
    // result that has no structured address.country (e.g. some admin-area
    // matches) — better than silently dropping the country and breaking
    // dedup against a manually-added country highlight.
    const fallbackCountry = hit?.display_name ? hit.display_name.split(",").pop().trim() : null;
    const row = hit
      ? { lat: Number(hit.lat), lng: Number(hit.lon), country: hit.address?.country || fallbackCountry || null, display_name: hit.display_name, found: 1 }
      : { lat: null, lng: null, country: null, display_name: null, found: 0 };
    await pool.query(`
      INSERT INTO city_geocode_cache (city_key, lat, lng, country, display_name, found, resolved_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (city_key) DO UPDATE SET lat = $2, lng = $3, country = $4, display_name = $5, found = $6, resolved_at = $7
    `, [key, row.lat, row.lng, row.country, row.display_name, row.found, new Date().toISOString()]);
    return row.found ? row : null;
  } catch (err) {
    console.error("Geocoding failed for", cityRaw, ":", err.message);
    return null; // leave uncached so it's retried on a future call, not stuck as a permanent miss
  }
}

let eventLocationsCache = { data: null, fetchedAt: 0 };
const EVENT_LOCATIONS_TTL_MS = 60 * 60 * 1000; // 1 hour

// Builds the map data from scratch (real bookings + manual cities/countries,
// each city geocoded and cached). This is slow the first time any given city
// needs geocoding — serially rate-limited to ~1/1.1s against Nominatim — so
// it's called both by the public route below (cache-first) and once at
// server startup (see ready.then(...) further down) to pre-warm the cache in
// the background. Without that warm-up, a cold cache (e.g. right after a
// migration clears it) means the first visitor's browser can time out
// waiting on this and the map silently never appears, even though the data
// finishes resolving successfully moments later.
async function buildEventLocationsData() {
  const { rows } = await pool.query(`
    SELECT city, COUNT(*) AS count FROM leads
    WHERE stage IN ('Confirmed', 'Completed') AND city IS NOT NULL AND TRIM(city) != ''
    GROUP BY city
  `);
  const markers = [];
  const countries = new Set();
  const existingCities = new Set();
  for (const r of rows) {
    const geo = await geocodeCityCached(r.city);
    if (!geo) continue; // unresolved city — will retry on the next cache miss, doesn't block the rest
    markers.push({ city: r.city, lat: geo.lat, lng: geo.lng, country: geo.country, count: Number(r.count) });
    existingCities.add(r.city.trim().toLowerCase());
    if (geo.country) countries.add(geo.country);
  }
  // Manual additional cities (events that happened but have no confirmed-
  // lead record with that city on file, e.g. Surat) — admin-editable via
  // the "Additional cities" card in Settings. Entries may be a plain
  // string or a legacy { name, lat, lng } object from before this reused
  // an older editor; either way the name is re-geocoded here for a
  // consistent, cached source of truth rather than trusting stored coords.
  const manualCitiesRow = (await pool.query("SELECT value FROM site_content WHERE key = 'cities'")).rows[0];
  const manualCities = Array.isArray(manualCitiesRow?.value) ? manualCitiesRow.value : [];
  for (const entry of manualCities) {
    const name = typeof entry === "string" ? entry : entry?.name;
    if (!name || existingCities.has(name.trim().toLowerCase())) continue; // don't double-plot a city already covered by real bookings
    const geo = await geocodeCityCached(name);
    if (!geo) continue;
    markers.push({ city: name, lat: geo.lat, lng: geo.lng, country: geo.country, count: 0 });
    existingCities.add(name.trim().toLowerCase());
    if (geo.country) countries.add(geo.country);
  }
  // Manual international highlights (e.g. shows that predate the CRM and
  // have no confirmed-lead record with a city) — admin-editable via the
  // "International highlights" card in Settings, plotted at country level
  // since there's no specific city on file for these.
  const manualCountriesRow = (await pool.query("SELECT value FROM site_content WHERE key = 'countries'")).rows[0];
  const manualCountries = Array.isArray(manualCountriesRow?.value) ? manualCountriesRow.value : [];
  const existingCountries = new Set(markers.map((m) => (m.country || "").trim().toLowerCase()).filter(Boolean));
  for (const name of manualCountries) {
    if (!name || existingCountries.has(name.trim().toLowerCase())) continue; // don't double-plot a country already covered by real bookings
    const geo = await geocodeCityCached(name);
    if (!geo) continue;
    markers.push({ city: name, lat: geo.lat, lng: geo.lng, country: geo.country || name, count: 0 });
    countries.add(geo.country || name);
  }
  // Collapse near-duplicate markers that are really the same place but got
  // there under different spellings (e.g. the same city typed with extra
  // whitespace across two leads, or "Jorhat" vs "Jorhat, Assam") — grouped
  // by rounded coordinates (~1km) rather than by the raw text, since that
  // text is whatever each lead happened to have typed.
  const mergedByLocation = new Map();
  for (const m of markers) {
    const roundKey = `${m.lat.toFixed(2)},${m.lng.toFixed(2)}`;
    const existing = mergedByLocation.get(roundKey);
    if (!existing) {
      mergedByLocation.set(roundKey, { ...m });
    } else {
      existing.count += m.count;
      if (m.city.length < existing.city.length) existing.city = m.city; // prefer the plainer label
      if (!existing.country && m.country) existing.country = m.country;
    }
  }
  const mergedMarkers = [...mergedByLocation.values()];
  const intlCountries = [...countries].filter((c) => c !== "India").sort();
  return {
    markers: mergedMarkers,
    distinctCities: mergedMarkers.length,
    distinctCountries: countries.size,
    internationalCountries: intlCountries,
  };
}

// Public — drives the global map on the marketing site with real booking
// data (confirmed/completed events), not a manually-curated list, so it
// updates itself as events close and never goes stale.
app.get("/api/public/event-locations", async (req, res) => {
  const isFresh = eventLocationsCache.data && (Date.now() - eventLocationsCache.fetchedAt) < EVENT_LOCATIONS_TTL_MS;
  if (isFresh) return res.json(eventLocationsCache.data);
  try {
    const data = await buildEventLocationsData();
    eventLocationsCache = { data, fetchedAt: Date.now() };
    res.json(data);
  } catch (err) {
    console.error("Event locations fetch failed:", err.message);
    res.json(eventLocationsCache.data || { markers: [], distinctCities: 0, distinctCountries: 0 });
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
app.post("/api/leads/combo", requireAuth, requireSection("leads"), async (req, res) => {
  const { name, phone, email, city, occasion, guestRange, events, budget, finalAmount, alreadyConfirmed, advanceAmount, advanceDate, advanceMode, isB2b } = req.body;
  if (!canSeeMoney(req.user) && (alreadyConfirmed || finalAmount || advanceAmount)) return res.status(403).json({ error: "Confirming with amounts needs Accounts access" });
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
        quote_amount, final_amount, occasion, guest_range, combo_group_id, is_combo_primary, created_at, is_b2b
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15,$16,$17)
    `, [
      id, name, phone || null, email || null, events[i].eventType, city || null, events[i].date,
      isPrimary ? (budget || null) : null,
      alreadyConfirmed ? "Confirmed" : "New",
      isPrimary ? (budget || null) : null,
      isPrimary && alreadyConfirmed ? (finalAmount || null) : null,
      occasion || null, guestRange || null, comboGroupId, isPrimary ? 1 : 0, now, isB2b ? 1 : 0,
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
  // Already-confirmed combo events must reach Google Calendar straight away —
  // previously only the stage-change route synced, so these never appeared.
  if (alreadyConfirmed) {
    for (const r of rows) syncLeadToGoogleCalendar(r).catch((err) => console.error("Google Calendar sync error:", err.message));
  }
  logActivity(req, `Combo booking added for ${name}: ${events.map((e) => packageName(e.eventType)).join(" + ")}${alreadyConfirmed && finalAmount ? ` — ₹${Number(finalAmount).toLocaleString("en-IN")}` : ""}`, createdIds[0]);

  // Same B2B directory upsert as the single-event path below — logged
  // straight away instead of needing a follow-up Edit + Mark as B2B.
  if (isB2b && phone) {
    upsertB2bContact({ name, phone, city });
  }
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
    "cancellation_reason", "snooze_until", "state", "rate_type", "rate_note", "rate_inclusions", "occasion_other", "not_interested_reason", "is_b2b", "thanked_at",
  ];
  const sharedFields = ["event_time", "soundcheck_time", "venue", "sound_manager_name", "sound_manager_phone", "coordinator_name", "coordinator_phone", "contacts"];
  if (!hasLeads) {
    const keyFor = (f) => (f === "assigned_to" ? "assignedTo" : f === "advance_date" ? "advanceDate" : f === "quote_amount" ? "quoteAmount" : f === "final_amount" ? "finalAmount" : f === "event_type" ? "eventType" : f === "guest_range" ? "guestRange" : f === "whatsapp_number" ? "whatsappNumber" : f === "snooze_until" ? "snoozeUntil" : f === "rate_type" ? "rateType" : f === "rate_note" ? "rateNote" : f === "rate_inclusions" ? "rateInclusions" : f === "occasion_other" ? "occasionOther" : f === "not_interested_reason" ? "notInterestedReason" : f === "is_b2b" ? "isB2b" : f === "thanked_at" ? "thankedAt" : f);
    const attemptedRestricted = leadsOnlyFields.some((f) => req.body[keyFor(f)] !== undefined);
    if (attemptedRestricted) return res.status(403).json({ error: "You don't have permission to update those fields" });
  }

  // Amounts are Accounts-only: a manager can't set or change anything financial.
  if (!canSeeMoney(req.user) && ["quoteAmount", "finalAmount", "advance", "advanceDate", "rateType"].some((k) => req.body[k] !== undefined)) {
    return res.status(403).json({ error: "Amounts can only be changed with Accounts access" });
  }
  if (req.body.advanceDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (req.body.advanceDate > today) return res.status(400).json({ error: "Advance received date can't be in the future" });
  }

  if (req.body.snoozeUntil) {
    const today = new Date().toISOString().slice(0, 10);
    if (req.body.snoozeUntil <= today) return res.status(400).json({ error: "Snooze date must be a real future date, not today or earlier" });
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
    const key = f === "assigned_to" ? "assignedTo" : f === "quote_amount" ? "quoteAmount" : f === "final_amount" ? "finalAmount" : f === "advance_date" ? "advanceDate" : f === "event_time" ? "eventTime" : f === "soundcheck_time" ? "soundcheckTime" : f === "event_type" ? "eventType" : f === "guest_range" ? "guestRange" : f === "whatsapp_number" ? "whatsappNumber" : f === "snooze_until" ? "snoozeUntil" : f === "rate_type" ? "rateType" : f === "rate_note" ? "rateNote" : f === "rate_inclusions" ? "rateInclusions" : f === "occasion_other" ? "occasionOther" : f === "not_interested_reason" ? "notInterestedReason" : f === "is_b2b" ? "isB2b" : f === "thanked_at" ? "thankedAt" : f;
    if (req.body[key] !== undefined) {
      values.push(f === "is_b2b" ? (req.body[key] ? 1 : 0) : req.body[key]);
      updates.push(`${f} = $${values.length}`);
    }
  });
  // logFollowup is a trigger, not a raw field — the timestamp is always set
  // server-side (never trust a client-supplied clock) so "last followed up"
  // stays accurate regardless of who's clicking it or from where.
  let autoMovedToNotInterested = false;
  let autoMovedThreshold = 3;
  if (hasLeads && req.body.logFollowup === true) {
    values.push(new Date().toISOString());
    updates.push(`last_followup_at = $${values.length}`);
    const newFollowupCount = (lead.followup_count || 0) + 1;
    values.push(newFollowupCount);
    updates.push(`followup_count = $${values.length}`);
    // After N follow-ups with no reply, and only while the lead is still
    // sitting at New/Follow-up (i.e. never actually engaged), auto-close it
    // out as Not Interested so it stops cluttering the active pipeline.
    // Deliberately does NOT apply once a lead has progressed further
    // (Interested/Tentative etc.) — "we'll let you know" leads are still
    // warm and shouldn't get auto-declined just for going quiet a while.
    // Both the on/off switch and N are admin-togglable from Settings
    // (on, N=3 by default, matching prior hardcoded behavior).
    const [autoCloseSetting, autoCloseThresholdSetting] = await Promise.all([
      pool.query("SELECT template FROM message_templates WHERE key = 'auto_close_after_followups'"),
      pool.query("SELECT template FROM message_templates WHERE key = 'auto_close_followup_threshold'"),
    ]);
    const autoCloseEnabled = autoCloseSetting.rows[0] ? autoCloseSetting.rows[0].template === "true" : true;
    const parsedThreshold = parseInt(autoCloseThresholdSetting.rows[0]?.template, 10);
    const autoCloseThreshold = Number.isInteger(parsedThreshold) && parsedThreshold > 0 ? parsedThreshold : 3;
    if (autoCloseEnabled && newFollowupCount >= autoCloseThreshold && req.body.stage === undefined && ["New", "Follow-up"].includes(lead.stage)) {
      autoMovedToNotInterested = true;
      autoMovedThreshold = autoCloseThreshold;
      values.push("Not Interested");
      updates.push(`stage = $${values.length}`);
      const autoNote = `[Auto] Moved to Not Interested — ${autoCloseThreshold} follow-up${autoCloseThreshold === 1 ? "" : "s"} sent with no response (as of ${new Date().toISOString().slice(0, 10)}).`;
      values.push(lead.notes ? `${autoNote}\n${lead.notes}` : autoNote);
      updates.push(`notes = $${values.length}`);
      if (!lead.not_interested_reason) {
        values.push("No response after follow-ups");
        updates.push(`not_interested_reason = $${values.length}`);
      }
    }
  }
  // Any deliberate stage change is a fresh read on the lead, so restart the
  // no-response counter — it shouldn't carry over from a previous phase.
  if (req.body.stage !== undefined && req.body.stage !== lead.stage) {
    values.push(0);
    updates.push(`followup_count = $${values.length}`);
  }
  if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });

  values.push(req.params.id);
  await pool.query(`UPDATE leads SET ${updates.join(", ")} WHERE id = $${values.length}`, values);

  // Retroactively marking a past lead as B2B (e.g. from Edit lead) should
  // bring them into the B2B directory too, same as a fresh Event Manager
  // submission does — using whatever name/phone/city the lead already has,
  // since there's no separate manager-only form filled out for this path.
  if (req.body.isB2b === true && !lead.is_b2b) {
    const effectivePhone = req.body.phone !== undefined ? req.body.phone : lead.phone;
    const effectiveName = req.body.name !== undefined ? req.body.name : lead.name;
    const effectiveCity = req.body.city !== undefined ? req.body.city : lead.city;
    upsertB2bContact({ name: effectiveName, phone: effectivePhone, city: effectiveCity });
  }

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

  const updatedLead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  res.json(hasLeads ? stripLeadMoney(updatedLead, req.user) : restrictedLeadView(updatedLead));
  syncLeadToGoogleCalendar(updatedLead).catch((err) => console.error("Google Calendar sync error:", err.message));
  checkTeamComplete(updatedLead.id); // a lead that just became Confirmed with everyone already accepted is "complete"

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
  } else if (autoMovedToNotInterested) {
    logActivity(req, `${lead.name}: ${lead.stage} → Not Interested (auto — ${autoMovedThreshold} follow-up${autoMovedThreshold === 1 ? "" : "s"}, no response)`, lead.id);
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
app.post("/api/leads/:id/quote", requireAuth, requireAnySection(["leads", "quotation"]), requireMoneyAccess, async (req, res) => {
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const { amount, subject, body, pcs, duration, eventType } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Quote text is required" });

  const numericAmount = amount !== undefined && amount !== null && amount !== "" ? Number(amount) : null;
  const finalSubject = subject && subject.trim() ? subject : "Quotation — Together, Out Loud";
  // A lead can be re-quoted for a different package than it originally came
  // in for (e.g. Bhajan Jamming, then later Musical Pheras) — when that
  // happens, the lead's own event_type is updated to match the latest ask,
  // while the quote record keeps its own event_type so quote history still
  // shows what each past quote was actually for.
  const quoteEventType = eventType || lead.event_type;

  const newStage = (lead.stage === "New") ? "Follow-up" : lead.stage;
  await pool.query(
    "UPDATE leads SET quote_amount = $1, stage = $2, pcs = COALESCE($3, pcs), duration = COALESCE($4, duration), event_type = COALESCE($5, event_type) WHERE id = $6",
    [numericAmount, newStage, pcs || null, duration || null, eventType || null, lead.id]
  );
  await pool.query(`
    INSERT INTO quotes (id, lead_id, subject, body, amount, event_type, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [uuid(), lead.id, finalSubject, body, numericAmount, quoteEventType, new Date().toISOString()]);

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
app.get("/api/quotes", requireAuth, requireAnySection(["leads", "quotation"]), requireMoneyAccess, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT quotes.*, leads.name AS lead_name, leads.phone AS lead_phone, leads.email AS lead_email
    FROM quotes JOIN leads ON leads.id = quotes.lead_id
    ORDER BY quotes.created_at DESC
  `);
  res.json(rows);
});

// Tracks a quote through to accepted/rejected instead of leaving it as just
// "sent" forever — purely informational, doesn't touch the lead's stage.
// Also lets a quote sent by mistake (wrong amount, typo, etc.) be corrected
// in place rather than living on in the history forever.
app.patch("/api/quotes/:id", requireAuth, requireAnySection(["leads", "quotation"]), requireMoneyAccess, async (req, res) => {
  const { status, amount, subject, body } = req.body;
  const updates = [];
  const values = [];
  if (status !== undefined) {
    if (!["sent", "accepted", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    values.push(status);
    updates.push(`status = $${values.length}`);
  }
  if (amount !== undefined) {
    values.push(amount || null);
    updates.push(`amount = $${values.length}`);
  }
  if (subject !== undefined) {
    values.push(subject || null);
    updates.push(`subject = $${values.length}`);
  }
  if (body !== undefined) {
    if (!body.trim()) return res.status(400).json({ error: "Quote text can't be empty" });
    values.push(body);
    updates.push(`body = $${values.length}`);
  }
  if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });
  values.push(req.params.id);
  const { rows } = await pool.query(`UPDATE quotes SET ${updates.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
  if (!rows[0]) return res.status(404).json({ error: "Quote not found" });
  res.json(rows[0]);
});

// Removes a quote sent by mistake (duplicate send, wrong lead, testing) —
// doesn't touch the lead itself, just its quote history.
app.delete("/api/quotes/:id", requireAuth, requireAnySection(["leads", "quotation"]), requireMoneyAccess, async (req, res) => {
  const { rows } = await pool.query("DELETE FROM quotes WHERE id = $1 RETURNING id", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Quote not found" });
  res.status(204).end();
});

// ---------- Event assignments (staffing a Confirmed event) ----------
// Admin picks which team members are performing; each gets a pending
// invitation they accept/decline from their own simplified view.
app.get("/api/leads/:id/assignments", requireAuth, requireCapability("assign_team"), async (req, res) => {
  if (!(await leadInManagerScope(req.user, req.params.id))) return scopeDeny(res);
  const { rows } = await pool.query(`
    SELECT event_assignments.*, team.name AS team_name, team.base_city AS team_base_city
    FROM event_assignments JOIN team ON team.id = event_assignments.team_id
    WHERE lead_id = $1
    ORDER BY event_assignments.created_at ASC
  `, [req.params.id]);
  const canSeeMoney = userHasSection(req.user, "accounts");
  res.json(canSeeMoney ? rows : rows.map(({ fee_amount, ...rest }) => rest));
});

app.post("/api/leads/:id/assignments", requireAuth, requireCapability("assign_team"), async (req, res) => {
  if (!(await leadInManagerScope(req.user, req.params.id))) return scopeDeny(res);
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const { teamIds = [] } = req.body;
  const existing = (await pool.query("SELECT team_id FROM event_assignments WHERE lead_id = $1", [req.params.id])).rows.map((r) => r.team_id);
  const now = new Date().toISOString();
  const newlyAdded = teamIds.filter((id) => !existing.includes(id));
  for (const teamId of newlyAdded) {
    await pool.query(`
      INSERT INTO event_assignments (id, lead_id, team_id, status, paid, created_at, confirm_token)
      VALUES ($1, $2, $3, 'pending', 0, $4, $5)
    `, [uuid(), req.params.id, teamId, now, uuid()]);
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
  await checkTeamComplete(req.params.id);
  if (newlyAdded.length > 0) {
    const names = rows.filter((r) => newlyAdded.includes(r.team_id)).map((r) => r.team_name).join(", ");
    logActivity(req, `${names} assigned to ${lead.name}`, lead.id);
  }
});

// "Team complete": fires ONE major alert when every member assigned to a Confirmed event has
// accepted (nobody pending, declined or asking to cancel). If the line-up later stops being
// complete (someone added/declines), the flag resets so the alert fires again when it is.
async function checkTeamComplete(leadId) {
  try {
    const lead = (await pool.query("SELECT id, name, date, city, stage, team_complete_notified FROM leads WHERE id = $1", [leadId])).rows[0];
    if (!lead) return;
    const as = [
      ...(await pool.query("SELECT status FROM event_assignments WHERE lead_id = $1", [leadId])).rows,
      ...(await pool.query("SELECT status FROM temp_artists WHERE lead_id = $1 AND migrated_assignment_id IS NULL", [leadId])).rows,
    ];
    const complete = lead.stage === "Confirmed" && as.length > 0 && as.every((a) => a.status === "accepted");
    if (!complete) {
      if (lead.team_complete_notified) await pool.query("UPDATE leads SET team_complete_notified = 0 WHERE id = $1", [leadId]);
      return;
    }
    const won = await pool.query("UPDATE leads SET team_complete_notified = 1 WHERE id = $1 AND team_complete_notified = 0 RETURNING id", [leadId]);
    if (!won.rows.length) return;
    const msg = `\ud83c\udf89 TEAM COMPLETE \u2014 all ${as.length} member${as.length > 1 ? "s have" : " has"} confirmed ${lead.name} on ${lead.date}${lead.city ? ` in ${lead.city}` : ""}.`;
    await pool.query("INSERT INTO admin_notifications (id, message, assignment_id, audience, created_at) VALUES ($1,$2,NULL,'coordination',$3)", [uuid(), msg, new Date().toISOString()]);
    logActivity({ user: null }, `Team complete: everyone confirmed ${lead.name} (${lead.date})`, leadId);
    await sendPushToAll("\ud83c\udf89 Team complete!", `${lead.name} (${lead.date}) \u2014 every member has confirmed.`, "/login", { adminOnly: true });
  } catch (err) { console.error("checkTeamComplete failed (not fatal):", err.message); }
}

app.delete("/api/assignments/:id", requireAuth, requireCapability("assign_team"), async (req, res) => {
  if (!(await assignmentInManagerScope(req.user, req.params.id))) return scopeDeny(res);
  const gone = (await pool.query("DELETE FROM event_assignments WHERE id = $1 RETURNING lead_id", [req.params.id])).rows[0];
  res.status(204).end();
  if (gone) await checkTeamComplete(gone.lead_id);
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
  if (!(await assignmentInManagerScope(req.user, req.params.id))) return scopeDeny(res);
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
  await checkTeamComplete(a.lead_id);
});

// A no-login confirmation link, sent over WhatsApp -- most performers here
// don't have an account, so this is how they see their event details and
// accept/decline straight from their phone. The token is unguessable but
// otherwise unauthenticated, so only event details already meant to go out
// over WhatsApp are exposed here — never the client's phone/email or money.
app.get("/api/public/assignment/:token", async (req, res) => {
  const row = (await pool.query(`
    SELECT event_assignments.status, event_assignments.responded_at, event_assignments.note,
           team.name AS team_name,
           leads.name AS client_name, leads.event_type, leads.city, leads.date,
           leads.venue, leads.event_time, leads.soundcheck_time, leads.pcs
    FROM event_assignments
    JOIN team ON team.id = event_assignments.team_id
    JOIN leads ON leads.id = event_assignments.lead_id
    WHERE event_assignments.confirm_token = $1
  `, [req.params.token])).rows[0];
  let guest = null;
  if (!row) {
    guest = (await pool.query(`
      SELECT temp_artists.status, temp_artists.responded_at, temp_artists.note, temp_artists.name AS team_name,
             leads.name AS client_name, leads.event_type, leads.city, leads.date,
             leads.venue, leads.event_time, leads.soundcheck_time, leads.pcs
      FROM temp_artists JOIN leads ON leads.id = temp_artists.lead_id WHERE temp_artists.confirm_token = $1
    `, [req.params.token])).rows[0];
  }
  if (!row && !guest) return res.status(404).json({ error: "This link isn't valid — check it was copied in full, or ask for a fresh one." });
  const r0 = row || guest;
  res.json({
    teamName: r0.team_name,
    status: r0.status,
    respondedAt: r0.responded_at,
    note: r0.note,
    clientName: r0.client_name,
    experience: packageName(r0.event_type),
    city: r0.city,
    date: r0.date,
    venue: r0.venue,
    eventTime: r0.event_time,
    soundcheckTime: r0.soundcheck_time,
    pcs: r0.pcs,
  });
});

app.post("/api/public/assignment/:token/respond", async (req, res) => {
  const { status, note } = req.body;
  if (!["accepted", "declined"].includes(status)) return res.status(400).json({ error: "status must be 'accepted' or 'declined'" });
  let a = (await pool.query("SELECT * FROM event_assignments WHERE confirm_token = $1", [req.params.token])).rows[0];
  if (!a) {
    const g = (await pool.query("SELECT * FROM temp_artists WHERE confirm_token = $1", [req.params.token])).rows[0];
    if (!g) return res.status(404).json({ error: "This link isn't valid — check it was copied in full, or ask for a fresh one." });
    await pool.query("UPDATE temp_artists SET status = $1, responded_at = $2, note = $3 WHERE id = $4", [status, new Date().toISOString(), note !== undefined ? (note || null) : g.note, g.id]);
    const gl = (await pool.query("SELECT name, date FROM leads WHERE id = $1", [g.lead_id])).rows[0];
    if (gl) {
      logActivity({ user: null }, `${g.name} (guest) ${status} ${gl.name} (${gl.date}) via confirmation link${note ? " with a note" : ""}`, g.lead_id);
      await sendPushToAll(`${status === "accepted" ? "\u2705" : "\u274c"} ${g.name} ${status}`, `${gl.name} (${gl.date})${note ? " \u2014 left a note" : ""}`, "/login", { adminOnly: true });
    }
    res.json({ status, note: note !== undefined ? (note || null) : g.note });
    await checkTeamComplete(g.lead_id);
    return;
  }
  await pool.query("UPDATE event_assignments SET status = $1, responded_at = $2, note = $3 WHERE id = $4", [
    status, new Date().toISOString(), note !== undefined ? (note || null) : a.note, a.id,
  ]);
  const lead = (await pool.query("SELECT name, date FROM leads WHERE id = $1", [a.lead_id])).rows[0];
  const member = (await pool.query("SELECT name FROM team WHERE id = $1", [a.team_id])).rows[0];
  if (lead) {
    logActivity({ user: null }, `${member ? member.name : "An artist"} ${status} ${lead.name} (${lead.date}) via confirmation link${note ? " with a note" : ""}`, a.lead_id);
    // A Dashboard flash only works if someone happens to be looking at the
    // Dashboard tab at that exact moment — a real push notification catches
    // it even when nobody's watching, which is the whole point here.
    const emoji = status === "accepted" ? "✅" : "❌";
    await sendPushToAll(
      `${emoji} ${member ? member.name : "An artist"} ${status}`,
      `${lead.name} (${lead.date})${note ? " — left a note" : ""}`,
      "/login",
      { adminOnly: true }
    );
  }
  res.json({ status, note: note !== undefined ? (note || null) : a.note });
  await checkTeamComplete(a.lead_id);
});

// Lets the artist leave/update their note independently of accept/decline —
// e.g. adding "running late, can arrive by 6" after already accepting.
app.post("/api/public/assignment/:token/note", async (req, res) => {
  const { note } = req.body;
  const a = (await pool.query("SELECT * FROM event_assignments WHERE confirm_token = $1", [req.params.token])).rows[0];
  if (!a) {
    const g = (await pool.query("SELECT id FROM temp_artists WHERE confirm_token = $1", [req.params.token])).rows[0];
    if (!g) return res.status(404).json({ error: "This link isn't valid — check it was copied in full, or ask for a fresh one." });
    await pool.query("UPDATE temp_artists SET note = $1 WHERE id = $2", [(note || "").trim() || null, g.id]);
    return res.json({ note: (note || "").trim() || null });
  }
  await pool.query("UPDATE event_assignments SET note = $1 WHERE id = $2", [(note || "").trim() || null, a.id]);
  res.json({ note: (note || "").trim() || null });
});

// ---------- Client feedback (no-login form linked from the thank-you message) ----------
// Google Business Profile reviews are on hold for now, so feedback is
// collected directly into the CRM instead and surfaced on the website via
// the existing testimonials block (an admin picks which ones to feature).

// Generates the lead's feedback token on first use, same lazy pattern as
// event_assignments' confirm_token.
app.post("/api/leads/:id/feedback-link", requireAuth, async (req, res) => {
  const lead = (await pool.query("SELECT id, feedback_token FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  let token = lead.feedback_token;
  if (!token) {
    token = uuid();
    await pool.query("UPDATE leads SET feedback_token = $1 WHERE id = $2", [token, lead.id]);
  }
  res.json({ token });
});

app.get("/api/public/feedback/:token", async (req, res) => {
  const lead = (await pool.query(
    "SELECT id, name, event_type, date, city FROM leads WHERE feedback_token = $1",
    [req.params.token]
  )).rows[0];
  if (!lead) return res.status(404).json({ error: "This link isn't valid — check it was copied in full, or ask for a fresh one." });
  const existing = (await pool.query("SELECT rating, message FROM feedback WHERE lead_id = $1", [lead.id])).rows[0];
  res.json({
    clientName: lead.name,
    experience: packageName(lead.event_type),
    date: lead.date,
    city: lead.city,
    rating: existing ? existing.rating : null,
    message: existing ? existing.message : null,
  });
});

app.post("/api/public/feedback/:token", async (req, res) => {
  const { rating, message } = req.body;
  const parsedRating = parseInt(rating, 10);
  if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
    return res.status(400).json({ error: "Please pick a star rating from 1 to 5." });
  }
  const lead = (await pool.query("SELECT id, name FROM leads WHERE feedback_token = $1", [req.params.token])).rows[0];
  if (!lead) return res.status(404).json({ error: "This link isn't valid — check it was copied in full, or ask for a fresh one." });
  const existing = (await pool.query("SELECT id FROM feedback WHERE lead_id = $1", [lead.id])).rows[0];
  if (existing) {
    await pool.query("UPDATE feedback SET rating = $1, message = $2 WHERE id = $3", [parsedRating, (message || "").trim() || null, existing.id]);
  } else {
    await pool.query(
      "INSERT INTO feedback (id, lead_id, rating, message, created_at) VALUES ($1, $2, $3, $4, $5)",
      [uuid(), lead.id, parsedRating, (message || "").trim() || null, new Date().toISOString()]
    );
  }
  logActivity({ user: null }, `${lead.name} left feedback (${parsedRating}★)`, lead.id);
  res.json({ ok: true });
});

// Admin — review submissions and pick which ones to feature as testimonials.
app.get("/api/feedback", requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT feedback.*, leads.name AS client_name, leads.event_type, leads.date, leads.city
    FROM feedback
    JOIN leads ON leads.id = feedback.lead_id
    ORDER BY feedback.created_at DESC
  `);
  res.json(rows.map((r) => ({
    id: r.id,
    leadId: r.lead_id,
    clientName: r.client_name,
    experience: packageName(r.event_type),
    date: r.date,
    city: r.city,
    rating: r.rating,
    message: r.message,
    createdAt: r.created_at,
    addedToTestimonials: !!r.added_to_testimonials,
  })));
});

// Folds a feedback submission straight into the existing admin-curated
// testimonials list that the public site already renders — kept a manual,
// one-click step rather than fully automatic so nothing unflattering or
// spammy ends up on the website unreviewed.
app.post("/api/feedback/:id/add-to-testimonials", requireAuth, requireAdmin, async (req, res) => {
  const fb = (await pool.query(`
    SELECT feedback.*, leads.name AS client_name, leads.occasion, leads.occasion_other, leads.event_type, leads.city
    FROM feedback JOIN leads ON leads.id = feedback.lead_id
    WHERE feedback.id = $1
  `, [req.params.id])).rows[0];
  if (!fb) return res.status(404).json({ error: "Feedback not found" });
  if (!fb.message) return res.status(400).json({ error: "This feedback has no written note — there's nothing to show as a quote." });
  const row = (await pool.query("SELECT value FROM site_content WHERE key = 'testimonials'")).rows[0];
  const testimonials = row ? row.value : [];
  // Never put the client's actual name in public testimonials -- the
  // occasion (and city, if known) is what makes it feel specific instead.
  const occasionLabel = fb.occasion === "Other" ? (fb.occasion_other || packageName(fb.event_type)) : (fb.occasion || packageName(fb.event_type));
  const label = `${occasionLabel}${fb.city ? `, ${fb.city}` : ""}`;
  testimonials.push({ name: label, quote: fb.message, videoUrl: "", rating: fb.rating || undefined });
  await pool.query(`
    INSERT INTO site_content (key, value, updated_at) VALUES ('testimonials', $1, $2)
    ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = $2
  `, [JSON.stringify(testimonials), new Date().toISOString()]);
  await pool.query("UPDATE feedback SET added_to_testimonials = 1 WHERE id = $1", [fb.id]);
  res.json({ ok: true });
});

app.delete("/api/feedback/:id", requireAuth, requireAdmin, async (req, res) => {
  const fb = (await pool.query("SELECT * FROM feedback WHERE id = $1", [req.params.id])).rows[0];
  // If this one was already featured on the website, pull it back out of the
  // testimonials list too -- deleting feedback shouldn't leave a stale copy
  // live on the public site.
  if (fb && fb.added_to_testimonials) {
    const row = (await pool.query("SELECT value FROM site_content WHERE key = 'testimonials'")).rows[0];
    if (row && Array.isArray(row.value)) {
      const testimonials = row.value.filter((t) => t.quote !== fb.message);
      await pool.query(
        "UPDATE site_content SET value = $1, updated_at = $2 WHERE key = 'testimonials'",
        [JSON.stringify(testimonials), new Date().toISOString()]
      );
    }
  }
  await pool.query("DELETE FROM feedback WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// ---------- Travel legs (per-artist travel plan for outstation events) ----------
const TRAVEL_MODE_LABELS = { flight: "Flight", train: "Train", bus: "Bus", car: "Car", self: "Self-arranged" };
const TRAVEL_STATUS_LABELS = { not_booked: "Not booked yet", booked: "Booked", self_arranged: "Self-arranged" };

async function canViewTravelLegs(user, leadId) {
  if (userHasSection(user, "assign_team") || user.access_level === "admin") return true;
  if (!user.team_id) return false;
  const a = (await pool.query("SELECT 1 FROM event_assignments WHERE lead_id = $1 AND team_id = $2", [leadId, user.team_id])).rows[0];
  return !!a;
}

// Admins' own travel stays private from managers/staff: legs that only involve admins
// are hidden, and admins are dropped from the traveller list of mixed legs.
async function hideAdminTravel(user, legsOut) {
  if (user.access_level === "admin") return legsOut;
  const adminTeamIds = new Set((await pool.query("SELECT team_id FROM users WHERE access_level = 'admin' AND team_id IS NOT NULL")).rows.map((r) => r.team_id));
  if (adminTeamIds.size === 0) return legsOut;
  return legsOut
    .filter((l) => !(l.members.length > 0 && l.members.every((m) => adminTeamIds.has(m.teamId))))
    .map((l) => ({ ...l, members: l.members.filter((m) => !adminTeamIds.has(m.teamId)) }));
}

async function legIsAdminOnly(user, legId) {
  if (user.access_level === "admin") return false;
  const m = (await pool.query("SELECT team_id FROM travel_leg_members WHERE leg_id = $1", [legId])).rows;
  if (m.length === 0) return false;
  const admins = new Set((await pool.query("SELECT team_id FROM users WHERE access_level = 'admin' AND team_id IS NOT NULL")).rows.map((r) => r.team_id));
  return m.every((x) => admins.has(x.team_id));
}
app.get("/api/leads/:id/travel-legs", requireAuth, async (req, res) => {
  if (!(await canViewTravelLegs(req.user, req.params.id))) return res.status(403).json({ error: "Not available for this event" });
  const { rows: legs } = await pool.query(`SELECT * FROM travel_legs WHERE lead_id = $1 ORDER BY created_at ASC`, [req.params.id]);
  const legIds = legs.map((l) => l.id);
  const [members, tickets] = legIds.length > 0 ? await Promise.all([
    pool.query(`SELECT travel_leg_members.leg_id, team.id AS team_id, team.name AS team_name FROM travel_leg_members JOIN team ON team.id = travel_leg_members.team_id WHERE leg_id = ANY($1)`, [legIds]),
    pool.query(`SELECT ${DOC_LIST_COLUMNS} FROM documents WHERE travel_leg_id = ANY($1) ORDER BY uploaded_at ASC`, [legIds]),
  ]) : [{ rows: [] }, { rows: [] }];
  res.json(await hideAdminTravel(req.user, legs.map((leg) => ({
    ...legForUser(leg, req.user),
    members: members.rows.filter((m) => m.leg_id === leg.id).map((m) => ({ teamId: m.team_id, name: m.team_name })),
    tickets: tickets.rows.filter((t) => t.travel_leg_id === leg.id).map((t) => ({ ...t, url: `/api/documents/${t.id}/file` })),
  }))));
});

// Every travel leg across every event, plus any standalone (no lead) entries
// logged directly — this is what the standalone Travel Calendar reads from,
// so a client-linked trip and a manually-logged one show up side by side.
// One call for the Travel Calendar: who is allotted to which event, plus every date each
// artist is already committed (events and travel) so clashes show while planning. Scoped managers
// only get names for their own events — other events appear as just "another event".
app.get("/api/travel-context", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const scope = isScopedManager(req.user) ? await assignedLeadIdSet(req.user) : null;
  const inScope = (leadId) => !scope || scope.has(leadId);
  const asg = (await pool.query(`
    SELECT ea.id, ea.lead_id, ea.team_id, ea.status, l.name AS lead_name, l.date, l.stage
    FROM event_assignments ea JOIN leads l ON l.id = ea.lead_id
    WHERE l.stage IN ('Confirmed', 'Completed')
  `)).rows;
  const assignments = asg.filter((a) => inScope(a.lead_id)).map((a) => ({ id: a.id, lead_id: a.lead_id, team_id: a.team_id, status: a.status }));
  const busy = [];
  asg.filter((a) => a.status !== "declined" && a.date).forEach((a) => busy.push({
    teamId: a.team_id, from: a.date, to: a.date, kind: "event", leadId: a.lead_id,
    label: inScope(a.lead_id) ? a.lead_name : "another event",
  }));
  const legs = (await pool.query(`
    SELECT tl.id, tl.lead_id, tl.departure_at, tl.arrival_at, tl.from_city, tl.to_city, l.name AS lead_name
    FROM travel_legs tl LEFT JOIN leads l ON l.id = tl.lead_id WHERE tl.departure_at IS NOT NULL AND tl.departure_at <> ''
  `)).rows;
  const mem = legs.length ? (await pool.query("SELECT leg_id, team_id FROM travel_leg_members WHERE leg_id = ANY($1)", [legs.map((l) => l.id)])).rows : [];
  const shaped = await hideAdminTravel(req.user, legs.map((l) => ({ ...l, members: mem.filter((m) => m.leg_id === l.id).map((m) => ({ teamId: m.team_id })) })));
  shaped.forEach((l) => l.members.forEach((m) => busy.push({
    teamId: m.teamId, from: l.departure_at.slice(0, 10), to: (l.arrival_at || l.departure_at).slice(0, 10), kind: "travel", leadId: l.lead_id,
    label: l.lead_id && inScope(l.lead_id) ? `${l.from_city || "?"} → ${l.to_city || "?"} (${l.lead_name || "travel"})` : "travelling",
  })));
  res.json({ assignments, busy });
});


app.get("/api/travel-legs", requireAuth, requireCapability("assign_team"), async (req, res) => {
  let { rows: legs } = await pool.query(`
    SELECT travel_legs.*, leads.name AS lead_name, leads.city AS lead_city
    FROM travel_legs
    LEFT JOIN leads ON leads.id = travel_legs.lead_id
    ORDER BY travel_legs.departure_at ASC NULLS LAST, travel_legs.created_at ASC
  `);
  if (isScopedManager(req.user)) { const ids = await assignedLeadIdSet(req.user); legs = legs.filter((l) => l.lead_id && ids && ids.has(l.lead_id)); }
  const legIds = legs.map((l) => l.id);
  const [members, tickets] = legIds.length > 0 ? await Promise.all([
    pool.query(`SELECT travel_leg_members.leg_id, team.id AS team_id, team.name AS team_name FROM travel_leg_members JOIN team ON team.id = travel_leg_members.team_id WHERE leg_id = ANY($1)`, [legIds]),
    pool.query(`SELECT ${DOC_LIST_COLUMNS} FROM documents WHERE travel_leg_id = ANY($1) ORDER BY uploaded_at ASC`, [legIds]),
  ]) : [{ rows: [] }, { rows: [] }];
  res.json(await hideAdminTravel(req.user, legs.map((leg) => ({
    ...legForUser(leg, req.user),
    members: members.rows.filter((m) => m.leg_id === leg.id).map((m) => ({ teamId: m.team_id, name: m.team_name })),
    tickets: tickets.rows.filter((t) => t.travel_leg_id === leg.id).map((t) => ({ ...t, url: `/api/documents/${t.id}/file` })),
  }))));
});

// Same person, same sector (from -> to), same event = a duplicate travel plan.
async function sectorDuplicateNames({ leadId, fromCity, toCity, departureAt, teamIds, excludeLegId }) {
  const norm = (v) => String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
  const f = norm(fromCity), t = norm(toCity);
  if (!f || !t || !Array.isArray(teamIds) || teamIds.length === 0) return [];
  const { rows } = await pool.query(`
    SELECT travel_legs.id, travel_legs.from_city, travel_legs.to_city, travel_legs.departure_at, travel_leg_members.team_id, team.name
    FROM travel_legs
    JOIN travel_leg_members ON travel_leg_members.leg_id = travel_legs.id
    JOIN team ON team.id = travel_leg_members.team_id
    WHERE travel_leg_members.team_id = ANY($1) AND ($2::text IS NULL OR travel_legs.id <> $2)
      AND ${leadId ? "travel_legs.lead_id = $3" : "travel_legs.lead_id IS NULL AND LEFT(COALESCE(travel_legs.departure_at, ''), 10) = $3"}
  `, [teamIds, excludeLegId || null, leadId || String(departureAt || "").slice(0, 10)]);
  return [...new Set(rows.filter((r) => norm(r.from_city) === f && norm(r.to_city) === t).map((r) => r.name))];
}
function dupTravelMessage(names, fromCity, toCity) {
  return `${names.join(", ")} already ${names.length > 1 ? "have" : "has"} a travel plan for ${String(fromCity).trim()} \u2192 ${String(toCity).trim()} on this event. Edit that one instead of creating a duplicate.`;
}

app.post("/api/travel-legs", requireAuth, requireCapability("assign_team"), async (req, res) => {
  const { leadId, label, teamIds, mode, fromCity, toCity, departureAt, arrivalAt, bookingRef, status } = req.body;
  const notes = req.user.access_level === "admin" ? req.body.notes : null;
  const managerNotes = req.body.managerNotes || null;
  if (!label || !label.trim()) return res.status(400).json({ error: "A label is required for manually-logged travel" });
  let linkLeadId = null;
  if (leadId) {
    if (!(await pool.query("SELECT 1 FROM leads WHERE id = $1", [leadId])).rows[0]) return res.status(404).json({ error: "Event not found" });
    linkLeadId = leadId;
  }
  { const dups = await sectorDuplicateNames({ leadId: linkLeadId, fromCity, toCity, departureAt, teamIds }); if (dups.length) return res.status(400).json({ error: dupTravelMessage(dups, fromCity, toCity) }); }
  const id = uuid();
  const now = new Date().toISOString();
  await pool.query(`
    INSERT INTO travel_legs (id, lead_id, label, mode, from_city, to_city, departure_at, arrival_at, booking_ref, status, notes, manager_notes, created_at, updated_at)
    VALUES ($1, $13, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
  `, [id, label.trim(), mode || null, fromCity || null, toCity || null, departureAt || null, arrivalAt || null, bookingRef || null, status || "not_booked", notes || null, managerNotes, now, linkLeadId]);
  for (const teamId of (Array.isArray(teamIds) ? teamIds : [])) {
    await pool.query(`INSERT INTO travel_leg_members (id, leg_id, team_id) VALUES ($1, $2, $3)`, [uuid(), id, teamId]);
  }
  logActivity(req, `Travel logged manually: ${label.trim()}`, linkLeadId);
  res.status(201).json({ id });
});

app.post("/api/leads/:id/travel-legs", requireAuth, requireCapability("assign_team"), async (req, res) => {
  if (!(await leadInManagerScope(req.user, req.params.id))) return scopeDeny(res);
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Event not found" });
  const { teamIds, mode, fromCity, toCity, departureAt, arrivalAt, bookingRef, status } = req.body;
  const notes = req.user.access_level === "admin" ? req.body.notes : null;
  const managerNotes = req.body.managerNotes || null;
  if (!Array.isArray(teamIds) || teamIds.length === 0) return res.status(400).json({ error: "Select at least one artist" });
  { const fc = fromCity, tc = toCity || lead.city; const dups = await sectorDuplicateNames({ leadId: req.params.id, fromCity: fc, toCity: tc, teamIds }); if (dups.length) return res.status(400).json({ error: dupTravelMessage(dups, fc, tc) }); }
  const id = uuid();
  const now = new Date().toISOString();
  await pool.query(`
    INSERT INTO travel_legs (id, lead_id, mode, from_city, to_city, departure_at, arrival_at, booking_ref, status, notes, manager_notes, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
  `, [id, req.params.id, mode || null, fromCity || null, toCity || lead.city || null, departureAt || null, arrivalAt || null, bookingRef || null, status || "not_booked", notes || null, managerNotes, now]);
  for (const teamId of teamIds) {
    await pool.query(`INSERT INTO travel_leg_members (id, leg_id, team_id) VALUES ($1, $2, $3)`, [uuid(), id, teamId]);
  }
  const members = (await pool.query(`SELECT name FROM team WHERE id = ANY($1)`, [teamIds])).rows;
  res.status(201).json({ id });
  if (members.length > 0) {
    logActivity(req, `Travel added for ${members.map((m) => m.name).join(", ")}: ${lead.name} (${lead.date})`, lead.id);
    for (const teamId of teamIds) {
      await pool.query(`
        INSERT INTO notifications (id, team_id, message, created_at)
        VALUES ($1, $2, $3, $4)
      `, [uuid(), teamId, `Your travel details for ${lead.name} on ${lead.date}${lead.city ? ` in ${lead.city}` : ""} have been added — check My Events.`, now]).catch(() => {});
    }
  }
});

app.patch("/api/travel-legs/:id", requireAuth, requireCapability("assign_team"), async (req, res) => {
  if (isScopedManager(req.user)) { const lg = (await pool.query("SELECT lead_id FROM travel_legs WHERE id = $1", [req.params.id])).rows[0]; if (lg && !(await leadInManagerScope(req.user, lg.lead_id))) return scopeDeny(res); }
  const leg = (await pool.query("SELECT * FROM travel_legs WHERE id = $1", [req.params.id])).rows[0];
  if (!leg) return res.status(404).json({ error: "Travel leg not found" });
  if (await legIsAdminOnly(req.user, req.params.id)) return res.status(403).json({ error: "Not available" });
  {
    const curMembers = (await pool.query("SELECT team_id FROM travel_leg_members WHERE leg_id = $1", [req.params.id])).rows.map((r) => r.team_id);
    const fc = req.body.fromCity !== undefined ? req.body.fromCity : leg.from_city;
    const tc = req.body.toCity !== undefined ? req.body.toCity : leg.to_city;
    const lid = req.body.leadId !== undefined ? req.body.leadId : leg.lead_id;
    const dups = await sectorDuplicateNames({ leadId: lid || null, fromCity: fc, toCity: tc, departureAt: req.body.departureAt !== undefined ? req.body.departureAt : leg.departure_at, teamIds: Array.isArray(req.body.teamIds) ? req.body.teamIds : curMembers, excludeLegId: req.params.id });
    if (dups.length) return res.status(400).json({ error: dupTravelMessage(dups, fc, tc) });
  }
  const fields = ["mode", "from_city", "to_city", "departure_at", "arrival_at", "booking_ref", "status", "notes", "manager_notes", "label", "lead_id"];
  const keyFor = (f) => (f === "manager_notes" ? "managerNotes" : f === "from_city" ? "fromCity" : f === "to_city" ? "toCity" : f === "departure_at" ? "departureAt" : f === "arrival_at" ? "arrivalAt" : f === "booking_ref" ? "bookingRef" : f === "lead_id" ? "leadId" : f);
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    if (f === "notes" && req.user.access_level !== "admin") return; // admin-only remarks
    const key = keyFor(f);
    if (req.body[key] !== undefined) { values.push(req.body[key]); updates.push(`${f} = $${values.length}`); }
  });
  if (updates.length > 0) {
    values.push(new Date().toISOString());
    updates.push(`updated_at = $${values.length}`);
    values.push(req.params.id);
    await pool.query(`UPDATE travel_legs SET ${updates.join(", ")} WHERE id = $${values.length}`, values);
  }

  // Membership is replaced wholesale when teamIds is given, rather than
  // diffed field-by-field — simpler, and the modal always sends the full
  // ticked set anyway.
  let newlyAdded = [];
  if (Array.isArray(req.body.teamIds)) {
    const before = (await pool.query("SELECT team_id FROM travel_leg_members WHERE leg_id = $1", [req.params.id])).rows.map((r) => r.team_id);
    newlyAdded = req.body.teamIds.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !req.body.teamIds.includes(id));
    for (const teamId of newlyAdded) {
      await pool.query(`INSERT INTO travel_leg_members (id, leg_id, team_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [uuid(), req.params.id, teamId]);
    }
    if (removed.length > 0) {
      await pool.query(`DELETE FROM travel_leg_members WHERE leg_id = $1 AND team_id = ANY($2)`, [req.params.id, removed]);
    }
  }

  res.json(legForUser((await pool.query("SELECT * FROM travel_legs WHERE id = $1", [req.params.id])).rows[0], req.user));

  const lead = (await pool.query("SELECT name, date, city FROM leads WHERE id = $1", [leg.lead_id])).rows[0];
  if (!lead) return;
  const now = new Date().toISOString();
  if (req.body.status !== undefined && req.body.status !== leg.status) {
    const allMembers = (await pool.query("SELECT team_id FROM travel_leg_members WHERE leg_id = $1", [req.params.id])).rows;
    for (const m of allMembers) {
      await pool.query(`
        INSERT INTO notifications (id, team_id, message, created_at)
        VALUES ($1, $2, $3, $4)
      `, [uuid(), m.team_id, `Travel update for ${lead.name} on ${lead.date}: now "${TRAVEL_STATUS_LABELS[req.body.status] || req.body.status}".`, now]).catch(() => {});
    }
  }
  for (const teamId of newlyAdded) {
    await pool.query(`
      INSERT INTO notifications (id, team_id, message, created_at)
      VALUES ($1, $2, $3, $4)
    `, [uuid(), teamId, `Your travel details for ${lead.name} on ${lead.date}${lead.city ? ` in ${lead.city}` : ""} have been added — check My Events.`, now]).catch(() => {});
  }
});

app.delete("/api/travel-legs/:id", requireAuth, requireCapability("assign_team"), async (req, res) => {
  if (isScopedManager(req.user)) { const lg = (await pool.query("SELECT lead_id FROM travel_legs WHERE id = $1", [req.params.id])).rows[0]; if (lg && !(await leadInManagerScope(req.user, lg.lead_id))) return scopeDeny(res); }
  await pool.query("DELETE FROM travel_legs WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

app.post("/api/travel-legs/:id/tickets", requireAuth, requireCapability("assign_team"), upload.single("file"), async (req, res) => {
  if (isScopedManager(req.user)) { const lg = (await pool.query("SELECT lead_id FROM travel_legs WHERE id = $1", [req.params.id])).rows[0]; if (lg && !(await leadInManagerScope(req.user, lg.lead_id))) return scopeDeny(res); }
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const leg = (await pool.query("SELECT * FROM travel_legs WHERE id = $1", [req.params.id])).rows[0];
  if (!leg) return res.status(404).json({ error: "Travel leg not found" });
  const id = uuid();
  await pool.query(`
    INSERT INTO documents (id, lead_id, travel_leg_id, original_name, notes, uploaded_at, mime_type, file_data)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [id, leg.lead_id, leg.id, req.file.originalname, req.body.notes || null, new Date().toISOString(), req.file.mimetype, req.file.buffer]);
  const doc = (await pool.query(`SELECT ${DOC_LIST_COLUMNS} FROM documents WHERE id = $1`, [id])).rows[0];
  res.status(201).json({ ...doc, url: `/api/documents/${doc.id}/file` });
});

// ---------- Temporary artists — one-off performers hired for a single event, not part of the permanent team ----------
// Their fee (if given) lives as a row in the same `expenses` table used everywhere
// else in Accounts, linked via temp_artists.expense_id — so it automatically counts
// toward that event's expenses/profit and shows up in Pending expenses / Recent
// transactions, without a second, separate accounting path to keep in sync.
app.get("/api/leads/:id/temp-artists", requireAuth, requireCapability("assign_team"), async (req, res) => {
  if (!(await leadInManagerScope(req.user, req.params.id))) return scopeDeny(res);
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
  if (!(await leadInManagerScope(req.user, req.params.id))) return scopeDeny(res);
  const lead = (await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const { name, description, phone, baseCity, feeAmount } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });
  let musicianId = null;
  if (req.body.musicianId) {
    const mu = (await pool.query("SELECT id FROM musicians WHERE id = $1", [req.body.musicianId])).rows[0];
    if (!mu) return res.status(404).json({ error: "Musician not found" });
    const dup = (await pool.query("SELECT 1 FROM temp_artists WHERE lead_id = $1 AND musician_id = $2", [req.params.id, mu.id])).rows[0];
    if (dup) return res.status(400).json({ error: "Already added to this event" });
    musicianId = mu.id;
  }
  const isAdmin = req.user.access_level === "admin";
  if (!isAdmin && feeAmount !== undefined && feeAmount !== null && feeAmount !== "") {
    return res.status(403).json({ error: "Only an admin can set artist fees" });
  }
  // Guests live in the Musicians database: reuse a matching musician (same phone or name) or create one.
  if (!musicianId) {
    const last10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);
    const all = (await pool.query("SELECT id, name, phone FROM musicians")).rows;
    const hit = all.find((m) => last10(phone).length === 10 && last10(m.phone) === last10(phone)) || all.find((m) => m.name.trim().toLowerCase() === String(name).trim().toLowerCase());
    if (hit) musicianId = hit.id;
    else {
      musicianId = uuid();
      await pool.query("INSERT INTO musicians (id, name, phone, city, notes, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [musicianId, String(name).trim(), phone || null, baseCity || null, description || null, new Date().toISOString()]);
    }
    const dup2 = (await pool.query("SELECT 1 FROM temp_artists WHERE lead_id = $1 AND musician_id = $2", [req.params.id, musicianId])).rows[0];
    if (dup2) return res.status(400).json({ error: "Already added to this event" });
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
    INSERT INTO temp_artists (id, lead_id, name, description, phone, base_city, expense_id, created_at, musician_id, confirm_token, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
  `, [id, req.params.id, name, description || null, phone || null, baseCity || null, expenseId, now, musicianId, uuid()]);
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
  if (isScopedManager(req.user)) { const ta = (await pool.query("SELECT lead_id FROM temp_artists WHERE id = $1", [req.params.id])).rows[0]; if (ta && !(await leadInManagerScope(req.user, ta.lead_id))) return scopeDeny(res); }
  const artist = (await pool.query("SELECT * FROM temp_artists WHERE id = $1", [req.params.id])).rows[0];
  if (!artist) return res.status(404).json({ error: "Not found" });
  const { feeAmount, name, phone, description, baseCity } = req.body;
  const isAdmin = req.user.access_level === "admin";
  if (req.body.status !== undefined) {
    if (!["pending", "accepted", "declined"].includes(req.body.status)) return res.status(400).json({ error: "status must be 'pending', 'accepted' or 'declined'" });
    await pool.query("UPDATE temp_artists SET status = $1, responded_at = $2 WHERE id = $3", [req.body.status, req.body.status === "pending" ? null : new Date().toISOString(), artist.id]);
    logActivity(req, `Marked ${artist.name} (guest) as ${req.body.status}`, artist.lead_id);
    await checkTeamComplete(artist.lead_id);
  }
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
  if (name !== undefined || phone !== undefined || description !== undefined || baseCity !== undefined) {
    await pool.query(`
      UPDATE temp_artists SET name = COALESCE($1, name), phone = COALESCE($2, phone), description = COALESCE($3, description), base_city = COALESCE($4, base_city) WHERE id = $5
    `, [name ?? null, phone ?? null, description ?? null, baseCity ?? null, artist.id]);
  }
  const { rows } = await pool.query(`
    SELECT temp_artists.*, expenses.amount AS fee_amount, expenses.paid AS fee_paid,
      expenses.payment_date AS fee_payment_date, expenses.payment_mode AS fee_payment_mode
    FROM temp_artists LEFT JOIN expenses ON expenses.id = temp_artists.expense_id WHERE temp_artists.id = $1
  `, [artist.id]);
  res.json(rows[0]);
});

app.delete("/api/temp-artists/:id", requireAuth, requireCapability("assign_team"), async (req, res) => {
  if (isScopedManager(req.user)) { const ta = (await pool.query("SELECT lead_id FROM temp_artists WHERE id = $1", [req.params.id])).rows[0]; if (ta && !(await leadInManagerScope(req.user, ta.lead_id))) return scopeDeny(res); }
  const artist = (await pool.query("SELECT * FROM temp_artists WHERE id = $1", [req.params.id])).rows[0];
  if (artist?.expense_id) await pool.query("DELETE FROM expenses WHERE id = $1", [artist.expense_id]);
  await pool.query("DELETE FROM temp_artists WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// A running roster of every one-off/guest artist ever hired, across all
// events — separate from the per-event list above, this is the "who have
// we used before, and how do we reach them" reference for future bookings.
// Grouped by phone (or name, if no phone) so the same person hired for
// several events shows up once with their most recent details and full history.
app.get("/api/temp-artists", requireAuth, requireCapability("assign_team"), async (req, res) => {
  let { rows } = await pool.query(`
    SELECT temp_artists.*, leads.name AS lead_name, leads.date AS lead_date, leads.city AS lead_city
    FROM temp_artists
    JOIN leads ON leads.id = temp_artists.lead_id
    ORDER BY temp_artists.created_at DESC
  `);
  if (isScopedManager(req.user)) { const ids = await assignedLeadIdSet(req.user); rows = rows.filter((r) => ids && ids.has(r.lead_id)); }
  const groups = new Map();
  for (const row of rows) {
    const key = (row.phone && row.phone.trim()) ? `phone:${row.phone.trim()}` : `name:${row.name.trim().toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        name: row.name, phone: row.phone, baseCity: row.base_city, description: row.description,
        events: [],
      });
    }
    const g = groups.get(key);
    // Most recent non-empty details win, since that's most likely to be current.
    if (row.base_city) g.baseCity = row.base_city;
    if (row.description) g.description = row.description;
    g.events.push({ leadName: row.lead_name, date: row.lead_date, city: row.lead_city });
  }
  res.json(Array.from(groups.values()).sort((a, b) => (b.events[0]?.date || "").localeCompare(a.events[0]?.date || "")));
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
  await checkTeamComplete(a.lead_id);
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
  if (!(await assignmentInManagerScope(req.user, req.params.id))) return scopeDeny(res);
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
  await checkTeamComplete(a.lead_id);
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
  if (isScopedManager(req.user)) { /* only events allotted to them — falls through to the roster check below */ }
  else if (userHasSection(req.user, "leads") || userHasSection(req.user, "assign_team")) return true;
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
  const showMoney = canSeeMoney(req.user);
  const team = (await pool.query("SELECT * FROM team")).rows.map(({ local_fee, outstation_fee, reg_details, notes, legacy_musician_id, ...m }) => ({
    ...m,
    ...(req.user.access_level === "admin" ? { reg_details, notes } : {}),
    ...(showMoney ? { local_fee, outstation_fee } : {}),
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
  let { rows } = await pool.query(`
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
  if (isScopedManager(req.user)) { const ids = await assignedLeadIdSet(req.user); rows = rows.filter((r) => ids && ids.has(r.lead_id)); }
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
  if (userHasSection(req.user, "leads") && !isScopedManager(req.user)) return res.json(filtered.map((l) => stripLeadMoney(l, req.user)));
  if (userHasSection(req.user, "assign_team") && !isScopedManager(req.user)) return res.json(filtered.map(restrictedLeadView));
  const mineIds = await assignedLeadIdSet(req.user);
  res.json((mineIds ? filtered.filter((l) => mineIds.has(l.id)) : filtered).map(restrictedLeadView));
});

// ---------- Accounts ----------
app.get("/api/accounts", requireAuth, requireSection("accounts"), async (req, res) => {
  const rows = (await pool.query("SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed')")).rows;
  // Fee payments only — see the matching comment in /api/leads. Reimbursement
  // money, once received, must stay out of this or Outstanding goes
  // negative by the reimbursed amount even though nothing is actually owed.
  const paymentSums = (await pool.query(`
    SELECT lead_id, COALESCE(SUM(amount), 0) AS total
    FROM payments WHERE lead_id = ANY($1::text[]) AND status = 'received' AND type = 'payment' GROUP BY lead_id
  `, [rows.map((r) => r.id)])).rows;
  const receivedByLead = {};
  paymentSums.forEach((p) => (receivedByLead[p.lead_id] = Number(p.total)));
  const dueReimbursementSums = (await pool.query(`
    SELECT lead_id, COALESCE(SUM(amount), 0) AS total
    FROM payments WHERE lead_id = ANY($1::text[]) AND type = 'client_reimbursement' AND status = 'due' GROUP BY lead_id
  `, [rows.map((r) => r.id)])).rows;
  const dueReimbursementByLead = {};
  dueReimbursementSums.forEach((p) => (dueReimbursementByLead[p.lead_id] = Number(p.total)));

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
    const reimbursement_due = dueReimbursementByLead[l.id] || 0;
    if (l.combo_group_id) {
      const groupLeadIds = rows.filter((r) => r.combo_group_id === l.combo_group_id).map((r) => r.id);
      const groupExpenses = groupLeadIds.reduce((sum, id) => sum + (expensesByLead[id] || 0), 0);
      if (l.is_combo_primary) {
        // Primary carries the combined price — its profit accounts for every
        // linked event's expenses, not just its own, so the group nets out
        // correctly instead of splitting oddly across rows.
        return { ...l, received: receivedByLead[l.id] || 0, reimbursement_due, expenses, profit: revenue - groupExpenses };
      }
      // Non-primary combo events have no revenue of their own by design (the
      // price lives on the primary) — show their own expenses for visibility,
      // but skip a per-row profit figure since it would misleadingly look
      // negative even though the group as a whole may be profitable.
      return { ...l, received: receivedByLead[l.id] || 0, reimbursement_due, expenses, profit: null };
    }
    return { ...l, received: receivedByLead[l.id] || 0, reimbursement_due, expenses, profit: revenue - expenses };
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
      reimbursement_due: group.reduce((s, x) => s + x.reimbursement_due, 0),
      expenses: group.reduce((s, x) => s + x.expenses, 0),
      profit: primary.profit,
    });
  }
  const totals = bookings.reduce(
    (acc, l) => {
      acc.quoted += l.final_amount || l.quote_amount || 0;
      acc.received += l.received;
      acc.reimbursementDue += l.reimbursement_due;
      acc.expenses += l.expenses;
      acc.profit += l.profit || 0;
      return acc;
    },
    { quoted: 0, received: 0, reimbursementDue: 0, expenses: 0, profit: 0 }
  );
  res.json({ bookings, totals: { ...totals, outstanding: totals.quoted - totals.received + totals.reimbursementDue } });
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
    // Fee payments actually received only — excludes reimbursements (a cost
    // pass-through, never part of Final) and anything still 'due' (not
    // actually collected yet), so Balance doesn't go negative once a
    // reimbursement is settled or count a due amount as already in hand.
    const totalReceived = leadPayments.filter((p) => p.type === "payment" && p.status === "received").reduce((s, p) => s + p.amount, 0);
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
  const { amount, date, mode, notes, type, status } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: "Enter a valid amount" });
  if (!date) return res.status(400).json({ error: "Date is required" });
  const today = new Date().toISOString().slice(0, 10);
  if (date > today) return res.status(400).json({ error: "Date can't be in the future" });
  // Named "client_reimbursement" (not just "reimbursement") to stay distinct
  // from the existing artist-expense reimbursement system in the expenses
  // table — this is the client paying TOL back, the other is TOL paying an
  // artist back. Same word, opposite direction of money.
  const finalType = type === "client_reimbursement" ? "client_reimbursement" : "payment";
  // A fee payment is inherently already-received by definition. A
  // reimbursement defaults to 'due' — logged as owed the moment the cost is
  // incurred, same as an artist expense — unless explicitly marked already
  // received (e.g. the client paid it back on the spot).
  const finalStatus = finalType === "payment" ? "received" : (status === "received" ? "received" : "due");
  const id = uuid();
  await pool.query(`
    INSERT INTO payments (id, lead_id, amount, payment_date, payment_mode, notes, type, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [id, req.params.id, Number(amount), date, finalStatus === "received" ? (mode || null) : null, notes || null, finalType, finalStatus, new Date().toISOString()]);
  res.status(201).json((await pool.query("SELECT * FROM payments WHERE id = $1", [id])).rows[0]);
  logActivity(req, `${finalType === "client_reimbursement" ? `Reimbursement ${finalStatus === "due" ? "logged as due" : "recorded"}` : "Payment recorded"} for ${lead.name}: ₹${Number(amount).toLocaleString("en-IN")}${finalStatus === "received" && mode ? ` via ${mode}` : ""}`, lead.id);
});

// Marks a due reimbursement as actually received from the client (or
// reverts a received one back to due, if it was marked by mistake) — the
// same "due → paid" transition the expenses table already has for artist fees.
app.patch("/api/payments/:id", requireAuth, requireSection("accounts"), requireAdmin, async (req, res) => {
  const payment = (await pool.query("SELECT * FROM payments WHERE id = $1", [req.params.id])).rows[0];
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  if (payment.type !== "client_reimbursement") return res.status(400).json({ error: "Only reimbursements can change status" });
  const { status, date, mode } = req.body;
  if (status !== "received" && status !== "due") return res.status(400).json({ error: "status must be 'received' or 'due'" });
  if (status === "received") {
    const receivedDate = date || new Date().toISOString().slice(0, 10);
    await pool.query("UPDATE payments SET status = 'received', payment_date = $1, payment_mode = $2 WHERE id = $3", [receivedDate, mode || null, payment.id]);
  } else {
    await pool.query("UPDATE payments SET status = 'due', payment_mode = NULL WHERE id = $1", [payment.id]);
  }
  const lead = (await pool.query("SELECT name FROM leads WHERE id = $1", [payment.lead_id])).rows[0];
  logActivity(req, `Reimbursement marked ${status} for ${lead?.name || "a lead"}: ₹${Number(payment.amount).toLocaleString("en-IN")}`, payment.lead_id);
  res.json((await pool.query("SELECT * FROM payments WHERE id = $1", [req.params.id])).rows[0]);
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
      (CASE WHEN p.type = 'client_reimbursement' THEN 'Reimbursement received' ELSE 'Payment received' END) AS description
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
  // Task titles can mention deals — without the Tasks section you only see your own.
  res.json(userHasSection(req.user, "tasks") ? rows : rows.filter((t) => req.user.team_id && t.assigned_to === req.user.team_id));
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
const DOC_LIST_COLUMNS = "id, lead_id, original_name, notes, uploaded_at, travel_leg_id";

app.get("/api/documents", requireAuth, async (req, res) => {
  const { leadId } = req.query;
  const { rows: allRows } = leadId
    ? await pool.query(`SELECT ${DOC_LIST_COLUMNS} FROM documents WHERE lead_id = $1 ORDER BY uploaded_at DESC`, [leadId])
    : await pool.query(`SELECT ${DOC_LIST_COLUMNS} FROM documents ORDER BY uploaded_at DESC`);
  // Invoices, quotes, contracts etc. live here too — anyone without Documents/Leads
  // access (e.g. a manager) only sees riders, which is all they need to forward.
  const fullAccess = userHasSection(req.user, "documents") || userHasSection(req.user, "leads");
  const rows = fullAccess ? allRows : allRows.filter((d) => /rider/i.test(d.notes || ""));
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

app.post("/api/documents", requireAuth, requireAnySection(["documents", "leads"]), upload.single("file"), async (req, res) => {
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

app.delete("/api/documents/:id", requireAuth, requireAnySection(["documents", "leads"]), async (req, res) => {
  await pool.query("DELETE FROM documents WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// Copies a document from the general library onto a specific event, without
// re-uploading — the bytes are duplicated into a new row (not just referenced),
// so deleting either copy later never breaks the other one.
app.post("/api/documents/:id/attach", requireAuth, requireAnySection(["documents", "leads"]), async (req, res) => {
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

// ---------- Travel ID cards + client travel-share links ----------
// ID cards are admin-only and stored apart from `documents`. Clients never get a
// raw file URL: they get one expiring, revocable page (/trip/:token) that shows
// only the chosen team members' IDs plus the travel legs linked to that event.
const ID_DOC_MIMES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/i;
const escHtml = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

app.get("/api/team/:id/id-docs", requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT id, team_id, label, original_name, mime_type, uploaded_at FROM team_id_docs WHERE team_id = $1 ORDER BY uploaded_at ASC", [req.params.id]);
  res.json(rows.map((d) => ({ ...d, url: `/api/team-id-docs/${d.id}/file` })));
});
app.post("/api/team/:id/id-docs", requireAuth, requireAdmin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (!ID_DOC_MIMES.test(req.file.mimetype || "")) return res.status(400).json({ error: "Please upload a photo (JPG/PNG) or a PDF." });
  const member = (await pool.query("SELECT name FROM team WHERE id = $1", [req.params.id])).rows[0];
  if (!member) return res.status(404).json({ error: "Team member not found" });
  const id = uuid();
  await pool.query(
    "INSERT INTO team_id_docs (id, team_id, label, original_name, mime_type, file_data, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, req.params.id, (req.body.label || "").trim() || null, req.file.originalname, req.file.mimetype, req.file.buffer, new Date().toISOString()]
  );
  logActivity(req, `Travel ID uploaded for ${member.name}${req.body.label ? ` (${req.body.label})` : ""}`, null);
  res.status(201).json({ id });
});
app.get("/api/team-id-docs/:docId/file", requireAuth, requireAdmin, async (req, res) => {
  const d = (await pool.query("SELECT original_name, mime_type, file_data FROM team_id_docs WHERE id = $1", [req.params.docId])).rows[0];
  if (!d || !d.file_data) return res.status(404).send("File not found");
  res.setHeader("Content-Type", d.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(d.original_name)}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(d.file_data);
});
app.delete("/api/team-id-docs/:docId", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM team_id_docs WHERE id = $1", [req.params.docId]);
  res.status(204).end();
});

// Travellers on a share: team members plus guest musicians (picked from the Musicians
// database for this event). Guest ids look like "g:<temp_artist id>". Guests' IDs live on
// the musician record (or on the team record if they were promoted to Team later).
async function loadTravellers(leadId, ids) {
  let teamIds = ids.filter((x) => !String(x).startsWith("g:"));
  const guestIdsAll = ids.filter((x) => String(x).startsWith("g:")).map((x) => String(x).slice(2));
  // Old links may name guests that have since become normal team entries.
  const moved = guestIdsAll.length ? (await pool.query(
    "SELECT ea.team_id FROM temp_artists ta JOIN event_assignments ea ON ea.id = ta.migrated_assignment_id WHERE ta.id = ANY($1)", [guestIdsAll])).rows.map((r) => r.team_id) : [];
  teamIds = [...new Set([...teamIds, ...moved])];
  const guestIds = guestIdsAll;
  const team = teamIds.length ? (await pool.query("SELECT id, name, role, phone FROM team WHERE id = ANY($1) ORDER BY name ASC", [teamIds])).rows : [];
  const teamDocs = teamIds.length ? (await pool.query("SELECT id, team_id, label, original_name, mime_type FROM team_id_docs WHERE team_id = ANY($1) ORDER BY uploaded_at ASC", [teamIds])).rows : [];
  const guests = guestIds.length ? (await pool.query(
    `SELECT ta.id, ta.name, ta.description AS role, ta.phone, ta.musician_id, m.team_id AS musician_team_id
     FROM temp_artists ta JOIN musicians m ON m.id = ta.musician_id WHERE ta.lead_id = $1 AND ta.id = ANY($2) AND ta.migrated_assignment_id IS NULL ORDER BY ta.name ASC`, [leadId, guestIds])).rows : [];
  const mids = guests.map((g) => g.musician_id);
  const mteams = guests.map((g) => g.musician_team_id).filter(Boolean);
  const guestDocs = guests.length ? (await pool.query(
    "SELECT id, team_id, musician_id, label, original_name, mime_type FROM team_id_docs WHERE musician_id = ANY($1) OR team_id = ANY($2) ORDER BY uploaded_at ASC", [mids, mteams])).rows : [];
  return {
    team: team.map((t) => ({ ...t, docs: teamDocs.filter((d) => d.team_id === t.id) })),
    guests: guests.map((g) => ({ ...g, key: "g:" + g.id, docs: guestDocs.filter((d) => d.musician_id === g.musician_id || (g.musician_team_id && d.team_id === g.musician_team_id)) })),
  };
}
// Everything the "Send IDs & travel details" screen needs, in one call.
app.get("/api/leads/:id/travel-share", requireAuth, requireAdmin, async (req, res) => {
  const leadId = req.params.id;
  const [assigned, temps, legs, shares] = await Promise.all([
    pool.query(`SELECT team.id AS team_id, team.name, team.role, team.phone, event_assignments.status
                FROM event_assignments JOIN team ON team.id = event_assignments.team_id
                WHERE event_assignments.lead_id = $1 ORDER BY team.name ASC`, [leadId]),
    pool.query("SELECT id, name, description, phone, musician_id FROM temp_artists WHERE lead_id = $1 AND migrated_assignment_id IS NULL", [leadId]),
    pool.query("SELECT id, mode, from_city, to_city, departure_at, arrival_at FROM travel_legs WHERE lead_id = $1 ORDER BY departure_at ASC NULLS LAST, created_at ASC", [leadId]),
    pool.query("SELECT token, team_ids, created_at, expires_at, revoked FROM travel_shares WHERE lead_id = $1 ORDER BY created_at DESC", [leadId]),
  ]);
  const teamIds = assigned.rows.map((r) => r.team_id);
  const legIds = legs.rows.map((l) => l.id);
  const [ids, members] = await Promise.all([
    teamIds.length ? pool.query("SELECT id, team_id, label, original_name, mime_type FROM team_id_docs WHERE team_id = ANY($1) ORDER BY uploaded_at ASC", [teamIds]) : { rows: [] },
    legIds.length ? pool.query("SELECT leg_id, team_id FROM travel_leg_members WHERE leg_id = ANY($1)", [legIds]) : { rows: [] },
  ]);
  const ticketRows = legIds.length ? (await pool.query("SELECT id, original_name, travel_leg_id FROM documents WHERE travel_leg_id = ANY($1) ORDER BY uploaded_at ASC", [legIds])).rows : [];
  const guestRows = temps.rows.filter((t) => t.musician_id);
  const trav = guestRows.length ? await loadTravellers(leadId, guestRows.map((t) => "g:" + t.id)) : { guests: [] };
  res.json({
    team: [
      ...assigned.rows.map((r) => ({
        teamId: r.team_id, name: r.name, role: r.role, phone: r.phone, status: r.status,
        uploadBase: "team", uploadId: r.team_id,
        idDocs: ids.rows.filter((d) => d.team_id === r.team_id).map((d) => ({ ...d, url: `/api/team-id-docs/${d.id}/file` })),
      })),
      ...trav.guests.map((g) => ({
        teamId: g.key, name: g.name, role: g.role, phone: g.phone, status: "confirmed", guest: true,
        uploadBase: "musicians", uploadId: g.musician_id,
        idDocs: g.docs.map((d) => ({ ...d, url: `/api/team-id-docs/${d.id}/file` })),
      })),
    ],
    tempArtists: temps.rows.filter((t) => !t.musician_id).map((t) => t.name),
    legs: legs.rows.map((l) => ({ ...l, memberIds: members.rows.filter((m) => m.leg_id === l.id).map((m) => m.team_id), tickets: ticketRows.filter((t) => t.travel_leg_id === l.id).map((t) => ({ id: t.id, name: t.original_name })) })),
    shares: shares.rows.map((s) => ({ token: s.token, teamIds: JSON.parse(s.team_ids || "[]"), createdAt: s.created_at, expiresAt: s.expires_at, revoked: !!s.revoked })),
  });
});
app.post("/api/leads/:id/travel-share", requireAuth, requireAdmin, async (req, res) => {
  const leadId = req.params.id;
  const allIds = Array.isArray(req.body.teamIds) ? [...new Set(req.body.teamIds.map(String))] : [];
  const teamIds = allIds.filter((x) => !x.startsWith("g:"));
  const guestIds = allIds.filter((x) => x.startsWith("g:")).map((x) => x.slice(2));
  if (allIds.length === 0) return res.status(400).json({ error: "Select at least one person." });
  const lead = (await pool.query("SELECT name FROM leads WHERE id = $1", [leadId])).rows[0];
  if (!lead) return res.status(404).json({ error: "Event not found" });
  // Only people actually assigned to THIS event can ever be included.
  const ok = (teamIds.length ? await pool.query("SELECT team_id FROM event_assignments WHERE lead_id = $1 AND team_id = ANY($2)", [leadId, teamIds]) : { rows: [] }).rows.map((r) => r.team_id);
  const okGuests = guestIds.length ? (await pool.query("SELECT id FROM temp_artists WHERE lead_id = $1 AND musician_id IS NOT NULL AND id = ANY($2)", [leadId, guestIds])).rows : [];
  if (ok.length !== teamIds.length || okGuests.length !== guestIds.length) return res.status(400).json({ error: "Someone selected isn't assigned to this event." });
  const token = crypto.randomBytes(24).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + 15 * 86400000);
  await pool.query("INSERT INTO travel_shares (token, lead_id, team_ids, created_at, expires_at, created_by, include_tickets, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [token, leadId, JSON.stringify(allIds), now.toISOString(), expires.toISOString(), req.user.username || null, req.body.includeTickets ? 1 : 0, String(req.body.note || "").trim().slice(0, 1000) || null]);
  logActivity(req, `Travel IDs & details link created for ${lead.name} (${allIds.length} traveller${allIds.length > 1 ? "s" : ""})`, leadId);
  res.status(201).json({ token, expiresAt: expires.toISOString() });
});
app.post("/api/travel-share/:token/revoke", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("UPDATE travel_shares SET revoked = 1 WHERE token = $1", [req.params.token]);
  res.json({ ok: true });
});

async function loadTravelShare(token) {
  const s = (await pool.query("SELECT * FROM travel_shares WHERE token = $1", [token])).rows[0];
  if (!s || s.revoked || new Date(s.expires_at) < new Date()) return null;
  return s;
}
const fmtWall = (v) => {
  // Stored as a wall-clock string ("2026-10-20T14:30"); format without any timezone shifting.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(v || "");
  if (!m) return v || "";
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m[2]) - 1];
  let out = `${Number(m[3])} ${mon} ${m[1]}`;
  if (m[4]) { const h = Number(m[4]); out += `, ${((h + 11) % 12) + 1}:${m[5]} ${h >= 12 ? "PM" : "AM"}`; }
  return out;
};
app.get("/trip/:token", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const s = await loadTravelShare(req.params.token);
  const shell = (body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Travel details — Together, Out Loud</title>${head}
<style>body{font-family:Georgia,serif;background:#FBF6EC;color:#3A2A1A;margin:0;padding:18px}.w{max-width:640px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 8px;text-transform:uppercase;letter-spacing:.06em;color:#8A5A1F}.c{background:#fff;border:1px solid #E9DFCF;border-radius:12px;padding:12px 14px;margin-bottom:10px}.m{color:#7A6A58;font-size:13px}img{max-width:100%;border-radius:8px;border:1px solid #E9DFCF;margin-top:8px}a{color:#B5541C}</style></head><body><div class="w">${body}</div></body></html>`;
  if (!s) return res.status(404).send(shell(`<h1>This link is no longer available</h1><p class="m">It may have expired or been replaced. Please ask Together, Out Loud for a fresh link.</p>`));
  const lead = (await pool.query("SELECT name, date, city, event_type, occasion FROM leads WHERE id = $1", [s.lead_id])).rows[0];
  const allIds = JSON.parse(s.team_ids || "[]");
  const teamIds = allIds.filter((x) => !String(x).startsWith("g:"));
  const trav = await loadTravellers(s.lead_id, allIds);
  const ticketDocs = s.include_tickets ? (await pool.query("SELECT id, original_name, mime_type, travel_leg_id FROM documents WHERE travel_leg_id IN (SELECT id FROM travel_legs WHERE lead_id = $1) ORDER BY uploaded_at ASC", [s.lead_id])).rows : [];
  const [legs, members] = await Promise.all([
    pool.query("SELECT id, mode, from_city, to_city, departure_at, arrival_at FROM travel_legs WHERE lead_id = $1 ORDER BY departure_at ASC NULLS LAST, created_at ASC", [s.lead_id]),
    pool.query("SELECT travel_leg_members.leg_id, team.id AS team_id, team.name FROM travel_leg_members JOIN team ON team.id = travel_leg_members.team_id WHERE leg_id IN (SELECT id FROM travel_legs WHERE lead_id = $1)", [s.lead_id]),
  ]);
  const legCards = legs.rows.map((l) => {
    const who = members.rows.filter((m) => m.leg_id === l.id && teamIds.includes(m.team_id)).map((m) => m.name);
    if (who.length === 0) return "";
    return `<div class="c"><b>${escHtml(l.mode ? l.mode[0].toUpperCase() + l.mode.slice(1) : "Travel")}</b> — ${escHtml(l.from_city || "?")} → ${escHtml(l.to_city || "?")}
      ${l.departure_at ? `<div class="m">Depart: ${escHtml(fmtWall(String(l.departure_at).slice(0, 10)))}</div>` : ""}${l.arrival_at ? `<div class="m">Arrive: ${escHtml(fmtWall(String(l.arrival_at).slice(0, 10)))}</div>` : ""}
      <div style="margin-top:6px">Travelling: ${who.map(escHtml).join(", ")}</div>
      ${ticketDocs.filter((d) => d.travel_leg_id === l.id).map((d) => { const url = `/trip/${encodeURIComponent(req.params.token)}/ticket/${d.id}`; return `<div style="margin-top:8px"><span class="m">\ud83c\udfab ${escHtml(d.original_name)}</span>${/^image\//i.test(d.mime_type || "") && !/hei[cf]/i.test(d.mime_type) ? `<br><img src="${url}" alt="Ticket">` : ""}<br><a href="${url}" target="_blank" rel="noopener">Open ticket</a></div>`; }).join("")}</div>`;
  }).join("");
  const idCards = [...trav.team, ...trav.guests].map((t) => {
    const docs = t.docs;
    return `<div class="c"><b>${escHtml(t.name)}</b>
      ${docs.length === 0 ? `<div class="m" style="color:#A6432B">ID not available — we'll send it separately.</div>` : docs.map((d) => {
        const url = `/trip/${encodeURIComponent(req.params.token)}/id/${d.id}`;
        return `<div style="margin-top:8px"><span class="m">${escHtml(d.label || d.original_name)}</span>${/^image\//i.test(d.mime_type || "") && !/hei[cf]/i.test(d.mime_type) ? `<br><img src="${url}" alt="ID">` : ""}<br><a href="${url}" target="_blank" rel="noopener">Open / download</a></div>`;
      }).join("")}</div>`;
  }).join("");
  const ogHost = `https://${req.headers["x-forwarded-host"] || req.get("host")}`;
  const ogImg = `${ogHost}/trip-card/${encodeURIComponent(req.params.token)}.png`;
  const ogTitle = `Travel details \u2014 ${lead ? lead.name : "your event"}`;
  const ogDesc = "Team IDs and travel plan, shared by Together, Out Loud for booking tickets.";
  const ogHead = `<meta property="og:type" content="website"><meta property="og:site_name" content="Together, Out Loud"><meta property="og:title" content="${escHtml(ogTitle)}"><meta property="og:description" content="${escHtml(ogDesc)}"><meta property="og:image" content="${ogImg}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${ogImg}">`;
  res.send(shell(`<h1>Travel details & IDs</h1><div class="m">${escHtml(lead ? `${lead.name}${lead.city ? " · " + lead.city : ""}${lead.date ? " · " + fmtWall(lead.date) : ""}` : "")}</div>
    <div class="m" style="margin-top:6px">Shared by Together, Out Loud for booking tickets. Link valid until ${escHtml(fmtWall(s.expires_at))}.</div>
    ${s.note ? `<div class="c" style="margin-top:12px;border-left:4px solid #C1602B"><b>Note from Together, Out Loud</b><div style="margin-top:4px;white-space:pre-wrap">${escHtml(s.note)}</div></div>` : ""}
    <h2>Team travelling (${trav.team.length + trav.guests.length})</h2>${idCards}
    <h2>Travel plan</h2>${legCards || `<div class="c m">Travel plan will be shared shortly.</div>`}`, ogHead));
});
app.get("/trip/:token/ticket/:docId", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const s = await loadTravelShare(req.params.token);
  if (!s || !s.include_tickets) return res.status(404).send("Link no longer available");
  const d = (await pool.query(`SELECT original_name, mime_type, file_data FROM documents WHERE id = $1 AND travel_leg_id IN (SELECT id FROM travel_legs WHERE lead_id = $2)`, [req.params.docId, s.lead_id])).rows[0];
  if (!d || !d.file_data) return res.status(404).send("File not found");
  res.setHeader("Content-Type", d.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(d.original_name)}"`);
  res.send(d.file_data);
});
app.get("/trip/:token/id/:docId", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const s = await loadTravelShare(req.params.token);
  if (!s) return res.status(404).send("Link no longer available");
  const trav = await loadTravellers(s.lead_id, JSON.parse(s.team_ids || "[]"));
  const allowed = new Set([...trav.team, ...trav.guests].flatMap((t) => t.docs.map((x) => x.id)));
  const d = allowed.has(req.params.docId) ? (await pool.query("SELECT original_name, mime_type, file_data FROM team_id_docs WHERE id = $1", [req.params.docId])).rows[0] : null;
  if (!d || !d.file_data) return res.status(404).send("File not found");
  res.setHeader("Content-Type", d.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(d.original_name)}"`);
  res.send(d.file_data);
});

// ---------- Artist self-registration link ----------
// One reusable link the admin shares. Submissions never create a team member by
// themselves — they wait in a pending list until an admin approves (or rejects).
const regAttempts = new Map(); // ip -> [timestamps]
const regRateOk = (ip) => {
  const now = Date.now();
  const list = (regAttempts.get(ip) || []).filter((t) => now - t < 3600000);
  if (list.length >= 8) { regAttempts.set(ip, list); return false; }
  list.push(now); regAttempts.set(ip, list); return true;
};
async function getRegLink() {
  return (await pool.query("SELECT * FROM member_reg_link LIMIT 1")).rows[0] || null;
}
app.get("/api/member-registration", requireAuth, requireAdmin, async (req, res) => {
  const link = await getRegLink();
  const pending = (await pool.query("SELECT COUNT(*) AS c FROM member_registrations WHERE status = 'pending'")).rows[0].c;
  res.json({ token: link ? link.token : null, enabled: !!(link && link.enabled), pending: Number(pending) });
});
app.post("/api/member-registration/enable", requireAuth, requireAdmin, async (req, res) => {
  const link = await getRegLink();
  const regenerate = !!req.body.regenerate;
  if (!link) {
    await pool.query("INSERT INTO member_reg_link (id, token, enabled, created_at) VALUES ($1,$2,1,$3)", [uuid(), crypto.randomBytes(18).toString("base64url"), new Date().toISOString()]);
  } else if (regenerate) {
    await pool.query("UPDATE member_reg_link SET token = $1, enabled = 1 WHERE id = $2", [crypto.randomBytes(18).toString("base64url"), link.id]);
  } else {
    await pool.query("UPDATE member_reg_link SET enabled = 1 WHERE id = $1", [link.id]);
  }
  const fresh = await getRegLink();
  res.json({ token: fresh.token, enabled: true });
});
app.post("/api/member-registration/disable", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("UPDATE member_reg_link SET enabled = 0");
  res.json({ ok: true });
});

const REG_LABELS = ["Aadhaar", "Passport", "PAN card", "Driving licence", "Voter ID", "Other document"];
async function regFormPage(req, res, ok) {
  res.setHeader("Cache-Control", "no-store");
  const css = `body{font-family:Georgia,serif;background:#FBF6EC;color:#3A2A1A;margin:0;padding:18px}.w{max-width:560px;margin:0 auto}h1{font-size:23px;margin:0 0 4px}.m{color:#7A6A58;font-size:13px}label{display:block;font-size:13px;color:#7A6A58;margin:14px 0 4px}input,select,textarea{width:100%;box-sizing:border-box;padding:11px;border:1px solid #DDD5C4;border-radius:8px;font:inherit;font-size:16px;background:#fff}.r2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.c{background:#fff;border:1px solid #E9DFCF;border-radius:12px;padding:12px 14px;margin-top:12px}button{margin-top:20px;width:100%;padding:13px;border:0;border-radius:10px;background:#B5541C;color:#fff;font:inherit;font-size:16px;cursor:pointer}button:disabled{opacity:.6}.hp{position:absolute;left:-9999px}#err{color:#A6432B;margin-top:12px;font-size:14px}`;
  if (!ok) return res.status(404).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Registration</title><style>${css}</style></head><body><div class="w"><h1>This link isn't active</h1><p class="m">Please ask Together, Out Loud for a fresh registration link.</p></div></body></html>`);
  const BASE_INST = ["Vocals", "Keyboard", "Tabla", "Drummer", "Bass Guitar", "Guitar", "Flute", "Octopad", "Dholak", "Violin", "Harmonium", "Percussion", "Photographer", "Sound Engineer"];
  const instRows = (await pool.query("SELECT instruments FROM team WHERE instruments IS NOT NULL")).rows.flatMap((r) => r.instruments.split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/ player$/i, "")));
  const instList = [...new Map([...BASE_INST, ...instRows].filter((i) => i && !/^(admin|manager)$/i.test(i)).map((i) => [i.toLowerCase(), i])).values()].sort((a, b) => a.localeCompare(b));
  const cityRows = (await pool.query("SELECT DISTINCT base_city AS city FROM team WHERE base_city IS NOT NULL")).rows.map((r) => r.city);
  const cityList = [...new Map(cityRows.filter(Boolean).map((c) => [c.toLowerCase(), c])).values()].sort((a, b) => a.localeCompare(b));
  const slot = (n, req_, title) => `<div class="c"><div style="font-weight:700">${title}${req_ ? " *" : ""}</div>
    <label>Document type</label><select name="label${n}">${REG_LABELS.map((l, i) => `<option ${(n === 2 && i === 1) || (n === 3 && i === 5) ? "selected" : ""}>${l}</option>`).join("")}</select>
    <label>Photo or PDF</label><input type="file" name="file${n}" accept="image/*,application/pdf" ${req_ ? "required" : ""}></div>`;
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Join Together, Out Loud</title><style>${css}</style></head><body><div class="w">
<div style="text-align:center;margin-bottom:14px"><img src="/logo.png" alt="" width="64" height="64" style="object-fit:contain"><div style="letter-spacing:.16em;font-size:12px;font-weight:700;color:#B5541C;margin-top:4px">TOGETHER, OUT LOUD</div></div>
<h1>Join Together, Out Loud</h1><p class="m">Artist registration. Please fill this in once — your details go only to our team and are used for bookings and travel.</p>
<form id="f" autocomplete="on">
<div class="hp"><label>Website</label><input name="website" tabindex="-1" autocomplete="off"></div>
<label>Full name (exactly as on your ID) *</label><input name="name" required maxlength="120">
<div class="r2"><div><label>WhatsApp number *</label><input name="phone" type="tel" required maxlength="20"></div><div><label>Email</label><input name="email" type="email" maxlength="120"></div></div>
<label>Instrument(s) / role * <span class="m">(pick all that you play)</span></label>
<details id="instDd" class="c" style="margin-top:4px;padding:0"><summary style="cursor:pointer;list-style:none;padding:11px 12px;display:flex;justify-content:space-between;gap:8px;align-items:center"><span id="instSel" style="color:#7A6A5A">Choose from the list</span><span aria-hidden="true">&#9662;</span></summary>
<div style="border-top:1px solid #E6D9C4;padding:10px 12px;display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;max-height:260px;overflow:auto">${instList.map((i) => `<label style="display:flex;gap:8px;align-items:center;margin:0;color:#3A2A1A"><input type="checkbox" name="inst" value="${escHtml(i)}" style="width:auto"> ${escHtml(i)}</label>`).join("")}</div></details>
<label>Not in the list? (optional, comma-separated)</label><input name="otherInst" maxlength="80" placeholder="e.g. Sarod">
<label>Base city *</label><input name="city" required maxlength="80" list="cities" autocomplete="off" placeholder="Start typing and pick your city"><datalist id="cities">${cityList.map((c) => `<option value="${escHtml(c)}"></option>`).join("")}</datalist>
<div class="r2"><div><label>Date of birth</label><input name="dob" type="date"></div><div><label>Gender (for ticket booking)</label><select name="gender"><option value="">—</option><option>Male</option><option>Female</option><option>Other</option></select></div></div>
<div class="r2"><div><label>Emergency contact name</label><input name="emName" maxlength="80"></div><div><label>Emergency contact phone</label><input name="emPhone" type="tel" maxlength="20"></div></div>
<label>Your fee expectation per performance, if any (optional)</label><input name="fee" maxlength="120" placeholder="e.g. ₹5,000 per show, or leave blank">
<label>Instagram (optional)</label><input name="instagram" maxlength="80" placeholder="@handle">
<label>Anything else we should know (optional)</label><textarea name="notes" rows="3" maxlength="600"></textarea>
<h3 style="margin:22px 0 0">Documents</h3><p class="m" style="margin:2px 0 0">A government ID is needed so we can book your tickets. Photos or PDFs, up to 8 MB each.</p>
${slot(1, true, "ID card")}${slot(2, false, "Second ID (optional)")}${slot(3, false, "Other document (optional)")}
<label style="display:flex;gap:10px;align-items:flex-start;margin-top:18px"><input type="checkbox" name="consent" required style="width:auto;margin-top:3px"> <span>I agree to share these details and documents with Together, Out Loud for event bookings and travel.</span></label>
<div id="err"></div><button id="go" type="submit">Submit registration</button></form>
<div id="done" style="display:none"><h1>Thank you!</h1><p>Your details have been received. The Together, Out Loud team will review them and get in touch.</p></div>
</div><script>
const f=document.getElementById('f');const instSel=document.getElementById('instSel');f.addEventListener('change',(e)=>{if(e.target.name==='inst'){const v=[...f.querySelectorAll('input[name=inst]:checked')].map(x=>x.value);instSel.textContent=v.length?v.join(', '):'Choose from the list';instSel.style.color=v.length?'#2B2420':'#7A6A5A'}});f.addEventListener('submit',async(e)=>{e.preventDefault();const b=document.getElementById('go'),er=document.getElementById('err');er.textContent='';
for(const n of [1,2,3]){const fl=f['file'+n].files[0];if(fl&&fl.size>8*1024*1024){er.textContent='Each file must be under 8 MB.';return}}
if(!f.querySelector('input[name=inst]:checked')&&!f.otherInst.value.trim()){er.textContent='Please pick at least one instrument.';return}
b.disabled=true;b.textContent='Uploading…';
try{const r=await fetch(location.pathname,{method:'POST',body:new FormData(f)});const j=await r.json().catch(()=>({}));
if(!r.ok)throw new Error(j.error||'Something went wrong — please try again.');f.style.display='none';document.querySelector('.m').style.display='none';document.querySelector('h1').style.display='none';document.getElementById('done').style.display='block';window.scrollTo(0,0)}
catch(x){er.textContent=x.message;b.disabled=false;b.textContent='Submit registration'}});
</script></body></html>`);
}
app.get("/join/:token", async (req, res) => {
  const link = await getRegLink();
  regFormPage(req, res, !!(link && link.enabled && link.token === req.params.token));
});
// Public entry point for the website's "Join the band" button. Open whenever the
// registration link is switched on (turning it off in the Team tab closes this too).
app.get("/join-us", async (req, res) => {
  let link = await getRegLink();
  if (!link) {
    await pool.query("INSERT INTO member_reg_link (id, token, enabled, created_at) VALUES ($1,$2,1,$3)", [uuid(), crypto.randomBytes(18).toString("base64url"), new Date().toISOString()]);
    link = await getRegLink();
  }
  regFormPage(req, res, !!link.enabled);
});
const regUpload = upload.fields([{ name: "file1", maxCount: 1 }, { name: "file2", maxCount: 1 }, { name: "file3", maxCount: 1 }]);
app.post("/join-us", regUpload, async (req, res) => {
  const link = await getRegLink();
  if (!link || !link.enabled) return res.status(404).json({ error: "Registrations are currently closed." });
  return regSubmit(req, res);
});
app.post("/join/:token", regUpload, async (req, res) => {
  const link = await getRegLink();
  if (!link || !link.enabled || link.token !== req.params.token) return res.status(404).json({ error: "This registration link is no longer active." });
  return regSubmit(req, res);
});
function regRole(body) {
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean);
  const all = [...arr(body.inst), ...String(body.otherInst || "").split(",").map((x) => x.trim()).filter(Boolean)];
  return [...new Set(all)].join(", ").slice(0, 160);
}
async function regSubmit(req, res) {
  if (req.body.website) return res.json({ ok: true }); // honeypot — bots fill hidden fields
  if (!regRateOk(String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim())) return res.status(429).json({ error: "Too many submissions — please try again later." });
  const t = (k, max = 200) => String(req.body[k] || "").trim().slice(0, max);
  const data = {
    name: t("name", 120), phone: t("phone", 20), email: t("email", 120), role: regRole(req.body), city: t("city", 80),
    dob: t("dob", 12), gender: t("gender", 12), emName: t("emName", 80), emPhone: t("emPhone", 20),
    instagram: t("instagram", 80), fee: t("fee", 120), notes: t("notes", 600),
  };
  if (!data.name || !data.role || !data.city) return res.status(400).json({ error: "Please fill in name, role and base city." });
  if (data.phone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "Please enter a valid WhatsApp number." });
  if (!req.body.consent) return res.status(400).json({ error: "Please tick the consent box." });
  const files = [1, 2, 3].map((n) => ({ n, f: (req.files?.["file" + n] || [])[0] })).filter((x) => x.f);
  if (!files.length || !files.some((x) => x.n === 1)) return res.status(400).json({ error: "Please attach a photo or PDF of your ID." });
  for (const { f } of files) {
    if (!ID_DOC_MIMES.test(f.mimetype || "")) return res.status(400).json({ error: "Documents must be photos (JPG/PNG) or PDFs." });
    if (f.size > 8 * 1024 * 1024) return res.status(400).json({ error: "Each file must be under 8 MB." });
  }
  const id = uuid();
  await pool.query("INSERT INTO member_registrations (id, data, status, created_at) VALUES ($1,$2,'pending',$3)", [id, JSON.stringify(data), new Date().toISOString()]);
  for (const { n, f } of files) {
    const label = REG_LABELS.includes(String(req.body["label" + n])) ? String(req.body["label" + n]) : "Other document";
    await pool.query("INSERT INTO member_registration_files (id, registration_id, label, original_name, mime_type, file_data) VALUES ($1,$2,$3,$4,$5,$6)", [uuid(), id, label, f.originalname, f.mimetype, f.buffer]);
  }
  res.status(201).json({ ok: true });
}

app.get("/api/member-registrations", requireAuth, requireAdmin, async (req, res) => {
  const regs = (await pool.query("SELECT * FROM member_registrations WHERE status = 'pending' ORDER BY created_at ASC")).rows;
  const files = regs.length ? (await pool.query("SELECT id, registration_id, label, original_name, mime_type FROM member_registration_files WHERE registration_id = ANY($1)", [regs.map((r) => r.id)])).rows : [];
  const team = (await pool.query("SELECT id, name, phone FROM team")).rows;
  const last10 = (v) => (v || "").replace(/\D/g, "").slice(-10);
  res.json(regs.map((r) => {
    const data = JSON.parse(r.data);
    const dup = team.find((m) => last10(m.phone) && last10(m.phone) === last10(data.phone));
    return { id: r.id, createdAt: r.created_at, data, duplicateOf: dup ? { id: dup.id, name: dup.name } : null,
      files: files.filter((f) => f.registration_id === r.id).map((f) => ({ ...f, url: `/api/member-registrations/${r.id}/file/${f.id}` })) };
  }));
});
app.get("/api/member-registrations/:id/file/:fid", requireAuth, requireAdmin, async (req, res) => {
  const d = (await pool.query("SELECT original_name, mime_type, file_data FROM member_registration_files WHERE id = $1 AND registration_id = $2", [req.params.fid, req.params.id])).rows[0];
  if (!d) return res.status(404).send("File not found");
  res.setHeader("Content-Type", d.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(d.original_name)}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(d.file_data);
});
app.post("/api/member-registrations/:id/approve", requireAuth, requireAdmin, async (req, res) => {
  const reg = (await pool.query("SELECT * FROM member_registrations WHERE id = $1 AND status = 'pending'", [req.params.id])).rows[0];
  if (!reg) return res.status(404).json({ error: "Already handled or not found" });
  const d = JSON.parse(reg.data);
  const b = req.body || {};
  const name = (b.name || d.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required" });
  const teamId = uuid();
  // Match existing spellings (case-insensitive) so the city/instrument filters group them correctly.
  const knownCities = (await pool.query("SELECT DISTINCT base_city AS c FROM team WHERE base_city IS NOT NULL")).rows.map((r) => r.c);
  const knownInst = [...new Set((await pool.query("SELECT instruments FROM team WHERE instruments IS NOT NULL")).rows.flatMap((r) => r.instruments.split(",").map((x) => x.trim()).filter(Boolean)))];
  const norm = (v) => String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
  const canon = (v, known) => { const n = norm(v); return known.find((k) => norm(k) === n) || String(v || "").trim(); };
  const INST_ALIAS = { drum: "drummer", drums: "drummer", vocal: "vocals", singer: "vocals", vocalist: "vocals", keys: "keyboard", keyboardist: "keyboard", guitarist: "guitar", "bass": "bass guitar", bassist: "bass guitar" };
  const canonInst = (v) => canon(INST_ALIAS[norm(v)] || v, knownInst);
  const instruments = [...new Set(String((b.role ?? d.role) || "").split(",").map((x) => x.trim()).filter(Boolean).map(canonInst))].join(", ");
  const details = { legalName: d.name, dob: d.dob, gender: d.gender, emergencyName: d.emName, emergencyPhone: d.emPhone, instagram: d.instagram, feeExpectation: d.fee, notes: d.notes };
  const notes = [d.fee ? `Fee expectation: ${d.fee}` : "", d.instagram ? `Instagram: ${d.instagram}` : "", d.notes || ""].filter(Boolean).join(" \u00b7 ");
  await pool.query(`INSERT INTO team (id, name, role, phone, email, specialty, base_city, reg_details, kind, instruments, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'freelance',$9,$10)`,
    [teamId, name, instruments || "Musician", (b.phone ?? d.phone) || null, d.email || null, instruments || null,
     canon((b.baseCity ?? d.city) || "", knownCities) || null, JSON.stringify(details), instruments || null, notes || null]);
  const files = (await pool.query("SELECT * FROM member_registration_files WHERE registration_id = $1", [reg.id])).rows;
  for (const f of files) {
    await pool.query("INSERT INTO team_id_docs (id, team_id, label, original_name, mime_type, file_data, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [uuid(), teamId, f.label, f.original_name, f.mime_type, f.file_data, new Date().toISOString()]);
  }
  await pool.query("DELETE FROM member_registration_files WHERE registration_id = $1", [reg.id]);
  await pool.query("UPDATE member_registrations SET status = 'approved', team_id = $1 WHERE id = $2", [teamId, reg.id]);
  logActivity(req, `Artist registration approved into Team (freelance): ${name}`, null);
  res.json({ teamId });
});
app.post("/api/member-registrations/:id/reject", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM member_registrations WHERE id = $1 AND status = 'pending'", [req.params.id]);
  res.json({ ok: true });
});

// ---------- Personalised event cards (link preview for confirmation messages) ----------
// WhatsApp can't open a specific chat AND attach an image, so the card is hosted at
// an unguessable link; WhatsApp turns that link into a rich preview (the wide image).
const cardUpload = upload.fields([{ name: "portrait", maxCount: 1 }, { name: "wide", maxCount: 1 }]);
app.post("/api/event-cards", requireAuth, requireAnySection(["leads"]), cardUpload, async (req, res) => {
  const portrait = req.files?.portrait?.[0], wide = req.files?.wide?.[0];
  if (!portrait || !wide) return res.status(400).json({ error: "Card images missing" });
  if (![portrait, wide].every((f) => /^image\/png$/i.test(f.mimetype))) return res.status(400).json({ error: "Card must be PNG" });
  const token = crypto.randomBytes(16).toString("base64url");
  await pool.query("INSERT INTO event_cards (token, portrait, wide, title, description, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [token, portrait.buffer, wide.buffer, String(req.body.title || "").slice(0, 120), String(req.body.description || "").slice(0, 240), new Date().toISOString()]);
  res.status(201).json({ token });
});
app.get("/card/:token/:which(portrait|wide).png", async (req, res) => {
  const row = (await pool.query(`SELECT ${req.params.which} AS img FROM event_cards WHERE token = $1`, [req.params.token])).rows[0];
  if (!row || !row.img) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(row.img);
});
app.get("/card/:token", async (req, res) => {
  const row = (await pool.query("SELECT title, description FROM event_cards WHERE token = $1", [req.params.token])).rows[0];
  if (!row) return res.status(404).send("Not found");
  const host = `https://${req.headers["x-forwarded-host"] || req.get("host")}`;
  const t = encodeURIComponent(req.params.token);
  const img = `${host}/card/${t}/wide.png`;
  res.setHeader("Cache-Control", "no-store");
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(row.title)} — Together, Out Loud</title>
<meta property="og:type" content="website"><meta property="og:site_name" content="Together, Out Loud"><meta property="og:title" content="${escHtml(row.title)}"><meta property="og:description" content="${escHtml(row.description)}">
<meta property="og:image" content="${img}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:url" content="${host}/card/${t}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${img}">
<style>body{margin:0;background:#FBF6EC;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}body{flex-direction:column;gap:14px;font-family:Georgia,serif}img{max-width:100%;max-height:84vh;border-radius:14px;box-shadow:0 8px 30px rgba(60,40,20,.18)}.f{font-size:14px;color:#7a5a3a}.f a{color:#C1602B;text-decoration:none;margin:0 6px}</style></head>
<body><img src="${host}/card/${t}/portrait.png" alt="${escHtml(row.title)}"><div class="f"><a href="https://www.instagram.com/togetheroutloudclub">Instagram</a>·<a href="https://www.togetheroutloud.in">togetheroutloud.in</a></div></body></html>`);
});

// ---------- Dashboard ----------
// ---------- Message templates — self-service wording for Follow-up / Tentative / Confirmed / Document-share messages ----------
app.get("/api/message-templates", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT key, template FROM message_templates");
  const map = {};
  rows.forEach((r) => (map[r.key] = r.template));
  // Pricing matrix and bank/UPI details are commercial — only for people who quote or handle money.
  if (!userHasSection(req.user, "leads") && !userHasSection(req.user, "quotation") && !canSeeMoney(req.user)) {
    ["pricing_matrix", "bank_details", "bank_qr_document_id"].forEach((k) => delete map[k]);
  }
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
    "SELECT * FROM activity_log WHERE created_at >= $1 ORDER BY created_at DESC",
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

  // No Leads access (e.g. a manager): no pipeline, no totals, no outstanding —
  // just their own upcoming events and tasks.
  if (!userHasSection(req.user, "leads") || isScopedManager(req.user)) {
    const mineIds = (userHasSection(req.user, "assign_team") && !isScopedManager(req.user)) ? null : await assignedLeadIdSet(req.user);
    const upcomingAll = (await pool.query(`SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed') AND date >= $1 ORDER BY date ASC`, [today])).rows
      .filter((l) => !mineIds || mineIds.has(l.id));
    const allTasks = (await pool.query(`SELECT * FROM tasks WHERE done = 0 AND (due_date <= $1 OR due_date IS NULL) ORDER BY due_date ASC LIMIT 8`, [weekAhead])).rows;
    return res.json({
      upcomingEvents: upcomingAll.slice(0, 5).map(restrictedLeadView),
      upcomingEventsCount: upcomingAll.length,
      pendingFollowUps: [],
      tasksDueSoon: userHasSection(req.user, "tasks") ? allTasks : allTasks.filter((t) => req.user.team_id && t.assigned_to === req.user.team_id),
      newLeadsCount: 0,
      tentativeBookings: [],
      interestedLeads: [],
      outstanding: 0,
      stageCounts: {},
    });
  }

  const [upcomingRes, upcomingCountRes, followUpsRes, accountsRes, paymentsRes, dueReimbursementRes, tasksRes, newLeadsRes, tentativeRes, interestedRes, stageCountsRes] = await Promise.all([
    pool.query(`SELECT * FROM leads WHERE stage IN ('Confirmed', 'Completed') AND date >= $1 ORDER BY date ASC LIMIT 5`, [today]),
    pool.query(`SELECT COUNT(*) AS c FROM leads WHERE stage IN ('Confirmed', 'Completed') AND date >= $1`, [today]),
    pool.query(`SELECT * FROM leads WHERE stage = 'Follow-up' AND (snooze_until IS NULL OR snooze_until <= $1) ORDER BY last_followup_at ASC NULLS FIRST, created_at ASC`, [today]),
    pool.query(`SELECT id, final_amount, quote_amount FROM leads WHERE stage IN ('Confirmed', 'Completed')`),
    // Fee payments only — see the matching comment in /api/leads. Reimbursement
    // money, once received, must stay out of this or Outstanding goes
    // negative by the reimbursed amount even though nothing is actually owed.
    pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'received' AND type = 'payment'`),
    pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE type = 'client_reimbursement' AND status = 'due'`),
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
  const totalReimbursementDue = Number(dueReimbursementRes.rows[0].total);
  const stageCounts = {};
  stageCountsRes.rows.forEach((r) => { stageCounts[r.stage] = Number(r.c); });

  const money = canSeeMoney(req.user);
  const sm = (rows) => rows.map((l) => stripLeadMoney(l, req.user));
  res.json({
    upcomingEvents: sm(upcomingRes.rows),
    upcomingEventsCount: Number(upcomingCountRes.rows[0].c),
    pendingFollowUps: sm(followUpsRes.rows),
    tasksDueSoon: tasksRes.rows,
    newLeadsCount: Number(newLeadsRes.rows[0].c),
    tentativeBookings: sm(tentativeRes.rows),
    interestedLeads: sm(interestedRes.rows),
    outstanding: money ? totalQuoted - totalReceived + totalReimbursementDue : 0,
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

// A lead that's still undecided (New/Follow-up/Interested — never actually
// booked) with an event date 2 days away or closer just isn't realistic to
// pull off anymore, so auto-close it as Not Interested rather than let it
// linger in the active pipeline. Deliberately excludes Tentative — that
// stage means a date is already provisionally held for them, so it needs a
// human call rather than a silent auto-close. Runs at boot and hourly.
async function autoCloseNearDateLeads() {
  try {
    const cutoff = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT id, name, date, stage FROM leads WHERE stage IN ('New', 'Follow-up', 'Interested') AND date <= $1`,
      [cutoff]
    );
    for (const lead of rows) {
      const autoNote = `[Auto] Moved to Not Interested — event date (${lead.date}) is 2 days away or closer and it never progressed past ${lead.stage}.`;
      await pool.query(
        `UPDATE leads SET stage = 'Not Interested', not_interested_reason = COALESCE(not_interested_reason, 'Went cold — date passed without progress'), notes = CASE WHEN notes IS NULL OR notes = '' THEN $1 ELSE $1 || chr(10) || notes END WHERE id = $2`,
        [autoNote, lead.id]
      );
      logActivity({ user: null }, `${lead.name}: ${lead.stage} → Not Interested (auto — event date imminent, never confirmed)`, lead.id);
    }
  } catch (err) {
    console.error("autoCloseNearDateLeads failed:", err.message);
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

// Railway blocks outbound SMTP, so mail goes through Resend's HTTPS API when RESEND_API_KEY is set,
// with SMTP only as a fallback. Attachments: [{ filename, content: Buffer }].
async function sendMailSmart({ to, subject, text, attachments = [] }) {
  const errs = [];
  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch(process.env.RESEND_API_URL || "https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || "Together Out Loud <onboarding@resend.dev>",
          to: Array.isArray(to) ? to : [to], subject, text,
          attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64") })),
        }),
      });
      if (r.ok) return "resend";
      errs.push(`Resend: ${r.status} ${(await r.text()).slice(0, 200)}`);
    } catch (e) { errs.push(`Resend: ${e.message}`); }
  }
  const transport = getMailTransport();
  if (transport) {
    try {
      await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, attachments });
      return "smtp";
    } catch (e) { errs.push(`SMTP: ${e.message}`); }
  }
  throw new Error(errs.length ? errs.join(" | ") : "Email isn't configured (set RESEND_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS).");
}

async function sendNewLeadEmail(lead) {
  if (!process.env.RESEND_API_KEY && !getMailTransport()) return; // email not configured — the in-app notification still covers it
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
  await sendMailSmart({
    to,
    subject: `New query — ${lead.name} (${packageName(lead.event_type)})`,
    text: lines.join("\n"),
  });
}

async function sendBackupEmail(recipient) {
  const to = recipient || process.env.BACKUP_EMAIL || "togetheroutloudclub@gmail.com";
  if (!to) throw new Error("No recipient email configured.");
  const buffer = await buildBackupWorkbook();
  const today = new Date().toISOString().slice(0, 10);
  const attachments = [{ filename: `tol-backup-${today}.xlsx`, content: buffer }];
  // The complete, restorable copy (every table; uploaded files left out here to keep the email small).
  try {
    const full = await buildFullBackup(pool, { includeFiles: false });
    if (full.length < 15 * 1024 * 1024) attachments.push({ filename: `tol-full-backup-${today}.json.gz`, content: full });
  } catch (err) { console.error("Full backup attachment skipped:", err.message); }
  await sendMailSmart({
    to,
    subject: `Together, Out Loud — data backup (${today})`,
    text: "Attached: a spreadsheet of leads, payments, expenses, team, quotes, assignments, tasks and activity, plus the full restorable backup (.json.gz) with every table.",
    attachments,
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

// Everything, including uploaded files — restorable with scripts/restore-backup.js.
app.get("/api/admin/backup/full", requireAuth, requireAdmin, async (req, res) => {
  try {
    const buffer = await buildFullBackup(pool, { includeFiles: true });
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="tol-full-backup-${today}.json.gz"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/snapshots", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, created_at, commit_sha, size_bytes FROM data_snapshots ORDER BY id DESC");
    res.json(rows);
  } catch { res.json([]); }
});
app.get("/api/admin/snapshots/:id/download", requireAuth, requireAdmin, async (req, res) => {
  const row = (await pool.query("SELECT created_at, data FROM data_snapshots WHERE id = $1", [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: "Snapshot not found" });
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="tol-snapshot-${row.created_at.slice(0, 10)}-${req.params.id}.json.gz"`);
  res.send(row.data);
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
  autoCloseNearDateLeads();
  setInterval(autoCloseNearDateLeads, 60 * 60 * 1000);
  runMonthlyBackupCheck();
  setInterval(runMonthlyBackupCheck, 60 * 60 * 1000);
  // Pre-warm the map's geocode cache in the background right after startup,
  // rather than waiting for the first visitor to trigger it. A cold cache
  // (e.g. right after a migration clears it) can take 20-30s+ to resolve
  // serially against Nominatim's rate limit — long enough that a visitor's
  // browser gives up before it finishes, and the map silently never
  // appears even though the data resolves fine moments later.
  buildEventLocationsData()
    .then((data) => { eventLocationsCache = { data, fetchedAt: Date.now() }; })
    .catch((err) => console.error("Startup map cache warm-up failed (will retry on first request):", err.message));
});
