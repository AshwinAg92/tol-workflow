// ---------- State ----------
let CURRENT_USER = null;
let CONFIG = { stages: [], packages: [], addons: [] };
let MESSAGE_TEMPLATES = {};
let LEADS = [];
let TEAM = [];
let TASKS = [];
let currentTab = "dashboard";
let leadsFilter = "all";
let leadsStageFilter = "all";
let leadsSearch = "";
let leadsDateFilter = "";
let quotationLeadId = null;
let calYear = new Date().getFullYear(), calMonth = new Date().getMonth() + 1; // defaults to the real current month

const STAGE_COLOR = {
  New: "#8A8578",
  Quoted: "#C1602B",
  "Follow-up": "#B6752C",
  Interested: "#4A8FA6",
  Tentative: "#9B6EA8",
  Confirmed: "#5C8A6B",
  Completed: "#2E5C63",
  "Not Interested": "#A8A296",
  Cancelled: "#A64B3C",
};

const NAV = [
  { id: "dashboard", label: "Dashboard" },
  { id: "leads", label: "Leads" },
  { id: "quotation", label: "Quotation" },
  { id: "tasks", label: "Tasks & Chats" },
  { id: "documents", label: "Documents" },
  { id: "calendar", label: "Calendar" },
  { id: "team", label: "Team" },
  { id: "accounts", label: "Accounts" },
  { id: "website", label: "Website" },
  { id: "settings", label: "Settings" },
];
// "settings" and "website" are admin-only (handled directly in renderNav) and aren't
// something a manager can be granted piecemeal, so they're excluded from the staff permission checklist.
const PERMISSION_SECTIONS = NAV.filter((n) => n.id !== "dashboard" && n.id !== "settings" && n.id !== "website");

// Fills a {placeholder} template with values — any placeholder with no matching value
// is left as an empty string rather than showing the raw {token} in the sent message.
function fillTemplate(tpl, vars) {
  return (tpl || "").replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined && vars[key] !== null ? vars[key] : ""));
}

function canAssignTeam() {
  if (!CURRENT_USER) return false;
  if (CURRENT_USER.accessLevel === "admin") return true;
  if (CURRENT_USER.accessLevel !== "staff") return false;
  return !Array.isArray(CURRENT_USER.permissions) || CURRENT_USER.permissions.includes("assign_team");
}

function canManageTeam() {
  if (!CURRENT_USER) return false;
  if (CURRENT_USER.accessLevel === "admin") return true;
  if (CURRENT_USER.accessLevel !== "staff") return false;
  return !Array.isArray(CURRENT_USER.permissions) || CURRENT_USER.permissions.includes("manage_team");
}

function hasLeadsAccess() {
  if (!CURRENT_USER) return false;
  if (CURRENT_USER.accessLevel === "admin") return true;
  if (CURRENT_USER.accessLevel !== "staff") return false;
  return !Array.isArray(CURRENT_USER.permissions) || CURRENT_USER.permissions.includes("leads");
}

function hasAccountsAccess() {
  if (!CURRENT_USER) return false;
  if (CURRENT_USER.accessLevel === "admin") return true;
  if (CURRENT_USER.accessLevel !== "staff") return false;
  return !Array.isArray(CURRENT_USER.permissions) || CURRENT_USER.permissions.includes("accounts");
}

function permissionsChecklistHtml(idPrefix, currentPermissions) {
  // A manager (staff, not a true admin) can't grant access broader than their own —
  // disable those checkboxes so it's visually clear, matching the backend's rejection.
  const actingAsManager = CURRENT_USER?.accessLevel === "staff";
  const ownPerms = actingAsManager && Array.isArray(CURRENT_USER.permissions) ? CURRENT_USER.permissions : null;
  const disabledAttr = (id) => (ownPerms && !ownPerms.includes(id)) ? "disabled" : "";

  // undefined (new member) defaults to excluding Accounts; null (existing, unrestricted)
  // shows everything checked since that's their real current access; an array is explicit.
  const sectionsHtml = PERMISSION_SECTIONS.map((s) => {
    let checked;
    if (Array.isArray(currentPermissions)) checked = currentPermissions.includes(s.id);
    else if (currentPermissions === null) checked = true;
    else checked = s.id !== "accounts";
    return `<label class="check-row"><input type="checkbox" class="${idPrefix}-perm" value="${s.id}" ${checked ? "checked" : ""} ${disabledAttr(s.id)} /> ${s.label}</label>`;
  }).join("");
  let assignChecked;
  if (Array.isArray(currentPermissions)) assignChecked = currentPermissions.includes("assign_team");
  else if (currentPermissions === null) assignChecked = true;
  else assignChecked = false; // operational capability — off by default for new staff, unlike most sections
  let manageChecked;
  if (Array.isArray(currentPermissions)) manageChecked = currentPermissions.includes("manage_team");
  else if (currentPermissions === null) manageChecked = true;
  else manageChecked = false;
  const capabilityHtml = `
    <div class="muted small" style="margin-top:8px; margin-bottom:2px;">Operational permissions</div>
    <label class="check-row"><input type="checkbox" class="${idPrefix}-perm" value="assign_team" ${assignChecked ? "checked" : ""} ${disabledAttr("assign_team")} /> Assign artists to confirmed events</label>
    <label class="check-row"><input type="checkbox" class="${idPrefix}-perm" value="manage_team" ${manageChecked ? "checked" : ""} ${disabledAttr("manage_team")} /> Can add new team members and edit existing ones</label>
    <p class="muted small" style="margin:-4px 0 6px 26px;">They can never create/edit an Admin, and can never hand out access beyond what they themselves have.</p>
  `;
  return sectionsHtml + capabilityHtml;
}

// ---------- Helpers ----------
const inr = (n) => (n == null ? "—" : "₹" + Number(n).toLocaleString("en-IN"));
const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
const fmtDateTime = (d) => d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const fmtTime = (d) => d ? new Date(d).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—";
// Formats a plain "HH:MM" string (from an <input type="time">, not a full date) into 12-hour display.
const fmtTimeHM = (hm) => {
  if (!hm) return "—";
  const [h, m] = hm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
};
const packageName = (id) => id === "both" ? "Bhajan Jamming & Musical Pheras (Both)" : (CONFIG.packages.find((p) => p.id === id)?.name || id);

const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; };

// ---------- PDF generation (logo + letterhead, used by both Ledger and Quotation) ----------
let _logoDataUrl = null;
function loadLogoDataUrl() {
  if (_logoDataUrl) return Promise.resolve(_logoDataUrl);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext("2d").drawImage(img, 0, 0);
      _logoDataUrl = canvas.toDataURL("image/png");
      resolve(_logoDataUrl);
    };
    img.onerror = () => resolve(null); // PDF still works without the logo if it fails to load
    img.src = "/logo.png";
  });
}

// jsPDF's built-in fonts (helvetica/times/courier) don't include the ₹ glyph —
// it silently renders as a broken superscript character. "Rs." is the safe
// substitute for anything going into a PDF; the web UI still uses real ₹ (inr()).
const inrPdf = (n) => (n == null ? "—" : "Rs. " + Number(n).toLocaleString("en-IN"));

const PDF_COLORS = {
  navy: [27, 31, 42],
  gold: [201, 139, 61],
  cream: [241, 236, 227],
  card: [251, 249, 245],
  muted: [138, 133, 120],
  dark: [42, 38, 32],
  green: [92, 138, 107],
  red: [166, 75, 60],
  line: [222, 212, 192],
  rust: [193, 68, 26],
  rustDark: [163, 54, 18],
  brown: [107, 47, 15],
  peach: [253, 240, 227],
};

// ---------- Shared letterhead helpers (jsPDF uses mm as the default unit) ----------
async function pdfLetterhead(doc, title, subtitle) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 14;
  const logo = await loadLogoDataUrl();
  if (logo) {
    try { doc.addImage(logo, "PNG", marginX, 10, 22, 22); } catch { /* skip logo if it fails */ }
  }
  const textX = logo ? marginX + 26 : marginX;
  doc.setTextColor(...PDF_COLORS.rust);
  doc.setFont("times", "bold");
  doc.setFontSize(24);
  doc.text(title, textX, 20);
  doc.setFont("times", "italic");
  doc.setFontSize(11.5);
  doc.setTextColor(...PDF_COLORS.dark);
  doc.text(subtitle, textX, 28);
  doc.setDrawColor(...PDF_COLORS.rust);
  doc.setLineWidth(0.6);
  doc.line(marginX, 32, pageWidth - marginX, 32);
  doc.setTextColor(...PDF_COLORS.dark);
  return { pageWidth, marginX };
}

// Even-width row of small dot-labelled fields (e.g. Location / Date / Guests / Duration).
function pdfInfoRow(doc, cols, marginX, contentW, y) {
  const colW = contentW / cols.length;
  cols.forEach(([label, value], i) => {
    const cx = marginX + i * colW;
    doc.setFillColor(...PDF_COLORS.rust);
    doc.circle(cx + 1.3, y + 1.7, 1.3, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.setTextColor(...PDF_COLORS.muted);
    doc.text(label.toUpperCase(), cx + 5, y + 3);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...PDF_COLORS.dark);
    const wrapped = doc.splitTextToSize(value || "—", colW - 6);
    wrapped.forEach((ln, j) => doc.text(ln, cx + 5, y + 8 + j * 4.3));
  });
  return y + 18;
}

// Rounded, filled section header bar with centered white bold text.
function pdfHeaderBar(doc, text, x, y, w, color) {
  doc.setFillColor(...color);
  doc.roundedRect(x, y, w, 8, 1.5, 1.5, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(255, 255, 255);
  doc.text(text.toUpperCase(), x + w / 2, y + 5.5, { align: "center" });
  doc.setTextColor(...PDF_COLORS.dark);
  return y + 12;
}

function pdfList(doc, items, x, w, y, { bulletColor = PDF_COLORS.rust, numbered = false, size = 8.5 } = {}) {
  doc.setFontSize(size);
  items.forEach((item, i) => {
    const bullet = numbered ? `${i + 1}.` : "•";
    const wrapped = doc.splitTextToSize(item, w - 7);
    if (y + wrapped.length * 4.7 > 280) { doc.addPage(); y = 20; }
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...bulletColor);
    doc.text(bullet, x, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...PDF_COLORS.dark);
    wrapped.forEach((ln, j) => doc.text(ln, x + 6, y + j * 4.7));
    y += wrapped.length * 4.7 + 2;
  });
  return y;
}

function pdfWarmClosing(doc, pageWidth, text, y) {
  if (y > 265) { doc.addPage(); y = 30; }
  doc.setDrawColor(...PDF_COLORS.line);
  doc.setLineWidth(0.3);
  doc.line(14, y, pageWidth - 14, y);
  y += 8;
  doc.setFont("times", "italic");
  doc.setFontSize(10);
  doc.setTextColor(...PDF_COLORS.rust);
  doc.splitTextToSize(text, pageWidth - 28).forEach((ln) => { doc.text(ln, pageWidth / 2, y, { align: "center" }); y += 5.5; });
  y += 4;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...PDF_COLORS.dark);
  doc.text("Warmly,", pageWidth / 2, y, { align: "center" });
  y += 5;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Together, Out Loud", pageWidth / 2, y, { align: "center" });
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...PDF_COLORS.muted);
  doc.text("Instagram: instagram.com/togetheroutloudclub", pageWidth / 2, y, { align: "center" });
}

async function downloadLedgerPDF(booking, payments) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const { pageWidth, marginX } = await pdfLetterhead(doc, "PAYMENT LEDGER", "Together, Out Loud");
  const contentW = pageWidth - marginX * 2;
  let y = 40;

  const total = booking.final_amount || booking.quote_amount || 0;
  const received = payments.reduce((s, p) => s + p.amount, 0);
  const balance = total - received;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(...PDF_COLORS.dark);
  doc.text(`Dear ${(booking.name || "").split(" ")[0] || "there"},`, marginX, y);
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.3);
  const intro = doc.splitTextToSize(`Thank you for being part of the Together, Out Loud family. Here is the current payment record for your event on ${fmtDate(booking.date)}${booking.city ? ` in ${booking.city}` : ""}.`, contentW);
  doc.text(intro, marginX, y);
  y += intro.length * 5 + 4;

  y = pdfInfoRow(doc, [
    ["Event", packageName(booking.event_type)],
    ["Date", fmtDate(booking.date)],
    ["Location", booking.city || "—"],
  ], marginX, contentW, y);
  doc.setDrawColor(...PDF_COLORS.line);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 9;

  const boxW = (contentW - 8) / 3;
  [
    ["AMOUNT CONFIRMED", inrPdf(total), PDF_COLORS.dark, PDF_COLORS.line],
    ["RECEIVED", inrPdf(received), PDF_COLORS.green, PDF_COLORS.line],
    ["BALANCE DUE", inrPdf(balance), PDF_COLORS.rustDark, balance > 0 ? PDF_COLORS.rust : PDF_COLORS.line],
  ].forEach(([label, value, color, borderColor], i) => {
    const bx = marginX + i * (boxW + 4);
    doc.setFillColor(...PDF_COLORS.card);
    doc.setDrawColor(...borderColor);
    doc.setLineWidth(0.5);
    doc.roundedRect(bx, y, boxW, 24, 2, 2, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.6);
    doc.setTextColor(...PDF_COLORS.muted);
    doc.text(label, bx + 5, y + 9);
    doc.setFontSize(14);
    doc.setTextColor(...color);
    doc.text(value, bx + 5, y + 19);
  });
  y += 24 + 12;

  y = pdfHeaderBar(doc, "Payments Received", marginX, y, contentW, PDF_COLORS.rust);
  doc.setFillColor(...PDF_COLORS.card);
  doc.rect(marginX, y - 5, contentW, 7, "F");
  doc.setDrawColor(...PDF_COLORS.rust);
  doc.setLineWidth(0.4);
  doc.line(marginX, y + 3, pageWidth - marginX, y + 3);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...PDF_COLORS.muted);
  doc.text("DATE", marginX + 4, y);
  doc.text("AMOUNT", marginX + contentW * 0.4, y);
  doc.text("MODE", marginX + contentW * 0.7, y);
  y += 8;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.3);
  if (payments.length === 0) {
    doc.setTextColor(...PDF_COLORS.muted);
    doc.text("No payments recorded yet.", marginX + 4, y);
    y += 7;
  } else {
    payments.forEach((p, i) => {
      if (i % 2 === 1) { doc.setFillColor(248, 240, 230); doc.rect(marginX, y - 5, contentW, 7, "F"); }
      doc.setTextColor(...PDF_COLORS.dark);
      doc.text(fmtDate(p.payment_date), marginX + 4, y);
      doc.text(inrPdf(p.amount), marginX + contentW * 0.4, y);
      doc.text(p.payment_mode || "—", marginX + contentW * 0.7, y);
      y += 7;
    });
  }
  y += 6;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8.3);
  doc.setTextColor(...PDF_COLORS.muted);
  doc.text("Generated on " + fmtDate(new Date().toISOString().slice(0, 10)), marginX, y);
  y += 14;

  pdfWarmClosing(doc, pageWidth, "We look forward to creating a memorable, soul-stirring experience with you.", y);

  const filename = `Ledger-${booking.name.replace(/[^a-z0-9]/gi, "-")}.pdf`;
  doc.save(filename);
  return filename;
}

// fields: { format, location, eventDate, guests, duration, pcs, formatType, charges }
async function downloadQuotePDF({ clientName, date, fields }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const isPheras = (fields.format || "").trim().toLowerCase() === "musical pheras";
  const { pageWidth, marginX } = await pdfLetterhead(doc, "QUOTATION", `For ${fields.format || ""} — Together, Out Loud`);
  const contentW = pageWidth - marginX * 2;
  let y = 40;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(...PDF_COLORS.dark);
  doc.text(`Dear ${(clientName || "").split(" ")[0] || "there"},`, marginX, y);
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.3);
  const intro = doc.splitTextToSize("Thank you for considering us for your event — here are the details of our offering.", contentW);
  doc.text(intro, marginX, y);
  y += intro.length * 5 + 4;

  y = pdfInfoRow(doc, [
    ["Location", fields.location], ["Date", fields.eventDate], ["Guests", fields.guests],
    ...(isPheras ? [] : [["Duration", fields.duration]]),
  ], marginX, contentW, y);
  doc.setDrawColor(...PDF_COLORS.line);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 9;

  y = pdfHeaderBar(doc, "Performance Details", marginX, y, contentW, PDF_COLORS.rust);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.3);
  doc.setTextColor(...PDF_COLORS.dark);
  doc.text(`•  Pcs (No. of Musicians): ${fields.pcs || "—"}`, marginX + 4, y);
  y += 6;
  if (!isPheras) {
    doc.text(`•  Format: ${fields.formatType || "—"}`, marginX + 4, y);
    y += 4;
  }
  y += 6;

  doc.setFillColor(...PDF_COLORS.card);
  doc.setDrawColor(...PDF_COLORS.rust);
  doc.setLineWidth(0.5);
  doc.roundedRect(marginX, y, contentW, 13, 2, 2, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(...PDF_COLORS.muted);
  doc.text("PERFORMANCE CHARGES", marginX + 6, y + 8.5);
  doc.setFontSize(13.5);
  doc.setTextColor(...PDF_COLORS.rustDark);
  doc.text(fields.charges ? inrPdf(fields.charges) + "/-" : "To be confirmed", pageWidth - marginX - 6, y + 8.5, { align: "right" });
  doc.setTextColor(...PDF_COLORS.dark);
  y += 22;

  y = pdfHeaderBar(doc, "Session Conditions", marginX, y, contentW, PDF_COLORS.brown);
  const sessionConditionItems = ["No food, alcohol, or beverages to be consumed or served during the session."];
  if (!isPheras) sessionConditionItems.push("Session duration will be 75 to 90 minutes.");
  y = pdfList(doc, sessionConditionItems, marginX + 4, contentW - 4, y, { numbered: true, bulletColor: PDF_COLORS.brown, size: 9 });
  y += 4;

  const halfW = (contentW - 6) / 2;
  const x1 = marginX, x2 = marginX + halfW + 6;
  const secTop = y;
  pdfHeaderBar(doc, "Exclusions", x1, secTop, halfW, PDF_COLORS.rustDark);
  pdfHeaderBar(doc, "Terms", x2, secTop, halfW, PDF_COLORS.rust);
  const y1 = pdfList(doc, [
    "Stage Setup", "Lights & Sound",
    "Travel, Accommodation (from previous city of performance — informed 2 months prior)",
    "Food for the Team (all meals)", "Airport/Station Transfers",
  ], x1 + 3, halfW - 6, secTop + 13, { bulletColor: PDF_COLORS.rustDark, size: 8 });
  const y2 = pdfList(doc, [
    "An advance payment is required to confirm and block the date — booking is confirmed only upon receipt.",
    "This quotation is valid for 7 days from the date of issue; charges are subject to revision after.",
    "Strictly no food or beverages during the session.",
  ], x2 + 3, halfW - 6, secTop + 13, { bulletColor: PDF_COLORS.rust, size: 8 });
  y = Math.max(y1, y2) + 8;

  if (y > 250) { doc.addPage(); y = 20; }
  y = pdfHeaderBar(doc, "Experience We Offer", marginX, y, contentW, PDF_COLORS.rustDark);
  const experiences = ["Musical Pheras", "Bhajan Jamming", "Devotional Satsang", "Shraddhanjali Satsang"];
  const expW = (contentW - 6) / experiences.length;
  experiences.forEach((name, i) => {
    const ex = marginX + i * (expW + 2);
    doc.setFillColor(...PDF_COLORS.card);
    doc.setDrawColor(...PDF_COLORS.line);
    doc.setLineWidth(0.4);
    doc.roundedRect(ex, y, expW, 16, 1.5, 1.5, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.6);
    doc.setTextColor(...PDF_COLORS.dark);
    doc.splitTextToSize(name, expW - 4).forEach((ln, j) => doc.text(ln, ex + expW / 2, y + 7 + j * 4, { align: "center" }));
  });
  y += 22;

  pdfWarmClosing(doc, pageWidth, "We'd love to make your event a truly memorable, soul-stirring experience.", y);

  const filename = `Quotation-${(clientName || "client").replace(/[^a-z0-9]/gi, "-")}.pdf`;
  doc.save(filename);
  return filename;
}



async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers || {}) },
  });
  if (!res.ok) {
    let message = "Request failed";
    try { message = (await res.json()).error || message; } catch { /* body wasn't JSON */ }
    throw new Error(message);
  }
  if (res.status === 204) return null; // no body to parse (e.g. DELETE responses)
  return res.json();
}

async function loadAll() {
  [CONFIG, LEADS, TEAM, TASKS, MESSAGE_TEMPLATES] = await Promise.all([
    api("/api/config"),
    api("/api/leads"),
    api("/api/team"),
    api("/api/tasks"),
    api("/api/message-templates"),
  ]);
}

async function refreshLeads() {
  LEADS = await api("/api/leads");
}

async function refreshTasks() {
  TASKS = await api("/api/tasks");
}

// ---------- Nav ----------
function renderNav() {
  const nav = document.getElementById("nav");
  nav.innerHTML = "";
  const perms = CURRENT_USER?.accessLevel === "staff" ? CURRENT_USER.permissions : null;
  let visibleNav = NAV.filter((n) => {
    if (n.id === "settings" || n.id === "website") return CURRENT_USER?.accessLevel === "admin";
    return n.id === "dashboard" || !Array.isArray(perms) || perms.includes(n.id);
  });
  if (CURRENT_USER?.isPerformer && CURRENT_USER.accessLevel !== "performer") {
    visibleNav = [visibleNav[0], { id: "myevents", label: "My Events" }, ...visibleNav.slice(1)];
  }
  if (!visibleNav.some((n) => n.id === currentTab)) currentTab = "dashboard";
  visibleNav.forEach(({ id, label }) => {
    const btn = el(`<button class="nav-item${currentTab === id ? " nav-item-active" : ""}">${label}</button>`);
    btn.addEventListener("click", () => {
      currentTab = id;
      renderNav();
      renderMain();
      closeMobileSidebar();
    });
    nav.appendChild(btn);
  });
  document.getElementById("sidebarFoot").innerHTML = `
    <div>${CURRENT_USER ? `${CURRENT_USER.name || CURRENT_USER.username} <span class="muted">(${CURRENT_USER.accessLevel})</span>` : ""}</div>
    <a href="#" id="logoutLink" style="color:#C1602B;">Log out</a>
  `;
  const logoutLink = document.getElementById("logoutLink");
  if (logoutLink) logoutLink.addEventListener("click", (e) => { e.preventDefault(); handleLogout(); });
}

// ---------- Mobile sidebar toggle ----------
function closeMobileSidebar() {
  document.getElementById("sidebar")?.classList.remove("sidebar-open");
  document.getElementById("sidebarOverlay")?.classList.remove("active");
}
function initMobileNav() {
  const menuBtn = document.getElementById("mobileMenuBtn");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  menuBtn?.addEventListener("click", () => {
    sidebar.classList.add("sidebar-open");
    overlay.classList.add("active");
  });
  overlay?.addEventListener("click", closeMobileSidebar);
}

// Clicking the logo (sidebar brand block, or mobile topbar logo/name) always jumps to the Dashboard.
function initLogoNav() {
  const goToDashboard = () => {
    currentTab = "dashboard";
    renderNav();
    renderMain();
    closeMobileSidebar();
  };
  document.querySelector(".sidebar .brand")?.addEventListener("click", goToDashboard);
  document.querySelector(".mobile-topbar .brand-mark")?.addEventListener("click", goToDashboard);
  document.querySelector(".mobile-topbar .brand-name")?.addEventListener("click", goToDashboard);
}

// Jump from a dashboard card straight to the matching filtered Leads list.
function goToLeads(stage) {
  leadsFilter = "all";
  leadsStageFilter = stage;
  currentTab = "leads";
  renderNav();
  renderMain();
}

// ---------- Leads log ----------
async function renderLeadsLog(main, skipRefresh) {
  // LEADS is only otherwise updated after specific actions (adding/editing/
  // deleting a lead, etc.) -- if a new query comes in from the public form
  // while this tab is just sitting open in memory, it wouldn't show up until
  // something else happened to trigger a refresh. Always refresh when the tab
  // is first opened so this is never stale -- but NOT on every keystroke while
  // searching/filtering (skipRefresh=true), since that turned every letter
  // typed into a network round-trip and felt like the page was reloading.
  if (!skipRefresh) {
    main.innerHTML = `<div class="view-head"><div><h2>Leads</h2><p class="muted">Every query received, across every format.</p></div></div><p class="muted">Loading…</p>`;
    await refreshLeads();
  }

  const filtered = (leadsFilter === "all" ? LEADS : LEADS.filter((l) => l.event_type === leadsFilter))
    .filter((l) => leadsStageFilter === "all" || l.stage === leadsStageFilter)
    .filter((l) => !leadsSearch || l.name.toLowerCase().includes(leadsSearch.toLowerCase()))
    .filter((l) => !leadsDateFilter || l.date === leadsDateFilter);
  const countFor = (id) => LEADS.filter((l) => l.event_type === id).length;
  const shareLink = `${window.location.origin}/lead-form.html`;

  main.innerHTML = `
    <div class="view-head">
      <div>
        <h2>Leads</h2>
        <p class="muted">Every query received, across every format.</p>
      </div>
      <button class="btn-primary" id="newLeadBtn">+ New lead</button>
    </div>

    <div class="card" style="margin-bottom:18px;">
      <div class="section-label">Share this form with a new query</div>
      <div class="share-box">
        <input readonly value="${shareLink}" id="shareLinkInput" />
        <button class="btn-ghost" id="copyLinkBtn">Copy</button>
      </div>
      <p class="muted small" style="margin-top:8px;">Submissions land here automatically as a new lead in "New".</p>
    </div>

    <div class="card" style="margin-bottom:14px;">
      <div class="upload-form" style="margin-bottom:0;">
        <input id="leadsSearchInput" placeholder="Search by name…" value="${leadsSearch}" style="flex:1; min-width:160px;" />
        <input id="leadsDateInput" type="date" value="${leadsDateFilter}" />
        <select id="leadsStageSelect">
          <option value="all">All stages</option>
          ${CONFIG.stages.map((s) => `<option value="${s}" ${leadsStageFilter === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
        ${(leadsSearch || leadsDateFilter || leadsStageFilter !== "all") ? `<button class="btn-ghost" id="clearAllFilters">Clear filters</button>` : ""}
      </div>
    </div>

    <div class="filter-row" id="filterRow"></div>
    <div id="leadsRows"></div>
  `;

  main.querySelector("#leadsSearchInput").addEventListener("input", (e) => {
    const cursorPos = e.target.selectionStart;
    leadsSearch = e.target.value;
    renderLeadsLog(main, true);
    const newInput = document.querySelector("#leadsSearchInput");
    if (newInput) {
      newInput.focus();
      newInput.setSelectionRange(cursorPos, cursorPos);
    }
  });
  main.querySelector("#leadsDateInput").addEventListener("change", (e) => { leadsDateFilter = e.target.value; renderLeadsLog(main, true); });
  main.querySelector("#leadsStageSelect").addEventListener("change", (e) => { leadsStageFilter = e.target.value; renderLeadsLog(main, true); });
  const clearAllBtn = main.querySelector("#clearAllFilters");
  if (clearAllBtn) clearAllBtn.addEventListener("click", () => { leadsSearch = ""; leadsDateFilter = ""; leadsStageFilter = "all"; renderLeadsLog(main, true); });

  const filterRow = main.querySelector("#filterRow");
  const allChip = el(`<button class="filter-chip${leadsFilter === "all" ? " filter-chip-active" : ""}">All <span class="mono">${LEADS.length}</span></button>`);
  allChip.addEventListener("click", () => { leadsFilter = "all"; renderLeadsLog(main, true); });
  filterRow.appendChild(allChip);

  CONFIG.packages.forEach((p) => {
    const chip = el(`<button class="filter-chip${leadsFilter === p.id ? " filter-chip-active" : ""}">${p.name} <span class="mono">${countFor(p.id)}</span></button>`);
    chip.addEventListener("click", () => { leadsFilter = p.id; renderLeadsLog(main, true); });
    filterRow.appendChild(chip);
  });

  const rows = main.querySelector("#leadsRows");
  const sorted = filtered.slice().sort((a, b) => {
    if (leadsStageFilter === "Follow-up") return new Date(b.created_at) - new Date(a.created_at);
    return new Date(a.date) - new Date(b.date);
  });
  if (sorted.length === 0) {
    rows.innerHTML = `<div class="board-empty">No queries match these filters</div>`;
  } else {
    sorted.forEach((l) => {
      const comboSiblings = l.combo_group_id ? LEADS.filter((s) => s.combo_group_id === l.combo_group_id && s.id !== l.id) : [];
      const comboPrimary = l.combo_group_id ? (l.is_combo_primary ? l : comboSiblings.find((s) => s.is_combo_primary)) : null;
      const displayQuote = comboPrimary ? comboPrimary.quote_amount : l.quote_amount;
      const displayFinal = comboPrimary ? comboPrimary.final_amount : l.final_amount;
      const isConfirmedOrDone = l.stage === "Confirmed" || l.stage === "Completed";
      const displayReceived = comboPrimary ? comboPrimary.received : l.received;
      const balance = (displayFinal || displayQuote || 0) - (displayReceived || 0);
      const card = el(`
        <div class="card lead-card" style="margin-bottom:12px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
            <div>
              <div class="lead-name">${l.name}</div>
              <div class="muted small">${l.phone || ""}</div>
              ${l.combo_group_id ? `<div class="muted small" style="color:#8A5FA8;">🔗 Combo with ${comboSiblings.map((s) => `${packageName(s.event_type)} (${fmtDate(s.date)})`).join(", ")}</div>` : ""}
              ${l.occasion && isConfirmedOrDone ? `<div class="muted small">${l.occasion}</div>` : ""}
              ${l.alt_date ? `<div class="muted small" style="color:#B6752C;">Alt date: ${fmtDate(l.alt_date)}</div>` : ""}
            </div>
            <select class="stage-select" data-lead-id="${l.id}" style="color:${STAGE_COLOR[l.stage]}; flex-shrink:0; width:auto;">
              ${CONFIG.stages.filter((s) => s !== "Completed" || s === l.stage).map((s) => `<option value="${s}" ${s === l.stage ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="muted small" style="margin-top:8px;">${packageName(l.event_type)} · ${l.city || "—"} · <span class="mono">${fmtDate(l.date)}</span></div>
          <div class="muted small">Submitted ${fmtDateTime(l.created_at)}</div>
          ${l.quote_amount && !isConfirmedOrDone ? `<div class="muted small mono" style="margin-top:6px;">Quoted: ${inr(l.quote_amount)}${l.last_quoted_at ? ` <span class="muted">— sent ${fmtDate(l.last_quoted_at.slice(0, 10))}</span>` : ""}</div>` : ""}
          ${l.notes ? `<div class="muted small" style="margin-top:4px; padding:6px 8px; background:#F5F0E4; border-radius:4px;">📝 ${l.notes}</div>` : ""}
          ${l.stage === "Cancelled" && l.cancellation_reason ? `<div class="muted small" style="margin-top:4px; padding:6px 8px; background:#FBEAE7; border-radius:4px; color:#A64B3C;">❌ Cancelled: ${l.cancellation_reason}</div>` : ""}
          ${isConfirmedOrDone ? `
            <div class="lead-card-financials">
              <div><span class="muted small">Final</span><div class="mono">${displayFinal ? inr(displayFinal) : "—"}${comboPrimary && !l.is_combo_primary ? " (combo)" : ""}</div></div>
              <div><span class="muted small">Received</span><div class="mono">${inr(displayReceived || 0)}${comboPrimary && !l.is_combo_primary ? " (combo)" : ""}</div></div>
              <div><span class="muted small">Balance</span><div class="mono" style="color:${balance > 0 ? "#A64B3C" : "#5C8A6B"};">${inr(balance)}</div></div>
            </div>
            ${(l.event_time || l.soundcheck_time) ? `<div class="muted small" style="margin-top:6px;">${l.soundcheck_time ? `SC ${fmtTimeHM(l.soundcheck_time)}` : ""}${l.soundcheck_time && l.event_time ? " · " : ""}${l.event_time ? `Event ${fmtTimeHM(l.event_time)}` : ""}</div>` : ""}
            ${l.venue ? `<div class="muted small">📍 ${l.venue}</div>` : ""}
          ` : ""}
          <div class="lead-card-actions">
            ${l.stage === "New" || l.stage === "Follow-up" || l.stage === "Interested" || l.stage === "Tentative" ? `<button class="btn-ghost quote-lead-btn" data-lead-id="${l.id}">Quote</button>` : ""}
            ${(l.stage === "New" || l.stage === "Follow-up" || l.stage === "Interested" || l.stage === "Tentative") && l.phone ? `<button class="btn-ghost followup-btn" data-lead-id="${l.id}">💬 Follow up</button>` : ""}
            ${isConfirmedOrDone && hasAccountsAccess() ? `<button class="btn-ghost payments-btn" data-lead-id="${l.id}">💰 Payments</button>` : ""}
            ${isConfirmedOrDone && hasLeadsAccess() ? `<button class="btn-ghost confirmation-msg-btn" data-lead-id="${l.id}">✅ Confirmation msg</button>` : ""}
            ${isConfirmedOrDone && canAssignTeam() ? `<button class="btn-ghost assign-team-btn" data-lead-id="${l.id}">Team</button>` : ""}
            ${hasLeadsAccess() && l.stage !== "Completed" ? `<button class="btn-ghost edit-lead-btn" data-lead-id="${l.id}">✎ Edit</button>` : ""}
            ${CURRENT_USER?.accessLevel === "admin" && l.stage !== "Completed" ? `<button class="btn-ghost delete-lead-btn" data-lead-id="${l.id}" data-lead-name="${l.name}" style="color:#A64B3C;">🗑 Delete</button>` : ""}
            ${l.stage === "Completed" ? `<span class="muted small">🔒 Completed — locked</span>` : ""}
          </div>
        </div>
      `);
      rows.appendChild(card);
    });
  }

  main.querySelectorAll(".quote-lead-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      quotationLeadId = btn.dataset.leadId;
      currentTab = "quotation";
      renderNav();
      renderMain();
    });
  });

  main.querySelectorAll(".followup-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lead = LEADS.find((l) => l.id === btn.dataset.leadId);
      const firstName = (lead.name || "").split(" ")[0] || "there";
      const key = lead.stage === "Tentative" ? "tentative_followup" : "followup";
      const tpl = MESSAGE_TEMPLATES[key] || TEMPLATE_META[key].default;
      const msg = fillTemplate(tpl, {
        firstName,
        experience: packageName(lead.event_type),
        dateClause: lead.date ? ` on ${fmtDate(lead.date)}` : "",
      });
      const digitsOnly = (lead.whatsapp_number || lead.phone || "").replace(/\D/g, "");
      if (digitsOnly) window.open(`https://wa.me/${digitsOnly}?text=${encodeURIComponent(msg)}`, "_blank");
    });
  });

  main.querySelectorAll(".assign-team-btn").forEach((btn) => {
    btn.addEventListener("click", () => openAssignTeamModal(btn.dataset.leadId));
  });

  main.querySelectorAll(".payments-btn").forEach((btn) => {
    btn.addEventListener("click", () => openLeadPaymentsModal(btn.dataset.leadId));
  });

  main.querySelectorAll(".confirmation-msg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lead = LEADS.find((l) => l.id === btn.dataset.leadId);
      if (lead) openConfirmationMessageModal(lead);
    });
  });

  main.querySelectorAll(".edit-lead-btn").forEach((btn) => {
    btn.addEventListener("click", () => openEditLeadModal(btn.dataset.leadId));
  });

  main.querySelectorAll(".delete-lead-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.leadName;
      if (!confirm(`Permanently delete "${name}" and everything tied to it — tasks, documents, expenses, payments, quotes, team assignments? This cannot be undone.`)) return;
      if (!confirm(`Are you absolutely sure you want to delete "${name}"? This is your last chance to cancel.`)) return;
      btn.disabled = true;
      try {
        await api(`/api/leads/${btn.dataset.leadId}`, { method: "DELETE" });
        await refreshLeads();
        renderMain();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });

  main.querySelectorAll(".stage-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const leadId = sel.dataset.leadId;
      const newStage = sel.value;
      const lead = LEADS.find((l) => l.id === leadId);
      // Completed events are locked — the only thing the server allows is
      // moving the stage away from Completed, alone, to "reopen" it. Route
      // that as a plain single-field PATCH rather than the full Confirm
      // modal (which sends stage+finalAmount+date together and would be
      // rejected as an edit attempt on a locked record).
      if (lead.stage === "Completed" && newStage !== "Completed") {
        if (!confirm(`Reopen "${lead.name}" by moving it back to ${newStage}? You can re-confirm it properly afterward if needed.`)) {
          renderMain();
          return;
        }
        sel.disabled = true;
        try {
          await api(`/api/leads/${leadId}`, { method: "PATCH", body: JSON.stringify({ stage: newStage }) });
          await refreshLeads();
          renderMain();
        } catch (err) {
          alert(err.message);
          renderMain();
        }
        return;
      }
      if (newStage === "Confirmed" && lead.stage !== "Confirmed") {
        openConfirmEventModal(lead);
        return;
      }
      let cancellationReason;
      if (newStage === "Cancelled" && lead.stage !== "Cancelled") {
        cancellationReason = prompt(`Why is "${lead.name}" being cancelled? (This is shared with any artists already assigned, and kept on record.)`);
        if (cancellationReason === null) {
          // They backed out of the prompt — don't change the stage at all.
          renderMain();
          return;
        }
      }
      sel.disabled = true;
      try {
        await api(`/api/leads/${leadId}`, {
          method: "PATCH",
          body: JSON.stringify({
            stage: newStage,
            ...(cancellationReason !== undefined ? { cancellation_reason: cancellationReason || null } : {}),
          }),
        });
        await refreshLeads();
        renderMain();
      } catch (err) {
        alert(err.message);
        renderMain();
      }
    });
  });

  main.querySelector("#newLeadBtn").addEventListener("click", openNewLeadModal);
  main.querySelector("#copyLinkBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(shareLink);
    const btn = main.querySelector("#copyLinkBtn");
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });
}

// ---------- Quotation ----------
// Fully self-service: Ashwin fills a few fields, hits "Generate", gets an
// editable draft in the exact wording he uses, tweaks anything he wants,
// then sends via WhatsApp/email. No code change ever needed to adjust
// wording, amount, or format — the textarea is the source of truth.
function buildQuoteText({ eventType, format, location, date, guests, duration, setPieces, formatType, charges, firstName }) {
  const amountLine = charges ? `₹${Number(charges).toLocaleString("en-IN")}/-` : "________";
  const isPheras = (format || "").trim().toLowerCase() === "musical pheras";
  const sessionConditions = isPheras
    ? `1️⃣ No food, alcohol, or beverages to be consumed or served during the session.`
    : `1️⃣ No food, alcohol, or beverages to be consumed or served during the session.
2️⃣ Session duration will be 75 to 90 minutes.`;
  const fallback = `🎶 *QUOTATION — {formatUpper}*
_Together, Out Loud_

Hi {firstName}! Thank you for considering us for your event — here are the details of our offering. 💛

📍 *Location:* {location}
📅 *Date:* {date}
👥 *Guests:* {guests}
${isPheras ? "" : "⏱️ *Duration:* {duration}\n"}
*PERFORMANCE DETAILS*
🎸 Pcs (No. of Musicians): {setPieces}
${isPheras ? "" : "🎤 Format: {formatType}\n"}💰 *Performance Charges: {amountLine}*

*SESSION CONDITIONS*
{sessionConditions}

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
  const tpl = MESSAGE_TEMPLATES[`quotation_${eventType}`] || fallback;
  return fillTemplate(tpl, {
    formatUpper: (format || "").toUpperCase(),
    location: location || "",
    date: date || "",
    guests: guests || "",
    duration: duration || "75-90 Minutes",
    setPieces: setPieces || "",
    formatType: formatType || "",
    amountLine,
    sessionConditions,
    firstName: firstName || "",
  });
}

async function renderQuotation(main) {
  main.innerHTML = `<div class="view-head"><div><h2>Quotation</h2></div></div><p class="muted">Loading…</p>`;
  await refreshLeads();
  const quotable = LEADS.filter((l) => l.stage !== "Completed");
  const preselect = quotable.find((l) => l.id === quotationLeadId) ? quotationLeadId : (quotable[0]?.id || null);
  quotationLeadId = null; // one-shot — doesn't stick if the user later opens Quotation from the nav

  main.innerHTML = `
    <div class="view-head">
      <div><h2>Quotation</h2><p class="muted">Fill in the details, generate the draft, tweak anything, then send.</p></div>
    </div>
    <div class="quote-grid">
      <div class="card">
        <label>Lead</label>
        <select id="leadSelect">
          ${quotable.map((l) => `<option value="${l.id}" ${l.id === preselect ? "selected" : ""}>${l.name} — ${fmtDate(l.date)}${l.city ? `, ${l.city}` : ""}</option>`).join("")}
        </select>
        <div id="leadContextCard" style="margin:10px 0 4px; padding:10px 12px; background:#F5F0E4; border-radius:6px; font-size:12.5px; display:none;"></div>
        <div class="row-2" style="margin-top:14px;">
          <div><label>Location</label><input id="qLocation" placeholder="e.g. Siliguri" /></div>
          <div><label>Date</label><input id="qDate" placeholder="e.g. 14th September 2026" /></div>
        </div>
        <div class="row-2">
          <div><label>No. of guests</label><input id="qGuests" placeholder="e.g. 80-100" /></div>
          <div id="qDurationWrap"><label>Duration</label><input id="qDuration" value="75-90 Minutes" /></div>
        </div>
        <div class="row-2">
          <div><label>Pcs (No. of Musicians)</label><input id="qSet" type="number" placeholder="e.g. 5" /></div>
          <div id="qFormatTypeWrap"><label>Format</label>
            <select id="qFormatType">
              <option value="Private">Private</option>
              <option value="Public">Public</option>
            </select>
          </div>
        </div>
        <label>Performance charges (₹)</label>
        <input id="qCharges" type="number" placeholder="e.g. 50000" />
        <button class="btn-ghost full" id="generateBtn" style="margin-top:12px;">Generate quote draft ↓</button>
      </div>
      <div class="card email-preview">
        <div class="section-label">Quote draft — edit anything before sending</div>
        <label>Subject (for email)</label>
        <input id="qSubject" placeholder="Quotation — Together, Out Loud" />
        <label>Message</label>
        <textarea id="qBody" rows="18" style="width:100%; font-family:'JetBrains Mono',monospace; font-size:12.5px; padding:10px; border:1px solid #DDD5C4; border-radius:6px;"></textarea>
        <button class="btn-primary full" id="sendQuoteBtn" style="margin-top:12px;">💬 Mark as quoted & prepare messages</button>
        <button class="btn-ghost full" id="downloadQuotePdfBtn" style="margin-top:8px;">📄 Download quote as PDF</button>
        <div id="sendStatus"></div>
      </div>
    </div>
    <div class="section-label" style="margin-top:24px;">Quote history — what's already been sent</div>
    <div class="table" id="quoteHistoryTable"><div class="board-empty">Loading…</div></div>
  `;

  api("/api/quotes").then((history) => {
    const historyTable = main.querySelector("#quoteHistoryTable");
    if (!historyTable) return;
    if (history.length === 0) {
      historyTable.innerHTML = `<div class="board-empty">No quotes sent yet</div>`;
      return;
    }
    historyTable.innerHTML = `
      <div class="table-head" style="grid-template-columns:1.6fr 1fr 1fr 1fr;">
        <span>Sent to</span><span>Amount</span><span>Date sent</span><span></span>
      </div>
      ${history.map((q) => `
        <div class="table-row" style="grid-template-columns:1.6fr 1fr 1fr 1fr;">
          <span>${q.lead_name}</span>
          <span class="mono">${q.amount ? inr(q.amount) : "—"}</span>
          <span class="muted small">${fmtDateTime(q.created_at)}</span>
          <span><button class="btn-ghost view-quote-btn" data-quote-id="${q.id}">View</button></span>
        </div>
      `).join("")}
    `;
    historyTable.querySelectorAll(".view-quote-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const q = history.find((h) => h.id === btn.dataset.quoteId);
        alert(q.body);
      });
    });
  });

  if (quotable.length === 0) {
    main.querySelector(".quote-grid").innerHTML = `<p class="muted">No leads available to quote right now.</p>`;
    return;
  }

  const leadSelect = main.querySelector("#leadSelect");
  const fields = ["qLocation", "qDate", "qGuests", "qDuration", "qSet", "qFormatType", "qCharges"].map((id) => main.querySelector(`#${id}`));

  // Looks up the fixed rate for this lead's format + musician count, if one exists,
  // and fills it in — still fully editable by hand for anything non-standard.
  function applyStandardPricing() {
    const lead = LEADS.find((l) => l.id === leadSelect.value);
    const pcs = main.querySelector("#qSet").value;
    if (!lead || !pcs) return;
    const rate = CONFIG.pricing?.[lead.event_type]?.[pcs];
    if (rate !== undefined) main.querySelector("#qCharges").value = rate;
  }

  function prefillFromLead() {
    const lead = LEADS.find((l) => l.id === leadSelect.value);
    if (!lead) return;
    main.querySelector("#qLocation").value = lead.city || "";
    main.querySelector("#qDate").value = fmtDate(lead.date);
    main.querySelector("#qGuests").value = lead.guest_range || "";
    main.querySelector("#qSubject").value = `Quotation for ${packageName(lead.event_type)} — Together, Out Loud`;
    main.querySelector("#qSet").value = "";
    main.querySelector("#qCharges").value = "";
    // A pheras ceremony runs as long as the ceremony itself takes, and doesn't
    // have a Private/Public distinction the way a jamming session does — so
    // neither field applies and both are hidden rather than asked for.
    const isPheras = lead.event_type === "pheras";
    main.querySelector("#qDurationWrap").style.display = isPheras ? "none" : "";
    main.querySelector("#qFormatTypeWrap").style.display = isPheras ? "none" : "";
    applyStandardPricing();

    // Everything the client already told us on the enquiry form, surfaced here
    // so whoever's quoting doesn't have to flip back to Leads to check it.
    const ctx = main.querySelector("#leadContextCard");
    const rows = [
      lead.occasion ? ["Occasion", lead.occasion] : null,
      lead.details ? ["Tell us about your event", lead.details] : null,
      lead.guest_range ? ["Guest range (as submitted)", lead.guest_range] : null,
      lead.budget ? ["Budget mentioned", inr(lead.budget)] : null,
      lead.alt_date ? ["Alternate date", fmtDate(lead.alt_date)] : null,
      lead.how_heard ? ["Heard about us via", lead.how_heard] : null,
      (lead.phone || lead.whatsapp_number) ? ["Contact", `${lead.phone || ""}${lead.whatsapp_number && lead.whatsapp_number !== lead.phone ? ` (WhatsApp: ${lead.whatsapp_number})` : ""}`] : null,
      lead.email ? ["Email", lead.email] : null,
    ].filter(Boolean);
    if (rows.length === 0) {
      ctx.style.display = "none";
    } else {
      ctx.style.display = "block";
      ctx.innerHTML = `
        <div class="muted" style="font-weight:600; margin-bottom:6px; text-transform:uppercase; font-size:11px; letter-spacing:0.02em;">From their enquiry</div>
        ${rows.map(([label, value]) => `<div style="margin-bottom:4px;"><span class="muted">${label}:</span> ${value}</div>`).join("")}
      `;
    }
  }

  function generateDraft() {
    const lead = LEADS.find((l) => l.id === leadSelect.value);
    const isPheras = lead && lead.event_type === "pheras";
    main.querySelector("#qBody").value = buildQuoteText({
      eventType: lead ? lead.event_type : "",
      format: lead ? packageName(lead.event_type) : "",
      location: main.querySelector("#qLocation").value,
      date: main.querySelector("#qDate").value,
      guests: main.querySelector("#qGuests").value,
      duration: isPheras ? "" : main.querySelector("#qDuration").value,
      setPieces: main.querySelector("#qSet").value,
      formatType: isPheras ? "" : main.querySelector("#qFormatType").value,
      charges: main.querySelector("#qCharges").value,
      firstName: lead ? (lead.name || "").trim().split(" ")[0] : "",
    });
  }

  leadSelect.addEventListener("change", () => { prefillFromLead(); generateDraft(); });
  main.querySelector("#qSet").addEventListener("input", () => { applyStandardPricing(); });
  main.querySelector("#generateBtn").addEventListener("click", generateDraft);
  prefillFromLead();
  generateDraft();

  function validateQuoteFields() {
    const lead = LEADS.find((l) => l.id === leadSelect.value);
    const isPheras = lead && lead.event_type === "pheras";
    const required = [
      ["#qLocation", "Location"],
      ["#qDate", "Date"],
      ["#qGuests", "No. of guests"],
      ...(isPheras ? [] : [["#qDuration", "Duration"], ["#qFormatType", "Format"]]),
      ["#qSet", "Pcs (No. of Musicians)"],
      ["#qCharges", "Performance charges"],
    ];
    const missing = required.filter(([sel]) => !main.querySelector(sel).value.toString().trim());
    if (missing.length > 0) {
      alert(`Please fill in before sending: ${missing.map(([, label]) => label).join(", ")}`);
      return false;
    }
    return true;
  }

  main.querySelector("#sendQuoteBtn").addEventListener("click", async () => {
    if (!validateQuoteFields()) return;
    const leadId = leadSelect.value;
    const body = main.querySelector("#qBody").value;
    const subject = main.querySelector("#qSubject").value;
    const charges = main.querySelector("#qCharges").value;
    if (!body.trim()) return;
    const btn = main.querySelector("#sendQuoteBtn");
    btn.disabled = true;
    btn.textContent = "Preparing…";
    try {
      const result = await api(`/api/leads/${leadId}/quote`, {
        method: "POST",
        body: JSON.stringify({
          amount: charges || null, subject, body,
          pcs: main.querySelector("#qSet").value || null,
          duration: (LEADS.find((l) => l.id === leadId)?.event_type === "pheras") ? null : (main.querySelector("#qDuration").value || null),
        }),
      });
      await refreshLeads();

      const waHtml = result.whatsapp.link
        ? `<div class="email-status sent">💬 Opened WhatsApp for ${result.lead.phone} — <a href="${result.whatsapp.link}" target="_blank">click here</a> if it didn't open</div>`
        : `<div class="email-status unsent">💬 Couldn't prepare WhatsApp message — ${result.whatsapp.reason}</div>`;

      const mailHtml = result.mailto.link
        ? `<div class="email-status sent">✉️ <a href="${result.mailto.link}">Click here to send by email</a> — opens your email app with everything filled in</div>`
        : `<div class="email-status unsent">✉️ Couldn't prepare email — ${result.mailto.reason}</div>`;

      main.querySelector("#sendStatus").innerHTML = waHtml + mailHtml;
      if (result.whatsapp.link) window.open(result.whatsapp.link, "_blank");
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "💬 Mark as quoted & prepare messages";
    }
  });

  main.querySelector("#downloadQuotePdfBtn").addEventListener("click", async () => {
    if (!validateQuoteFields()) return;
    const lead = LEADS.find((l) => l.id === leadSelect.value);
    const btn = main.querySelector("#downloadQuotePdfBtn");
    btn.disabled = true;
    btn.textContent = "Preparing PDF…";
    try {
      await downloadQuotePDF({
        clientName: lead ? lead.name : "Client",
        date: new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }),
        fields: {
          format: lead ? packageName(lead.event_type) : "",
          location: main.querySelector("#qLocation").value,
          eventDate: main.querySelector("#qDate").value,
          guests: main.querySelector("#qGuests").value,
          duration: main.querySelector("#qDuration").value,
          pcs: main.querySelector("#qSet").value,
          formatType: main.querySelector("#qFormatType").value,
          charges: main.querySelector("#qCharges").value,
        },
      });
    } finally {
      btn.disabled = false;
      btn.textContent = "📄 Download quote as PDF";
    }
  });
}

// ---------- Calendar (shared grid, used by both the Calendar tab and the Dashboard) ----------
function calendarGridMarkup() {
  return `
    <div class="cal-nav">
      <button class="btn-ghost" id="prevMonth">‹</button>
      <div class="cal-month" id="calMonthLabel"></div>
      <button class="btn-ghost" id="nextMonth">›</button>
    </div>
    <div class="cal-grid cal-head">${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => `<div>${d}</div>`).join("")}</div>
    <div class="cal-grid" id="calCells"></div>
  `;
}

function wireCalendarGrid(container) {
  const confirmed = LEADS.filter((l) => l.stage === "Confirmed" || l.stage === "Completed" || l.stage === "Tentative");
  const first = new Date(calYear, calMonth - 1, 1);
  const startDay = first.getDay();
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const cells = Array(startDay).fill(null).concat(Array.from({ length: daysInMonth }, (_, i) => i + 1));
  const eventsByDay = {};
  confirmed.forEach((l) => {
    if (!l.date) return;
    const d = new Date(l.date + "T00:00:00");
    if (d.getFullYear() === calYear && d.getMonth() === calMonth - 1) {
      (eventsByDay[d.getDate()] = eventsByDay[d.getDate()] || []).push(l);
    }
  });
  container.querySelector("#calMonthLabel").textContent = first.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const calCells = container.querySelector("#calCells");
  calCells.innerHTML = "";
  cells.forEach((d) => {
    const evs = d ? (eventsByDay[d] || []) : [];
    calCells.appendChild(el(`
      <div class="cal-cell${d ? "" : " cal-cell-empty"}">
        ${d ? `<div class="cal-day">${d}</div>` : ""}
        ${evs.map((ev) => `<div class="cal-event${ev.stage === "Tentative" ? " cal-event-tentative" : ""}" data-lead-id="${ev.id}" style="cursor:pointer;${ev.stage === "Tentative" ? ` background:transparent; border:1px dashed ${STAGE_COLOR.Tentative}; color:${STAGE_COLOR.Tentative};` : ""}" title="Click to open ${ev.name}${ev.stage === "Tentative" ? " (Tentative)" : ""}">${ev.name.split(" ")[0]}${ev.stage === "Tentative" ? " ⏳" : ""}</div>`).join("")}
      </div>
    `));
  });
  calCells.querySelectorAll(".cal-event").forEach((pill) => {
    pill.addEventListener("click", () => {
      const lead = LEADS.find((l) => l.id === pill.dataset.leadId);
      if (!lead) return;
      if (hasLeadsAccess()) {
        leadsSearch = lead.name;
        leadsStageFilter = "all";
        leadsDateFilter = "";
        currentTab = "leads";
        renderNav();
        renderMain();
      } else if (canAssignTeam()) {
        openAssignTeamModal(lead.id);
      }
    });
  });

  container.querySelector("#prevMonth").addEventListener("click", () => { calMonth--; if (calMonth < 1) { calMonth = 12; calYear--; } renderMain(); });
  container.querySelector("#nextMonth").addEventListener("click", () => { calMonth++; if (calMonth > 12) { calMonth = 1; calYear++; } renderMain(); });
}

async function renderCalendar(main) {
  main.innerHTML = `<div class="view-head"><div><h2>Calendar</h2></div></div><p class="muted">Loading…</p>`;
  await refreshLeads();
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = LEADS
    .filter((l) => (l.stage === "Confirmed" || l.stage === "Completed" || l.stage === "Tentative") && l.date >= today)
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  main.innerHTML = `
    <div class="view-head"><div><h2>Calendar</h2><p class="muted">Confirmed, tentative, and completed events — spot clashes before you quote.</p></div></div>
    <div class="card">${calendarGridMarkup()}</div>
    <div class="section-label" style="margin-top:20px;">Upcoming confirmed events</div>
    <div class="list" id="calList"></div>
  `;
  wireCalendarGrid(main);

  const calList = main.querySelector("#calList");
  if (upcoming.length === 0) calList.innerHTML = `<div class="board-empty">Nothing upcoming right now</div>`;
  upcoming.forEach((l) => {
    const row = el(`
      <div class="list-row" style="grid-template-columns:110px 1fr 100px 90px 70px; cursor:pointer;">
        <span class="mono">${fmtDate(l.date)}</span><span>${l.name}${l.occasion ? ` <span class="muted small">— ${l.occasion}</span>` : ""}</span><span class="muted">${l.city || ""}</span>
        <span class="tag" style="color:${STAGE_COLOR[l.stage]}">${l.stage}</span>
        <button class="btn-ghost open-event-chat-btn" data-lead-id="${l.id}" data-lead-name="${l.name}" style="font-size:12px; padding:3px 8px;">💬 Chat</button>
      </div>
    `);
    row.querySelector(".open-event-chat-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openEventChat(l.id, l.name);
    });
    row.addEventListener("click", () => {
      if (hasLeadsAccess()) {
        leadsSearch = l.name;
        leadsStageFilter = "all";
        leadsDateFilter = "";
        currentTab = "leads";
        renderNav();
        renderMain();
      } else if (canAssignTeam()) {
        openAssignTeamModal(l.id);
      }
    });
    calList.appendChild(row);
  });
}

// ---------- Team ----------
async function renderTeam(main) {
  const isAdmin = CURRENT_USER?.accessLevel === "admin";
  const canManage = canManageTeam();
  const users = canManage ? await api("/api/users") : [];
  const teamIdsWithLogin = new Set(users.map((u) => u.team_id).filter(Boolean));
  main.innerHTML = `
    <div class="view-head">
      <div><h2>Team</h2><p class="muted">Your band's musicians, crew, and staff.</p></div>
      ${canManage ? `<button class="btn-primary" id="addMemberBtn">+ Add team member</button>` : ""}
    </div>
    ${isAdmin && LEADS.some((l) => l.is_seed) ? `
      <div class="card" style="margin-bottom:20px; border-color:#A64B3C;">
        <div class="section-label" style="color:#A64B3C;">Going live</div>
        <p class="muted small">Wipe the ${LEADS.filter((l) => l.is_seed).length} demo leads/bookings (and everything tied to them — tasks, documents, expenses, payments, quotes) and the placeholder team members (Divya/Karan/Neha/Devin). Your real leads, bookings, and everyone else's data are never touched.</p>
        <button class="btn-ghost" id="clearDemoBtn" style="color:#A64B3C; border-color:#A64B3C;">🗑 Clear demo data</button>
      </div>
    ` : ""}
    ${isAdmin ? `
      <div class="section-label">Broadcast to team</div>
      <div class="card" style="margin-bottom:20px;">
        <textarea id="announceText" rows="2" placeholder="e.g. Reminder: team meeting tomorrow at 6pm" style="width:100%; padding:10px; border:1px solid #DDD5C4; border-radius:6px; font-family:inherit; font-size:13px;"></textarea>
        <button class="btn-primary" id="sendAnnounceBtn" style="margin-top:8px;">📢 Send to everyone</button>
        <div id="announceList" style="margin-top:12px;"></div>
      </div>
    ` : ""}
    <div class="team-grid" id="teamGrid"></div>
    ${isAdmin ? `
      <div class="section-label" style="margin-top:24px;">Logins</div>
      <div class="table" id="userRows"></div>
    ` : ""}
  `;

  if (isAdmin) {
    const renderAnnouncements = async () => {
      const list = await api("/api/announcements");
      const el2 = main.querySelector("#announceList");
      if (!el2) return;
      el2.innerHTML = list.length === 0 ? "" : list.map((a) => `
        <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div><div>${a.message}</div><div class="muted small">${a.created_by} · ${fmtDateTime(a.created_at)}</div></div>
          <button class="icon-btn" data-delete-announce="${a.id}">✕</button>
        </div>
      `).join("");
      el2.querySelectorAll("[data-delete-announce]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await api(`/api/announcements/${btn.dataset.deleteAnnounce}`, { method: "DELETE" });
          renderAnnouncements();
        });
      });
    };
    renderAnnouncements();
    main.querySelector("#sendAnnounceBtn").addEventListener("click", async () => {
      const text = main.querySelector("#announceText").value;
      if (!text.trim()) return;
      await api("/api/announcements", { method: "POST", body: JSON.stringify({ message: text }) });
      main.querySelector("#announceText").value = "";
      renderAnnouncements();
    });
  }

  const grid = main.querySelector("#teamGrid");
  TEAM.forEach((m) => {
    const card = el(`
      <div class="card team-card" style="cursor:pointer;">
        ${canManage ? `<button class="icon-btn" data-edit-member="${m.id}" style="float:right;">✎</button>` : ""}
        <div class="team-avatar">${m.name[0]}</div>
        <div class="team-name">${m.name}</div>
        <div class="muted">${m.role || ""}${m.specialty ? ` · ${m.specialty}` : ""}</div>
        ${m.phone ? `<div class="muted small">${m.phone}</div>` : ""}
        ${m.email ? `<div class="muted small">${m.email}</div>` : ""}
        <div class="team-count mono">${m.activeShows.length} active show${m.activeShows.length === 1 ? "" : "s"}</div>
        ${m.activeShows.map((s) => `<div class="team-lead">› ${s.name}</div>`).join("")}
        ${canManage && !teamIdsWithLogin.has(m.id) ? `<button class="btn-ghost full" data-add-login="${m.id}" style="margin-top:10px;">+ Add login</button>` : ""}
      </div>
    `);
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-edit-member]") || e.target.closest("[data-add-login]")) return;
      openTeamMemberEventsModal(m);
    });
    grid.appendChild(card);
  });
  if (canManage) {
    main.querySelectorAll("[data-edit-member]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const member = TEAM.find((m) => m.id === btn.dataset.editMember);
        const linkedUser = users.find((u) => u.team_id === member.id);
        openEditMemberModal(member, linkedUser);
      });
    });
    main.querySelectorAll("[data-add-login]").forEach((btn) => {
      btn.addEventListener("click", () => openAddLoginForMemberModal(TEAM.find((m) => m.id === btn.dataset.addLogin)));
    });
  }

  if (isAdmin) {
    const userRows = main.querySelector("#userRows");
    if (users.length === 0) userRows.innerHTML = `<div class="board-empty">No logins yet</div>`;
    users.forEach((u) => {
      userRows.appendChild(el(`
        <div class="table-row" style="grid-template-columns:1.5fr 1fr 1fr 1fr;">
          <span>${u.username}${u.team_name ? ` <span class="muted">— ${u.team_name}</span>` : ""}</span>
          <span class="muted">${u.team_role || "—"}</span>
          <span class="tag">${u.access_level}</span>
          <span>
            <button class="icon-btn" data-edit-user="${u.id}">✎</button>
            ${u.id === CURRENT_USER.id ? "" : `<button class="icon-btn" data-delete-user="${u.id}">✕</button>`}
          </span>
        </div>
      `));
    });
    userRows.querySelectorAll("[data-edit-user]").forEach((btn) => {
      btn.addEventListener("click", () => openEditLoginModal(users.find((u) => u.id === btn.dataset.editUser)));
    });
    userRows.querySelectorAll("[data-delete-user]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this login? They won't be able to sign in anymore.")) return;
        await api(`/api/users/${btn.dataset.deleteUser}`, { method: "DELETE" });
        renderMain();
      });
    });
    const clearBtn = main.querySelector("#clearDemoBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        const seedCount = LEADS.filter((l) => l.is_seed).length;
        if (!confirm(`This permanently deletes the ${seedCount} demo leads/bookings and everything tied to them (tasks, documents, expenses, payments, quotes), plus the placeholder team members Divya/Karan/Neha/Devin. Your real leads and everything else are untouched. Your own admin login is kept. This cannot be undone — continue?`)) return;
        if (!confirm("Are you absolutely sure? Type-to-confirm isn't available here, so this is your last chance to cancel.")) return;
        try {
          const result = await api("/api/admin/clear-demo-data", { method: "POST" });
          alert(`Done. Demo leads removed: ${result.seedLeadsRemoved}. Leads remaining: ${result.leadsLeft}, team members remaining: ${result.teamLeft}, logins remaining: ${result.usersLeft}.`);
          await refreshLeads();
          const teamData = await api("/api/team");
          TEAM = teamData;
          renderMain();
        } catch (err) {
          alert(err.message);
        }
      });
    }
  }
  if (canManage) {
    main.querySelector("#addMemberBtn").addEventListener("click", () => openAddMemberModal());
  }
}

// Shows every event a given team member is booked to perform at, upcoming only.
async function openTeamMemberEventsModal(member) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal-card">
        <div class="modal-head"><h3>Events for ${member.name}</h3><button class="icon-btn" id="closeModal">✕</button></div>
        <div class="modal-body"><p class="muted small">Loading…</p></div>
        <div class="modal-foot"><button class="btn-ghost" id="cancelModal">Close</button></div>
      </div>
    </div>
  `;
  const close = () => (root.innerHTML = "");
  root.querySelector("#closeModal").addEventListener("click", close);
  root.querySelector("#cancelModal").addEventListener("click", close);
  root.querySelector("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") close(); });

  const statusLabel = { pending: "Awaiting response", accepted: "Accepted", declined: "Declined", cancel_requested: "Cancellation requested" };
  const statusColor = { pending: "#B6752C", accepted: "#5C8A6B", declined: "#A64B3C", cancel_requested: "#B6752C" };

  let events;
  try {
    events = await api(`/api/team/${member.id}/assignments`);
  } catch (err) {
    const body = root.querySelector(".modal-body");
    if (body) body.innerHTML = `<p class="muted small">${err.message}</p>`;
    return;
  }
  const body = root.querySelector(".modal-body");
  if (!body) return; // modal was closed while loading
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = events.filter((e) => e.date >= today);

  const rowHtml = (e) => `
    <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:flex-start;">
      <div>
        <div>${e.lead_name} <span class="muted small">— ${packageName(e.event_type)}${e.occasion ? ` · ${e.occasion}` : ""}</span></div>
        <div class="muted small">${fmtDate(e.date)}${e.city ? ` · ${e.city}` : ""}${e.event_time ? ` · Event ${fmtTimeHM(e.event_time)}` : ""}${e.soundcheck_time ? ` · SC ${fmtTimeHM(e.soundcheck_time)}` : ""}</div>
        ${e.venue ? `<div class="muted small">📍 ${e.venue}</div>` : ""}
        ${e.fee_amount !== undefined ? `<div class="muted small mono">Fee: ${e.fee_amount ? inr(e.fee_amount) : "—"}${e.fee_amount ? (e.paid ? " · Paid" : " · Pending") : ""}</div>` : ""}
      </div>
      <span class="tag" style="color:${statusColor[e.status]};">${statusLabel[e.status] || e.status}</span>
    </div>
  `;

  body.innerHTML = upcoming.length === 0
    ? `<p class="muted small">No upcoming events for ${member.name}.</p>`
    : upcoming.map(rowHtml).join("");
}


function wirePasswordToggles(root) {
  root.querySelectorAll(".password-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = root.querySelector(`#${btn.dataset.toggleFor}`);
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.textContent = showing ? "Show" : "Hide";
    });
  });
}

function openAddMemberModal(onCreated) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal-card">
        <div class="modal-head"><h3>Add team member</h3><button class="icon-btn" id="closeModal">✕</button></div>
        <div class="modal-body">
          <label>Name</label>
          <input id="nmName" placeholder="e.g. Karan Mehta" />
          <label>Access level</label>
          <select id="nmAccess">
            <option value="staff">Staff — everyday use, can't manage logins</option>
            <option value="performer">Performer — musicians/photographers: just their events, pay status, and event chat</option>
            ${CURRENT_USER?.accessLevel === "admin" ? `<option value="admin">Admin — full access, including adding/removing logins</option>` : ""}
          </select>
          <div id="nmPermsWrap" style="margin-top:8px;">
            <label>What can they access?</label>
            ${permissionsChecklistHtml("nm", undefined)}
          </div>
          <div id="nmPerformerWrap" style="margin-top:10px;">
            <label class="check-row"><input type="checkbox" id="nmIsPerformer" /> Also a performer (sees own assigned events, artist fee, and accept/decline)</label>
          </div>
          <label>Role / Specialty</label>
          <input id="nmRole" placeholder="e.g. Logistics & Sound, or Drummer, Photographer" />
          <label>Phone</label>
          <input id="nmPhone" placeholder="e.g. 9876543210" />
          <p class="muted small" style="margin:4px 0 0;">Username and password default to this phone number — change them below if you'd like something else.</p>
          <div class="row-2">
            <div><label>Username</label><input id="nmUsername" placeholder="Defaults to phone number" /></div>
            <div><label>Password</label>
              <div class="password-field">
                <input id="nmPassword" type="password" placeholder="Defaults to phone number" />
                <button type="button" class="password-toggle" data-toggle-for="nmPassword">Show</button>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-foot"><button class="btn-ghost" id="cancelModal">Cancel</button><button class="btn-primary" id="submitModal">Add member</button></div>
      </div>
    </div>
  `;
  wirePasswordToggles(root);
  const toggleNmPerms = () => {
    root.querySelector("#nmPermsWrap").style.display = root.querySelector("#nmAccess").value === "staff" ? "block" : "none";
    root.querySelector("#nmPerformerWrap").style.display = root.querySelector("#nmAccess").value === "performer" ? "none" : "block";
  };
  root.querySelector("#nmAccess").addEventListener("change", toggleNmPerms);
  toggleNmPerms();

  // Username/password default to the phone number as it's typed, but only
  // while the admin hasn't manually overridden them — never fight a manual edit.
  let usernameTouched = false, passwordTouched = false;
  root.querySelector("#nmUsername").addEventListener("input", () => { usernameTouched = true; });
  root.querySelector("#nmPassword").addEventListener("input", () => { passwordTouched = true; });
  root.querySelector("#nmPhone").addEventListener("input", (e) => {
    const digits = e.target.value.replace(/\D/g, "");
    if (!usernameTouched) root.querySelector("#nmUsername").value = digits;
    if (!passwordTouched) root.querySelector("#nmPassword").value = digits;
  });

  const close = () => (root.innerHTML = "");
  root.querySelector("#closeModal").addEventListener("click", close);
  root.querySelector("#cancelModal").addEventListener("click", close);
  root.querySelector("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") close(); });
  root.querySelector("#submitModal").addEventListener("click", async () => {
    const name = root.querySelector("#nmName").value;
    const username = root.querySelector("#nmUsername").value;
    const password = root.querySelector("#nmPassword").value;
    const accessLevel = root.querySelector("#nmAccess").value;
    const permissions = accessLevel === "staff"
      ? [...root.querySelectorAll(".nm-perm:checked")].map((cb) => cb.value)
      : undefined;
    const isPerformer = accessLevel === "performer" ? false : root.querySelector("#nmIsPerformer").checked;
    if (!name || !username || !password) return alert("Name, username, and password are required.");
    try {
      const result = await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          name,
          roleTitle: root.querySelector("#nmRole").value,
          phone: root.querySelector("#nmPhone").value,
          username,
          password,
          accessLevel,
          permissions,
          isPerformer,
        }),
      });
      const teamData = await api("/api/team");
      TEAM = teamData;
      close();
      if (typeof onCreated === "function") onCreated(result);
      else renderMain();
    } catch (err) {
      alert(err.message);
    }
  });
}

function openAddLoginForMemberModal(member) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal-card">
        <div class="modal-head"><h3>Add login for ${member.name}</h3><button class="icon-btn" id="closeModal">✕</button></div>
        <div class="modal-body">
          <div class="row-2">
            <div><label>Username</label><input id="alUsername" placeholder="e.g. ${member.name.split(" ")[0].toLowerCase()}" /></div>
            <div><label>Password</label>
              <div class="password-field">
                <input id="alPassword" type="password" placeholder="Choose a password" />
                <button type="button" class="password-toggle" data-toggle-for="alPassword">Show</button>
              </div>
            </div>
          </div>
          <label>Access level</label>
          <select id="alAccess">
            <option value="staff">Staff — everyday use, can't manage logins</option>
            <option value="performer">Performer — musicians/photographers: just their events, pay status, and event chat</option>
            ${CURRENT_USER?.accessLevel === "admin" ? `<option value="admin">Admin — full access, including adding/removing logins</option>` : ""}
          </select>
          <div id="alPerformerWrap" style="margin-top:10px;">
            <label class="check-row"><input type="checkbox" id="alIsPerformer" /> Also a performer (sees own assigned events, artist fee, and accept/decline)</label>
          </div>
        </div>
        <div class="modal-foot"><button class="btn-ghost" id="cancelModal">Cancel</button><button class="btn-primary" id="submitModal">Add login</button></div>
      </div>
    </div>
  `;
  wirePasswordToggles(root);
  const toggleAlPerformer = () => { root.querySelector("#alPerformerWrap").style.display = root.querySelector("#alAccess").value === "performer" ? "none" : "block"; };
  root.querySelector("#alAccess").addEventListener("change", toggleAlPerformer);
  toggleAlPerformer();
  const close = () => (root.innerHTML = "");
  root.querySelector("#closeModal").addEventListener("click", close);
  root.querySelector("#cancelModal").addEventListener("click", close);
  root.querySelector("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") close(); });
  root.querySelector("#submitModal").addEventListener("click", async () => {
    const username = root.querySelector("#alUsername").value;
    const password = root.querySelector("#alPassword").value;
    const accessLevel = root.querySelector("#alAccess").value;
    if (!username || !password) return alert("Username and password are required.");
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          existingTeamId: member.id,
          username,
          password,
          accessLevel,
          isPerformer: accessLevel === "performer" ? false : root.querySelector("#alIsPerformer").checked,
        }),
      });
      close();
      renderMain();
    } catch (err) {
      alert(err.message);
    }
  });
}

function openEditMemberModal(member, linkedUser) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal-card">
        <div class="modal-head"><h3>Edit ${member.name}</h3><button class="icon-btn" id="closeModal">✕</button></div>
        <div class="modal-body">
          <label>Name</label>
          <input id="emName" value="${member.name}" />
          ${linkedUser ? `
            <label>Access level</label>
            <select id="emAccess">
              <option value="staff" ${linkedUser.access_level === "staff" ? "selected" : ""}>Staff — everyday use, can't manage logins</option>
              <option value="performer" ${linkedUser.access_level === "performer" ? "selected" : ""}>Performer — musicians/photographers: just their events, pay status, and event chat</option>
              ${CURRENT_USER?.accessLevel === "admin" ? `<option value="admin" ${linkedUser.access_level === "admin" ? "selected" : ""}>Admin — full access, including adding/removing logins</option>` : ""}
            </select>
            <div id="emPermsWrap" style="margin-top:8px; display:${linkedUser.access_level === "staff" ? "block" : "none"};">
              <label>What can they access?</label>
              ${permissionsChecklistHtml("em", linkedUser.permissions)}
            </div>
            <div id="emPerformerWrap" style="margin-top:10px; display:${linkedUser.access_level === "performer" ? "none" : "block"};">
              <label class="check-row"><input type="checkbox" id="emIsPerformer" ${linkedUser.is_performer ? "checked" : ""} /> Also a performer (sees own assigned events, artist fee, and accept/decline)</label>
            </div>
          ` : `<p class="muted small">No login yet for this person — add a username/password below to create one.</p>`}
          <div class="row-2">
            <div><label>Role / title</label><input id="emRole" value="${member.role || ""}" /></div>
            <div><label>Specialty (optional)</label><input id="emSpecialty" value="${member.specialty || ""}" placeholder="e.g. Drummer, Photographer" /></div>
          </div>
          <div class="row-2">
            <div><label>Phone</label><input id="emPhone" value="${member.phone || ""}" /></div>
            <div><label>Email</label><input id="emEmail" value="${member.email || ""}" /></div>
          </div>
          <div class="row-2">
            <div><label>Username</label><input id="emUsername" value="${linkedUser ? linkedUser.username : ""}" placeholder="${linkedUser ? "" : "Leave blank for no login"}" /></div>
            <div><label>${linkedUser ? "New password (leave blank to keep unchanged)" : "Password"}</label>
              <div class="password-field">
                <input id="emPassword" type="password" placeholder="${linkedUser ? "••••••••" : "Choose a password"}" />
                <button type="button" class="password-toggle" data-toggle-for="emPassword">Show</button>
              </div>
            </div>
          </div>
          <button type="button" class="btn-ghost" id="genPasswordBtn" style="margin-top:6px;">🎲 Generate a new password</button>
          <p class="muted small" id="genPasswordNote" style="display:none; margin-top:6px;">Copy this now — it can't be viewed again once saved (only reset).</p>
          ${!linkedUser ? `<label style="margin-top:10px;">Access level (for the new login)</label>
            <select id="emAccess">
              <option value="staff">Staff — everyday use, can't manage logins</option>
              <option value="performer">Performer — musicians/photographers: just their events, pay status, and event chat</option>
              ${CURRENT_USER?.accessLevel === "admin" ? `<option value="admin">Admin — full access, including adding/removing logins</option>` : ""}
            </select>
            <div id="emPermsWrap" style="margin-top:8px;">
              <label>What can they access?</label>
              ${permissionsChecklistHtml("em", undefined)}
            </div>
            <div id="emPerformerWrap" style="margin-top:10px;">
              <label class="check-row"><input type="checkbox" id="emIsPerformer" /> Also a performer (sees own assigned events, artist fee, and accept/decline)</label>
            </div>` : ""}
        </div>
        <div class="modal-foot">
          <button class="btn-ghost" id="deleteMember" style="color:#A64B3C;">Remove member</button>
          <button class="btn-ghost" id="cancelModal">Cancel</button>
          <button class="btn-primary" id="submitModal">Save</button>
        </div>
      </div>
    </div>
  `;
  wirePasswordToggles(root);
  const emAccessSelect = root.querySelector("#emAccess");
  if (emAccessSelect) {
    const toggleEmPerms = () => {
      const w = root.querySelector("#emPermsWrap"); if (w) w.style.display = emAccessSelect.value === "staff" ? "block" : "none";
      const pw = root.querySelector("#emPerformerWrap"); if (pw) pw.style.display = emAccessSelect.value === "performer" ? "none" : "block";
    };
    emAccessSelect.addEventListener("change", toggleEmPerms);
  }
  root.querySelector("#genPasswordBtn").addEventListener("click", () => {
    const pw = Math.random().toString(36).slice(-4) + Math.floor(1000 + Math.random() * 9000);
    const input = root.querySelector("#emPassword");
    input.type = "text";
    input.value = pw;
    root.querySelector("#genPasswordNote").style.display = "block";
  });
  const close = () => (root.innerHTML = "");
  root.querySelector("#closeModal").addEventListener("click", close);
  root.querySelector("#cancelModal").addEventListener("click", close);
  root.querySelector("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") close(); });
  root.querySelector("#submitModal").addEventListener("click", async () => {
    try {
      await api(`/api/team/${member.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: root.querySelector("#emName").value,
          role: root.querySelector("#emRole").value,
          specialty: root.querySelector("#emSpecialty").value,
          phone: root.querySelector("#emPhone").value,
          email: root.querySelector("#emEmail").value,
        }),
      });
      const username = root.querySelector("#emUsername").value;
      const password = root.querySelector("#emPassword").value;
      const accessLevel = root.querySelector("#emAccess")?.value;
      const permissions = accessLevel === "staff"
        ? [...root.querySelectorAll(".em-perm:checked")].map((cb) => cb.value)
        : undefined;
      const emPerformerCb = root.querySelector("#emIsPerformer");
      const isPerformer = emPerformerCb ? (accessLevel === "performer" ? false : emPerformerCb.checked) : undefined;
      if (linkedUser) {
        await api(`/api/users/${linkedUser.id}`, {
          method: "PATCH",
          body: JSON.stringify({ username, password: password || undefined, accessLevel, permissions, isPerformer }),
        });
      } else if (username && password) {
        await api("/api/users", {
          method: "POST",
          body: JSON.stringify({ existingTeamId: member.id, username, password, accessLevel, permissions, isPerformer }),
        });
      }
      const teamData = await api("/api/team");
      TEAM = teamData;
      close();
      renderMain();
    } catch (err) {
      alert(err.message);
    }
  });
  root.querySelector("#deleteMember").addEventListener("click", async () => {
    if (!confirm(`Remove ${member.name} from the team? This also removes their login if they have one.`)) return;
    try {
      await api(`/api/team/${member.id}`, { method: "DELETE" });
      const teamData = await api("/api/team");
      TEAM = teamData;
      close();
      renderMain();
    } catch (err) {
      alert(err.message);
    }
  });
}

function openEditLoginModal(user) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal-card">
        <div class="modal-head"><h3>Edit login — ${user.username}</h3><button class="icon-btn" id="closeModal">✕</button></div>
        <div class="modal-body">
          <label>Username</label>
          <input id="elUsername" value="${user.username}" />
          <label>New password (leave blank to keep unchanged)</label>
          <div class="password-field">
            <input id="elPassword" type="password" placeholder="••••••••" />
            <button type="button" class="password-toggle" data-toggle-for="elPassword">Show</button>
          </div>
          <button type="button" class="btn-ghost" id="genPasswordBtn" style="margin-top:6px;">🎲 Generate a new password</button>
          <p class="muted small" id="genPasswordNote" style="display:none; margin-top:6px;">Copy this now — it can't be viewed again once saved (only reset).</p>
          <label>Access level</label>
          <select id="elAccess">
            <option value="staff" ${user.access_level === "staff" ? "selected" : ""}>Staff — everyday use, can't manage logins</option>
            <option value="performer" ${user.access_level === "performer" ? "selected" : ""}>Performer — musicians/photographers: just their events, pay status, and event chat</option>
            ${CURRENT_USER?.accessLevel === "admin" ? `<option value="admin" ${user.access_level === "admin" ? "selected" : ""}>Admin — full access, including adding/removing logins</option>` : ""}
          </select>
          <div id="elPermsWrap" style="margin-top:8px; display:${user.access_level === "staff" ? "block" : "none"};">
            <label>What can they access?</label>
            ${permissionsChecklistHtml("el", user.permissions)}
          </div>
        </div>
        <div class="modal-foot"><button class="btn-ghost" id="cancelModal">Cancel</button><button class="btn-primary" id="submitModal">Save</button></div>
      </div>
    </div>
  `;
  wirePasswordToggles(root);
  const elAccessSelect = root.querySelector("#elAccess");
  elAccessSelect.addEventListener("change", () => {
    root.querySelector("#elPermsWrap").style.display = elAccessSelect.value === "staff" ? "block" : "none";
  });
  root.querySelector("#genPasswordBtn").addEventListener("click", () => {
    const pw = Math.random().toString(36).slice(-4) + Math.floor(1000 + Math.random() * 9000);
    const input = root.querySelector("#elPassword");
    input.type = "text";
    input.value = pw;
    root.querySelector("#genPasswordNote").style.display = "block";
  });
  const close = () => (root.innerHTML = "");
  root.querySelector("#closeModal").addEventListener("click", close);
  root.querySelector("#cancelModal").addEventListener("click", close);
  root.querySelector("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") close(); });
  root.querySelector("#submitModal").addEventListener("click", async () => {
    const username = root.querySelector("#elUsername").value;
    const password = root.querySelector("#elPassword").value;
    const accessLevel = root.querySelector("#elAccess").value;
    const permissions = accessLevel === "staff"
      ? [...root.querySelectorAll(".el-perm:checked")].map((cb) => cb.value)
      : undefined;
    if (!username) return alert("Username can't be empty.");
    try {
      await api(`/api/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ username, password: password || undefined, accessLevel, permissions }),
      });
      close();
      renderMain();
    } catch (err) {
      alert(err.message);
    }
  });
}

// One place to finish "the payment status" for an event right after it wraps —
// client payments received, balance due, and every artist's paid/pending
// status — without leaving the Leads tab to go find it all in Accounts.
async function openLeadPaymentsModal(leadId) {
  const lead = LEADS.find((l) => l.id === leadId);
  if (!lead) return;

  // Combo bookings track money on the primary event only — redirect there
  // instead of showing a confusing empty screen for the secondary one.
  if (lead.combo_group_id && !lead.is_combo_primary) {
    const primary = LEADS.find((l) => l.combo_group_id === lead.combo_group_id && l.is_combo_primary);
    if (primary) return openLeadPaymentsModal(primary.id);
  }

  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal-card">
        <div class="modal-head"><h3>Payments — ${lead.name}</h3><button class="icon-btn" id="closeModal">✕</button></div>
        <div class="modal-body"><p class="muted small">Loading…</p></div>
        <div class="modal-foot"><button class="btn-ghost" id="cancelModal">Close</button></div>
      </div>
    </div>
  `;
  const close = () => { root.innerHTML = ""; renderMain(); };
  root.querySelector("#closeModal").addEventListener("click", close);
  root.querySelector("#cancelModal").addEventListener("click", close);
  root.querySelector("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") close(); });

  const [payments, expenses] = await Promise.all([
    api(`/api/leads/${leadId}/payments`),
    api(`/api/expenses?leadId=${leadId}`),
  ]);
  draw(payments, expenses);

  function draw(payments, expenses) {
    const body = root.querySelector(".modal-body");
    if (!body) return; // modal was closed while loading — nothing to update
    const total = lead.final_amount || lead.quote_amount || 0;
    const received = payments.reduce((s, p) => s + p.amount, 0);
    const balance = total - received;
    const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
    const pendingExpenses = expenses.filter((e) => !e.paid);
    body.innerHTML = `
      <div class="dash-stats" style="grid-template-columns:repeat(2,1fr); margin-bottom:16px; gap:8px;">
        <div class="card summary-card summary-card-compact"><div class="muted">Final rate</div><div class="mono big">${inr(total)}</div></div>
        <div class="card summary-card summary-card-compact"><div class="muted">Received</div><div class="mono big" style="color:${STAGE_COLOR.Confirmed}">${inr(received)}</div></div>
        <div class="card summary-card summary-card-compact"><div class="muted">Balance</div><div class="mono big" style="color:${balance > 0 ? "#A64B3C" : "#5C8A6B"};">${inr(balance)}</div></div>
        <div class="card summary-card summary-card-compact"><div class="muted">Profit</div><div class="mono big" style="color:${(total - totalExpenses) >= 0 ? "#5C8A6B" : "#A64B3C"};">${inr(total - totalExpenses)}</div></div>
      </div>
      ${hasAccountsAccess() ? `<button class="btn-ghost full" id="lpShareLedgerBtn" style="margin-bottom:14px;">📄 Share ledger PDF on WhatsApp</button>` : ""}

      <div class="section-label">Client payments</div>
      <div style="margin-bottom:10px;">
        ${payments.length === 0 ? `<p class="muted small">No payments recorded yet.</p>` : payments.map((p) => `
          <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div class="mono">${inr(p.amount)}</div>
              <div class="muted small">${fmtDate(p.payment_date)}${p.payment_mode ? ` · ${p.payment_mode}` : ""}</div>
            </div>
            <button class="icon-btn" data-delete-payment="${p.id}">✕</button>
          </div>
        `).join("")}
      </div>
      <div class="row-2">
        <input id="lpAmount" type="number" placeholder="Amount ₹" />
        <input id="lpDate" type="date" value="${new Date().toISOString().slice(0, 10)}" max="${new Date().toISOString().slice(0, 10)}" />
      </div>
      <select id="lpMode" style="margin-top:8px;">
        <option value="">Mode —</option>
        <option value="Cash">Cash</option>
        <option value="UPI">UPI</option>
      </select>
      <button class="btn-primary full" id="lpAddBtn" style="margin-top:10px;">Add payment</button>

      <div class="section-label" style="margin-top:20px;">Artist payments${totalExpenses ? ` — ${inr(totalExpenses)} total${pendingExpenses.length ? `, ${inr(pendingExpenses.reduce((s, e) => s + e.amount, 0))} pending` : ""}` : ""}</div>
      <div>
        ${expenses.length === 0 ? `<p class="muted small">No artist fees or other costs logged for this event yet — add them from the Team button.</p>` : expenses.map((e) => {
          const member = TEAM.find((m) => m.id === e.team_id);
          return `
            <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:center;">
              <div>
                <div>${e.head}${member && !e.head.includes(member.name) ? ` <span class="muted small">— ${member.name}</span>` : ""}</div>
                <div class="muted small mono">${inr(e.amount)}${e.paid && e.payment_date ? ` · Paid ${fmtDate(e.payment_date)}${e.payment_mode ? ` (${e.payment_mode})` : ""}` : ""}</div>
              </div>
              ${e.paid
                ? `<span class="tag" style="color:#5C8A6B;">Paid</span>`
                : `<button class="btn-ghost mark-expense-paid-btn" data-expense-id="${e.id}">Mark paid</button>`}
            </div>
          `;
        }).join("")}
      </div>
    `;

    const shareLedgerBtn = body.querySelector("#lpShareLedgerBtn");
    if (shareLedgerBtn) {
      shareLedgerBtn.addEventListener("click", async () => {
        shareLedgerBtn.disabled = true;
        shareLedgerBtn.textContent = "Preparing PDF…";
        try {
          await downloadLedgerPDF(lead, payments);
          const digitsOnly = (lead.whatsapp_number || lead.phone || "").replace(/\D/g, "");
          if (digitsOnly) {
            const msg = `Hi ${(lead.name || "").split(" ")[0] || "there"}, sharing your payment ledger with Together, Out Loud. Please find the PDF attached.`;
            window.open(`https://wa.me/${digitsOnly}?text=${encodeURIComponent(msg)}`, "_blank");
            alert("PDF downloaded, and WhatsApp is opening in a new tab — attach the downloaded PDF file to that chat to send it.");
          } else {
            alert("PDF downloaded — this client has no phone number on file, so WhatsApp couldn't be opened automatically.");
          }
        } finally {
          shareLedgerBtn.disabled = false;
          shareLedgerBtn.textContent = "📄 Share ledger PDF on WhatsApp";
        }
      });
    }
    body.querySelectorAll("[data-delete-payment]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this payment?")) return;
        btn.disabled = true;
        try {
          await api(`/api/payments/${btn.dataset.deletePayment}`, { method: "DELETE" });
          await refreshLeads();
          const [freshPayments, freshExpenses] = await Promise.all([
            api(`/api/leads/${leadId}/payments`), api(`/api/expenses?leadId=${leadId}`),
          ]);
          draw(freshPayments, freshExpenses);
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });

    body.querySelectorAll(".mark-expense-paid-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api(`/api/expenses/${btn.dataset.expenseId}`, { method: "PATCH", body: JSON.stringify({ paid: true }) });
          await refreshLeads();
          const [freshPayments, freshExpenses] = await Promise.all([
            api(`/api/leads/${leadId}/payments`), api(`/api/expenses?leadId=${leadId}`),
          ]);
          draw(freshPayments, freshExpenses);
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });

    body.querySelector("#lpAddBtn").addEventListener("click", async () => {
      const amount = body.querySelector("#lpAmount").value;
      const date = body.querySelector("#lpDate").value;
      if (!amount || Number(amount) <= 0) return alert("Enter a valid amount.");
      if (!date) return alert("Pick a date.");
      const btn = body.querySelector("#lpAddBtn");
      btn.disabled = true;
      try {
        await api(`/api/leads/${leadId}/payments`, {
          method: "POST",
          body: JSON.stringify({ amount: Number(amount), date, mode: body.querySelector("#lpMode").value || null }),
        });
        await refreshLeads();
        const [freshPayments, freshExpenses] = await Promise.all([
          api(`/api/leads/${leadId}/payments`), api(`/api/expenses?leadId=${leadId}`),
        ]);
        draw(freshPayments, freshExpenses);
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }
}

async function openAssignTeamModal(leadId) {
  const lead = LEADS.find((l) => l.id === leadId);
  const isAdmin = CURRENT_USER?.accessLevel === "admin";
  const [assignments, tempArtists, leadExpenses, myReimbursements, allDocuments] = await Promise.all([
    api(`/api/leads/${leadId}/assignments`),
    api(`/api/leads/${leadId}/temp-artists`),
    isAdmin ? api(`/api/expenses?leadId=${leadId}`) : Promise.resolve([]),
    api(`/api/my/reimbursements`).catch(() => []),
    api(`/api/documents`).catch(() => []),
  ]);
  const leadDocuments = allDocuments.filter((d) => d.lead_id === leadId);
  const generalDocuments = allDocuments.filter((d) => !d.lead_id);
  const leadReimbursements = myReimbursements.filter((r) => r.lead_id === leadId);
  const reimbStatusLabel = { 0: "Pending approval", 1: "Approved" };
  const waClientPhone = (lead.whatsapp_number || lead.phone || "").replace(/\D/g, "");
  const byTeamId = {};
  assignments.forEach((a) => (byTeamId[a.team_id] = a));
  // One artist-fee expense per team member per event is the normal case (the
  // Accounts tab creates entries this way too) — first match is used both to
  // prefill and to know whether to PATCH vs POST on save.
  const feeExpenseByTeamId = {};
  leadExpenses.forEach((e) => { if (e.team_id && !feeExpenseByTeamId[e.team_id]) feeExpenseByTeamId[e.team_id] = e; });

  const statusLabel = { pending: "Pending response", accepted: "Accepted", declined: "Declined" };
  const statusColor = { pending: "#B6752C", accepted: "#5C8A6B", declined: "#A64B3C" };

  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal-card" style="width:680px; max-width:96vw;">
        <div class="modal-head"><h3>Team for ${lead.name}${lead.occasion ? ` <span class="muted" style="font-weight:400; font-size:14px;">— ${lead.occasion}</span>` : ""}</h3><button class="icon-btn" id="closeModal">✕</button></div>
        <div class="modal-body">
          <div class="section-label">Event day details</div>
          <div class="row-2" style="margin-bottom:8px;">
            <div><label>Event time</label><input id="eventTimeInput" type="time" value="${lead.event_time || ""}" /></div>
            <div><label>Sound check time</label><input id="soundcheckTimeInput" type="time" value="${lead.soundcheck_time || ""}" /></div>
          </div>
          <label>Venue</label>
          <input id="venueInput" placeholder="e.g. Radhika Function Hall, MG Road" value="${lead.venue || ""}" style="margin-bottom:14px;" />
          ${TEAM.map((m) => {
            const a = byTeamId[m.id];
            const existingFee = feeExpenseByTeamId[m.id];
            const waDigits = (m.phone || "").replace(/\D/g, "");
            const waMsg = `Hi ${m.name}, confirming your performance for ${lead.name} — ${packageName(lead.event_type)} on ${fmtDate(lead.date)}${lead.venue ? ` at ${lead.venue}` : lead.city ? ` in ${lead.city}` : ""}.${lead.event_time ? ` Event time: ${lead.event_time}.` : ""}${lead.soundcheck_time ? ` Sound check: ${lead.soundcheck_time}.` : ""} Let us know if you have any questions!`;
            return `
              <div class="check-row" style="align-items:flex-start; justify-content:space-between; gap:8px;">
                <label style="display:flex; align-items:flex-start; gap:8px; flex:1; cursor:pointer;">
                  <input type="checkbox" data-team-id="${m.id}" ${a ? "checked" : ""} />
                  <span style="flex:1;">
                    <div>${m.name} <span class="muted small">— ${m.role || ""}</span></div>
                    ${a ? `
                      <select class="mark-response-select" data-assignment-id="${a.id}" style="margin-top:2px; font-size:12.5px; padding:2px 6px; color:${statusColor[a.status]};">
                        <option value="pending" ${a.status === "pending" ? "selected" : ""}>Pending response</option>
                        <option value="accepted" ${a.status === "accepted" ? "selected" : ""}>Accepted</option>
                        <option value="declined" ${a.status === "declined" ? "selected" : ""}>Declined</option>
                      </select>
                    ` : ""}
                    ${a && a.status === "accepted" && waDigits ? `<a class="btn-ghost" href="https://wa.me/${waDigits}?text=${encodeURIComponent(waMsg)}" target="_blank" style="display:inline-block; margin-top:4px; font-size:12px; padding:3px 8px;">💬 WhatsApp</a>` : ""}
                  </span>
                </label>
                ${isAdmin ? `<input type="number" class="member-fee-input" data-team-id="${m.id}" placeholder="Fee ₹" value="${existingFee ? existingFee.amount : ""}" style="width:100px; flex-shrink:0;" />` : ""}
              </div>
            `;
          }).join("")}
          <p class="muted small" style="margin-top:4px;">Not every artist uses their own login — use the status dropdown to record their response yourself.</p>
          ${isAdmin ? `<p class="muted small" style="margin-top:2px;">Enter a fee next to any artist above and it's saved as an expense against this event — no need to add it separately in Accounts.</p>` : ""}
          <button class="btn-ghost full" id="addMemberInlineBtn" style="margin-top:10px;">+ Add new member</button>

          <div class="section-label" style="margin-top:16px;">Temporary artists (one-off, this event only)</div>
          <div id="tempArtistList">
            ${tempArtists.length === 0 ? `<p class="muted small">None added yet.</p>` : tempArtists.map((t) => {
              const waDigits = (t.phone || "").replace(/\D/g, "");
              const waMsg = `Hi ${t.name}, confirming your performance for ${lead.name} — ${packageName(lead.event_type)} on ${fmtDate(lead.date)}${lead.venue ? ` at ${lead.venue}` : lead.city ? ` in ${lead.city}` : ""}.${lead.event_time ? ` Event time: ${lead.event_time}.` : ""}${lead.soundcheck_time ? ` Sound check: ${lead.soundcheck_time}.` : ""} Let us know if you have any questions!`;
              return `
              <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                  <div>${t.name}${t.description ? ` <span class="muted small">— ${t.description}</span>` : ""}</div>
                  <div class="muted small">${t.phone ? `${t.phone}` : ""}${hasAccountsAccess() ? `${t.phone ? " · " : ""}${t.fee_amount != null ? `Fee ${inr(t.fee_amount)}${t.fee_paid ? " · Paid" : " · Pending"}` : "No fee recorded"}` : ""}</div>
                  ${waDigits ? `<a class="btn-ghost" href="https://wa.me/${waDigits}?text=${encodeURIComponent(waMsg)}" target="_blank" style="display:inline-block; margin-top:4px; font-size:12px; padding:3px 8px;">💬 WhatsApp</a>` : ""}
                </div>
                <button class="icon-btn" data-remove-temp-artist="${t.id}">✕</button>
              </div>
            `;
            }).join("")}
          </div>
          <div class="row-2" style="margin-top:8px;">
            <input id="taName" placeholder="Name" />
            <input id="taPhone" placeholder="Phone" />
          </div>
          <div class="row-2" style="margin-top:8px;">
            <input id="taDescription" placeholder="Description (e.g. session tabla player)" />
            ${hasAccountsAccess() ? `<input id="taFee" type="number" placeholder="Fee ₹ (optional)" />` : ""}
          </div>
          <button class="btn-ghost full" id="addTempArtistBtn" style="margin-top:8px;">+ Add temporary artist</button>
          <p class="muted small" style="margin-top:4px;">Tip: hitting the overall Save button below also adds this if you've filled it in.${hasAccountsAccess() ? " Any fee entered here counts toward this event's expenses/profit automatically — no need to add it again under Accounts." : ""}</p>

          <div class="section-label" style="margin-top:16px;">Artist reimbursements</div>
          ${leadReimbursements.length > 0 ? `
            <div id="reimbList" style="margin-bottom:8px;">
              ${leadReimbursements.map((r) => `
                <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:center;">
                  <div>
                    <div>${r.head.replace(/^Reimbursement — /, "")} <span class="muted small">— ${inr(r.amount)}</span></div>
                    <div class="muted small" style="color:${r.approved ? "#5C8A6B" : "#B6752C"};">${reimbStatusLabel[r.approved]}${r.notes ? ` · ${r.notes}` : ""}</div>
                  </div>
                </div>
              `).join("")}
            </div>
          ` : ""}
          <div class="row-2" style="margin-top:8px;">
            <select id="reimbTeamId">
              <option value="">Choose artist…</option>
              ${TEAM.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}
              <option value="__other__">Other / not on roster…</option>
            </select>
            <input id="reimbAmount" type="number" placeholder="Amount ₹" />
          </div>
          <input id="reimbArtistName" placeholder="Artist name" style="margin-top:8px; display:none;" />
          <input id="reimbNotes" placeholder="What was this for? (e.g. cab fare, travel)" style="margin-top:8px;" />
          <button class="btn-ghost full" id="addReimbursementBtn" style="margin-top:8px;">+ Submit reimbursement</button>
          <p class="muted small" style="margin-top:4px;">Sent to admin for approval and payment — this is separate from the artist's performance fee.</p>

          <div class="section-label" style="margin-top:16px;">Documents</div>
          ${leadDocuments.length === 0 ? `<p class="muted small">No documents uploaded for this event yet.</p>` : `
            <div id="eventDocList" style="margin-bottom:8px;">
              ${leadDocuments.map((d) => {
                const fullUrl = window.location.origin + d.url;
                const waText = encodeURIComponent(fillTemplate(MESSAGE_TEMPLATES.document_share || TEMPLATE_META.document_share.default, { label: d.notes || "document", link: fullUrl }));
                return `
                <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                  <div>
                    <div>${d.notes ? `<strong>${d.notes}</strong> — ` : ""}<a href="${d.url}" target="_blank">${d.original_name}</a></div>
                    <div class="muted small">${fmtDate(d.uploaded_at.slice(0, 10))}</div>
                  </div>
                  <div style="display:flex; gap:4px; flex-shrink:0;">
                    ${waClientPhone ? `<a class="btn-ghost" href="https://wa.me/${waClientPhone}?text=${waText}" target="_blank" style="font-size:12px; padding:3px 8px;">Send to client</a>` : ""}
                    <button class="icon-btn" data-delete-event-doc="${d.id}">✕</button>
                  </div>
                </div>
              `;
              }).join("")}
            </div>
          `}

          ${generalDocuments.length > 0 ? `
            <div class="muted small" style="margin-top:10px; margin-bottom:4px;">From your document library — attach any of these to this event, or send straight to the client:</div>
            <div id="libraryDocList" style="margin-bottom:8px; border:1px solid #EFE9DC; border-radius:8px; max-height:180px; overflow-y:auto;">
              ${generalDocuments.map((d) => {
                const fullUrl = window.location.origin + d.url;
                const waText = encodeURIComponent(fillTemplate(MESSAGE_TEMPLATES.document_share || TEMPLATE_META.document_share.default, { label: d.notes || "document", link: fullUrl }));
                return `
                <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:center; gap:8px; border-bottom:1px solid #EFE9DC;">
                  <div style="min-width:0;">
                    <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${d.notes ? `<strong>${d.notes}</strong> — ` : ""}${d.original_name}</div>
                  </div>
                  <div style="display:flex; gap:4px; flex-shrink:0;">
                    <button class="btn-ghost attach-library-doc-btn" data-doc-id="${d.id}" style="font-size:12px; padding:3px 8px;">+ Attach to event</button>
                    ${waClientPhone ? `<a class="btn-ghost" href="https://wa.me/${waClientPhone}?text=${waText}" target="_blank" style="font-size:12px; padding:3px 8px;">Send to client</a>` : ""}
                  </div>
                </div>
              `;
              }).join("")}
            </div>
          ` : ""}

          <div class="row-2" style="margin-top:8px;">
            <input type="text" id="eventDocLabel" list="eventDocLabelOptions" placeholder="Label (e.g. Tech Rider, Contract)" />
            <input type="file" id="eventDocFile" />
          </div>
          <datalist id="eventDocLabelOptions">
            <option value="Tech Rider"></option>
            <option value="Hospitality Rider"></option>
            <option value="Contract"></option>
            <option value="Invoice"></option>
          </datalist>
          <button class="btn-ghost full" id="uploadEventDocBtn" style="margin-top:8px;">+ Upload document</button>
        </div>
        <div class="modal-foot">
          <button class="btn-ghost" id="openChatBtn">💬 Event chat</button>
          <button class="btn-ghost" id="cancelModal">Close</button>
          <button class="btn-primary" id="submitModal">Save</button>
        </div>
      </div>
    </div>
  `;
  const close = () => (root.innerHTML = "");
  root.querySelector("#closeModal").addEventListener("click", close);
  root.querySelector("#cancelModal").addEventListener("click", close);
  root.querySelector("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") close(); });
  root.querySelector("#openChatBtn").addEventListener("click", () => openEventChat(leadId, lead.name));
  root.querySelector("#addMemberInlineBtn").addEventListener("click", () => {
    openAddMemberModal(() => openAssignTeamModal(leadId));
  });
  root.querySelector("#reimbTeamId").addEventListener("change", (e) => {
    root.querySelector("#reimbArtistName").style.display = e.target.value === "__other__" ? "block" : "none";
  });
  root.querySelector("#addReimbursementBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const teamIdVal = root.querySelector("#reimbTeamId").value;
    const amount = root.querySelector("#reimbAmount").value.trim();
    const artistName = root.querySelector("#reimbArtistName").value.trim();
    if (!teamIdVal) return alert("Choose an artist.");
    if (teamIdVal === "__other__" && !artistName) return alert("Enter the artist's name.");
    if (!amount) return alert("Enter an amount.");
    btn.disabled = true;
    try {
      await api("/api/reimbursements", {
        method: "POST",
        body: JSON.stringify({
          leadId,
          teamId: teamIdVal === "__other__" ? null : teamIdVal,
          artistName: teamIdVal === "__other__" ? artistName : null,
          amount,
          notes: root.querySelector("#reimbNotes").value.trim(),
        }),
      });
      openAssignTeamModal(leadId);
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  });
  root.querySelectorAll("[data-delete-event-doc]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this document?")) return;
      await fetch(`/api/documents/${btn.dataset.deleteEventDoc}`, { method: "DELETE" });
      openAssignTeamModal(leadId);
    });
  });
  root.querySelectorAll(".attach-library-doc-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Attaching…";
      try {
        await api(`/api/documents/${btn.dataset.docId}/attach`, {
          method: "POST",
          body: JSON.stringify({ leadId }),
        });
        openAssignTeamModal(leadId);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });
  root.querySelector("#uploadEventDocBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const fileInput = root.querySelector("#eventDocFile");
    if (!fileInput.files[0]) return alert("Choose a file first.");
    const formData = new FormData();
    formData.append("file", fileInput.files[0]);
    formData.append("leadId", leadId);
    formData.append("notes", root.querySelector("#eventDocLabel").value || "");
    btn.disabled = true;
    btn.textContent = "Uploading…";
    try {
      await fetch("/api/documents", { method: "POST", body: formData });
      openAssignTeamModal(leadId);
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
      btn.textContent = "+ Upload document";
    }
  });
  root.querySelectorAll(".mark-response-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      try {
        await api(`/api/assignments/${sel.dataset.assignmentId}/mark-response`, {
          method: "PATCH",
          body: JSON.stringify({ status: sel.value }),
        });
        openAssignTeamModal(leadId);
      } catch (err) {
        alert(err.message);
      }
    });
  });
  root.querySelectorAll("[data-remove-temp-artist]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/temp-artists/${btn.dataset.removeTempArtist}`, { method: "DELETE" });
      openAssignTeamModal(leadId);
    });
  });

  // Shared by the dedicated button and the main Save button, so a filled-in
  // temporary artist is never silently lost just because someone hit Save instead.
  // isSubmittingTempArtist guards against double-clicks firing two POSTs before
  // the modal re-renders and clears the form.
  let isSubmittingTempArtist = false;
  const submitPendingTempArtist = async () => {
    const name = root.querySelector("#taName").value.trim();
    if (!name) return true; // nothing pending — not an error
    if (isSubmittingTempArtist) return false; // a submission is already in flight
    isSubmittingTempArtist = true;
    try {
      const feeInput = root.querySelector("#taFee");
      await api(`/api/leads/${leadId}/temp-artists`, {
        method: "POST",
        body: JSON.stringify({
          name,
          phone: root.querySelector("#taPhone").value.trim(),
          description: root.querySelector("#taDescription").value.trim(),
          feeAmount: feeInput ? (feeInput.value.trim() || null) : null,
        }),
      });
      return true;
    } catch (err) {
      alert(err.message);
      return false;
    } finally {
      isSubmittingTempArtist = false;
    }
  };
  root.querySelector("#addTempArtistBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      if (await submitPendingTempArtist()) openAssignTeamModal(leadId);
    } finally {
      btn.disabled = false;
    }
  });

  root.querySelector("#submitModal").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    const checked = [...root.querySelectorAll('input[type="checkbox"][data-team-id]:checked')].map((c) => c.dataset.teamId);
    const unchecked = [...root.querySelectorAll('input[type="checkbox"][data-team-id]:not(:checked)')].map((c) => c.dataset.teamId);
    try {
      if (!(await submitPendingTempArtist())) { btn.disabled = false; return; }
      const newlyChecked = checked.filter((id) => !byTeamId[id]);
      if (newlyChecked.length > 0) {
        await api(`/api/leads/${leadId}/assignments`, { method: "POST", body: JSON.stringify({ teamIds: newlyChecked }) });
      }
      for (const teamId of unchecked) {
        if (byTeamId[teamId]) await api(`/api/assignments/${byTeamId[teamId].id}`, { method: "DELETE" });
      }
      if (isAdmin) {
        for (const input of root.querySelectorAll(".member-fee-input")) {
          const teamId = input.dataset.teamId;
          if (!checked.includes(teamId)) continue; // not assigned — don't record a fee for them
          const value = input.value.trim();
          const numValue = value ? Number(value) : 0;
          const existing = feeExpenseByTeamId[teamId];
          if (existing && numValue <= 0) {
            // Cleared or set to 0 — remove the fee entirely, rather than leaving
            // a stale record that reappears next time the modal is opened.
            await api(`/api/expenses/${existing.id}`, { method: "DELETE" });
          } else if (existing && numValue > 0 && numValue !== Number(existing.amount)) {
            await api(`/api/expenses/${existing.id}`, { method: "PATCH", body: JSON.stringify({ amount: numValue }) });
          } else if (!existing && numValue > 0) {
            const member = TEAM.find((m) => m.id === teamId);
            await api("/api/expenses", {
              method: "POST",
              body: JSON.stringify({ head: `Artist fee — ${member?.name || ""}`, amount: numValue, leadId, teamId, paid: false }),
            });
          }
        }
      }
      const eventTime = root.querySelector("#eventTimeInput").value;
      const soundcheckTime = root.querySelector("#soundcheckTimeInput").value;
      const venue = root.querySelector("#venueInput").value;
      if (eventTime !== (lead.event_time || "") || soundcheckTime !== (lead.soundcheck_time || "") || venue !== (lead.venue || "")) {
        await api(`/api/leads/${leadId}`, { method: "PATCH", body: JSON.stringify({ eventTime: eventTime || null, soundcheckTime: soundcheckTime || null, venue: venue || null }) });
      }
      await refreshLeads();
      close();
      renderMain();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  });
}

// ---------- Accounts ----------
async function renderAccounts(main) {
  const [{ bookings, totals }, expenses, pendingReimbursements] = await Promise.all([
    api("/api/accounts"),
    api("/api/expenses"),
    api("/api/reimbursements/pending").catch(() => []),
  ]);
  const sortedBookings = bookings.slice().sort((a, b) => new Date(a.date) - new Date(b.date));

  main.innerHTML = `
    <div class="view-head">
      <div><h2>Accounts</h2><p class="muted">Confirmed events, what's owed, and what's outstanding.</p></div>
      <button class="btn-ghost" id="exportExcelBtn">⬇ Export to Excel</button>
    </div>
    <div class="accounts-summary">
      <div class="card summary-card"><div class="muted">Confirmed</div><div class="mono big">${inr(totals.quoted)}</div></div>
      <div class="card summary-card"><div class="muted">Amount received</div><div class="mono big" style="color:${STAGE_COLOR.Confirmed}">${inr(totals.received)}</div></div>
      <div class="card summary-card"><div class="muted">Outstanding</div><div class="mono big" style="color:${STAGE_COLOR["Follow-up"]}">${inr(totals.outstanding)}</div></div>
      <div class="card summary-card"><div class="muted">Total profit</div><div class="mono big" style="color:${totals.profit >= 0 ? "#5C8A6B" : "#A64B3C"}">${inr(totals.profit)}</div></div>
    </div>

    <div class="section-label">Events — tap one to add a payment or view its ledger</div>
    <input type="text" id="acctSearch" placeholder="🔍 Search events by name…" style="margin-bottom:10px;" />
    <div id="acctCards" style="margin-bottom:24px;"></div>

    <div class="section-label">Add an expense or artist fee</div>
    <div class="card" style="margin-bottom:20px;">
      <div class="upload-form" style="margin-bottom:0;">
        <select id="expLead">
          <option value="">Not tied to a specific event</option>
          ${LEADS.slice().sort((a, b) => new Date(a.date) - new Date(b.date)).map((l) => `<option value="${l.id}">${l.name} — ${fmtDate(l.date)}${l.city ? `, ${l.city}` : ""}</option>`).join("")}
        </select>
        <select id="expType">
          <optgroup label="Artist fee">
            ${TEAM.map((m) => `<option value="team:${m.id}">${m.name}</option>`).join("")}
          </optgroup>
          <optgroup label="Other">
            <option value="Travel">Travel</option>
            <option value="Lights">Lights</option>
            <option value="Sound">Sound</option>
            <option value="custom">Custom…</option>
          </optgroup>
        </select>
        <input id="expCustomHead" placeholder="Custom expense name" style="display:none; flex:1; min-width:140px;" />
        <input id="expAmount" type="number" placeholder="Amount ₹" style="width:130px;" />
        <input id="expDate" type="date" max="${new Date().toISOString().slice(0, 10)}" />
        <select id="expMode">
          <option value="">Mode —</option>
          <option value="Cash">Cash</option>
          <option value="UPI">UPI</option>
        </select>
        <label class="muted small" style="display:flex; align-items:center; gap:5px; white-space:nowrap;">
          <input type="checkbox" id="expPaidNow" /> Already paid
        </label>
        <button class="btn-primary" id="addExpenseBtn">Add</button>
      </div>
    </div>

    <div class="section-label">Pending expenses (not yet paid)${expenses.filter((e) => !e.paid).length ? ` — ${expenses.filter((e) => !e.paid).length}` : ""}</div>
    <div class="card" style="margin-bottom:20px;"><div id="expenseRows"></div></div>

    <div class="section-label">Reimbursement requests${pendingReimbursements.length ? ` — ${pendingReimbursements.length} pending` : ""}</div>
    <div class="card" style="margin-bottom:20px;"><div id="reimbRows"></div></div>

    <div class="section-label">Recent transactions</div>
    <div class="card"><div id="txnRows"><p class="muted small">Loading…</p></div></div>
  `;

  api("/api/transactions").then((txns) => {
    const txnRows = main.querySelector("#txnRows");
    if (!txnRows) return;
    if (txns.length === 0) { txnRows.innerHTML = `<p class="muted small">No transactions recorded yet</p>`; return; }
    txnRows.innerHTML = "";
    txns.forEach((t) => {
      txnRows.appendChild(el(`
        <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div>
            <div>${t.party_name} <span class="muted small">— ${t.description}</span></div>
            <div class="muted small mono">${fmtDate(t.date)}${t.mode ? ` · ${t.mode}` : ""}</div>
          </div>
          <span class="mono" style="color:${t.direction === "in" ? "#5C8A6B" : "#A64B3C"}; flex-shrink:0;">${t.direction === "in" ? "+" : "−"}${inr(t.amount)}</span>
        </div>
      `));
    });
  });

  // ---- Events: searchable, tap-to-manage cards ----
  const acctCards = main.querySelector("#acctCards");
  function renderAcctCards(filterText) {
    const q = (filterText || "").trim().toLowerCase();
    const filtered = q ? sortedBookings.filter((l) => l.name.toLowerCase().includes(q)) : sortedBookings;
    if (filtered.length === 0) {
      acctCards.innerHTML = `<div class="board-empty">${sortedBookings.length === 0 ? "No confirmed or completed bookings yet" : "No events match that search"}</div>`;
      return;
    }
    acctCards.innerHTML = "";
    filtered.forEach((l) => {
      const total = l.final_amount || l.quote_amount || 0;
      const balance = total - l.received;
      const card = el(`
        <div class="card lead-card" style="margin-bottom:10px; cursor:pointer;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
            <div>
              <div class="lead-name">${l.name}${l.comboEvents && l.comboEvents.length > 1 ? ` <span class="muted small" style="color:#8A5FA8;">🔗 ${l.comboEvents.length} events</span>` : ""}</div>
              <div class="muted small">${fmtDate(l.date)}${l.city ? ` · ${l.city}` : ""}</div>
            </div>
            <span class="tag" style="color:${STAGE_COLOR[l.stage]}; flex-shrink:0;">${l.stage}</span>
          </div>
          <div class="lead-card-financials acct-financials">
            <div><span class="muted small">Final</span><div class="mono">${total ? inr(total) : "—"}</div></div>
            <div><span class="muted small">Received</span><div class="mono">${inr(l.received)}</div></div>
            <div><span class="muted small">Balance</span><div class="mono" style="color:${balance > 0 ? "#A64B3C" : "#5C8A6B"};">${inr(balance)}</div></div>
            <div><span class="muted small">Profit</span><div class="mono" style="color:${l.profit == null ? "inherit" : l.profit >= 0 ? "#5C8A6B" : "#A64B3C"};">${l.profit == null ? "See combo" : inr(l.profit)}</div></div>
          </div>
        </div>
      `);
      card.addEventListener("click", () => openLeadPaymentsModal(l.id));
      acctCards.appendChild(card);
    });
  }
  renderAcctCards("");
  main.querySelector("#acctSearch").addEventListener("input", (e) => renderAcctCards(e.target.value));

  // ---- Pending expenses: compact tap-friendly rows ----
  function renderExpenseRows() {
    const expRows = main.querySelector("#expenseRows");
    const pending = expenses.filter((e) => !e.paid);
    if (pending.length === 0) { expRows.innerHTML = `<p class="muted small">Nothing pending — all expenses are paid</p>`; return; }
    expRows.innerHTML = "";
    pending.forEach((e) => {
      const lead = LEADS.find((l) => l.id === e.lead_id);
      const member = TEAM.find((m) => m.id === e.team_id);
      expRows.appendChild(el(`
        <div class="dash-list-item">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <div>
              <div>${e.head}${member && !e.head.includes(member.name) ? ` <span class="muted small">— ${member.name}</span>` : ""}</div>
              <div class="muted small">${lead ? lead.name : "General"}</div>
            </div>
            <span class="mono" style="flex-shrink:0;">${inr(e.amount)}</span>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:8px;">
            <input type="date" class="exp-date" data-exp-id="${e.id}" value="${e.payment_date || ""}" max="${new Date().toISOString().slice(0, 10)}" style="flex:1; min-width:130px;" />
            <select class="exp-mode" data-exp-id="${e.id}" style="width:100px;">
              <option value="">Mode —</option>
              <option value="Cash" ${e.payment_mode === "Cash" ? "selected" : ""}>Cash</option>
              <option value="UPI" ${e.payment_mode === "UPI" ? "selected" : ""}>UPI</option>
            </select>
            <label class="muted small" style="display:flex; align-items:center; gap:4px; white-space:nowrap;"><input type="checkbox" class="exp-paid" data-exp-id="${e.id}" ${e.paid ? "checked" : ""} /> Paid</label>
            <button class="btn-ghost exp-save-btn" data-exp-id="${e.id}" style="padding:5px 10px; font-size:12.5px;">Done</button>
            <button class="icon-btn" data-delete-exp="${e.id}">✕</button>
          </div>
        </div>
      `));
    });
    expRows.querySelectorAll(".exp-save-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.expId;
        const paid = expRows.querySelector(`.exp-paid[data-exp-id="${id}"]`).checked;
        const date = expRows.querySelector(`.exp-date[data-exp-id="${id}"]`).value;
        const mode = expRows.querySelector(`.exp-mode[data-exp-id="${id}"]`).value;
        if (paid && !date) return alert("Enter the payment date before marking this paid.");
        try {
          await api(`/api/expenses/${id}`, { method: "PATCH", body: JSON.stringify({ paid, paymentDate: date || null, paymentMode: mode || null }) });
          renderMain();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    expRows.querySelectorAll("[data-delete-exp]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/expenses/${btn.dataset.deleteExp}`, { method: "DELETE" });
        renderMain();
      });
    });
  }
  renderExpenseRows();

  // ---- Reimbursement requests: compact tap-friendly rows ----
  function renderReimbRows() {
    const reimbRows = main.querySelector("#reimbRows");
    if (pendingReimbursements.length === 0) { reimbRows.innerHTML = `<p class="muted small">No reimbursement requests pending</p>`; return; }
    reimbRows.innerHTML = "";
    pendingReimbursements.forEach((r) => {
      const lead = LEADS.find((l) => l.id === r.lead_id);
      reimbRows.appendChild(el(`
        <div class="dash-list-item">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <div>
              <div>${r.head}${r.notes ? ` <span class="muted small">— ${r.notes}</span>` : ""}</div>
              <div class="muted small">${lead ? lead.name : "General"} · requested by ${r.requested_by || "—"}</div>
            </div>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:8px;">
            <input type="number" class="reimb-amount" data-reimb-id="${r.id}" value="${r.amount}" style="width:90px;" />
            <input type="date" class="reimb-date" data-reimb-id="${r.id}" max="${new Date().toISOString().slice(0, 10)}" style="flex:1; min-width:130px;" />
            <select class="reimb-mode" data-reimb-id="${r.id}" style="width:100px;">
              <option value="">Mode —</option>
              <option value="Cash">Cash</option>
              <option value="UPI">UPI</option>
            </select>
            <button class="btn-ghost reimb-approve-btn" data-reimb-id="${r.id}" style="padding:5px 10px; font-size:12.5px;">Approve</button>
            <button class="icon-btn" data-reject-reimb="${r.id}">✕</button>
          </div>
        </div>
      `));
    });
    reimbRows.querySelectorAll(".reimb-approve-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.reimbId;
        const amount = reimbRows.querySelector(`.reimb-amount[data-reimb-id="${id}"]`).value;
        const date = reimbRows.querySelector(`.reimb-date[data-reimb-id="${id}"]`).value;
        const mode = reimbRows.querySelector(`.reimb-mode[data-reimb-id="${id}"]`).value;
        const markPaid = confirm("Mark this reimbursement as paid now? Cancel to approve it as unpaid (settle later).");
        if (markPaid && !date) return alert("Enter the payment date before marking this paid.");
        try {
          await api(`/api/reimbursements/${id}/approve`, {
            method: "POST",
            body: JSON.stringify({ amount, paid: markPaid, paymentDate: date || null, paymentMode: mode || null }),
          });
          renderMain();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    reimbRows.querySelectorAll("[data-reject-reimb]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Reject and remove this reimbursement request?")) return;
        await api(`/api/reimbursements/${btn.dataset.rejectReimb}`, { method: "DELETE" });
        renderMain();
      });
    });
  }
  renderReimbRows();

  main.querySelector("#expType").addEventListener("change", (e) => {
    main.querySelector("#expCustomHead").style.display = e.target.value === "custom" ? "block" : "none";
  });

  main.querySelector("#addExpenseBtn").addEventListener("click", async () => {
    const expType = main.querySelector("#expType").value;
    const amount = main.querySelector("#expAmount").value;
    if (!amount) return alert("Enter an amount.");
    let head, teamId = null;
    if (expType.startsWith("team:")) {
      teamId = expType.slice(5);
      head = `Artist fee — ${TEAM.find((m) => m.id === teamId)?.name || ""}`;
    } else if (expType === "custom") {
      head = main.querySelector("#expCustomHead").value;
      if (!head) return alert("Enter a name for the custom expense.");
    } else {
      head = expType;
    }
    const paidNow = main.querySelector("#expPaidNow").checked;
    const expDate = main.querySelector("#expDate").value;
    if (paidNow && !expDate) return alert("Enter the payment date, or uncheck 'Already paid'.");
    await api("/api/expenses", {
      method: "POST",
      body: JSON.stringify({
        head,
        amount,
        leadId: main.querySelector("#expLead").value || null,
        teamId,
        paid: paidNow,
        paymentDate: expDate || null,
        paymentMode: main.querySelector("#expMode").value || null,
      }),
    });
    renderMain();
  });

  main.querySelector("#exportExcelBtn").addEventListener("click", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(LEADS), "Leads");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bookings), "Accounts");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(expenses), "Expenses");
    XLSX.writeFile(wb, `TOL-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
}

// ---------- Dashboard ----------
async function renderDashboard(main) {
  const isAdmin = CURRENT_USER?.accessLevel === "admin";
  const canCoordinate = isAdmin || canAssignTeam();
  const [data, announcements, teamNotifs, activity, stickyNote] = await Promise.all([
    api("/api/dashboard"),
    api("/api/announcements"),
    canCoordinate ? api("/api/admin/notifications") : Promise.resolve([]),
    isAdmin ? api("/api/activity") : Promise.resolve([]),
    api("/api/my/sticky-note").catch(() => ({ content: "" })),
  ]);
  main.innerHTML = `
    <div class="view-head">
      <div><h2>Dashboard</h2><p class="muted">The three things that matter today — click any card to see the list.</p></div>
      <button class="btn-ghost" id="dashExportBtn">⬇ Export to Excel</button>
    </div>
    <div class="card" id="stickyNoteCard" style="margin-bottom:16px; background:#FBF3D9; border-color:#E8D488;">
      <div class="section-label" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <span>📌 Sticky note</span>
        <span class="muted small" id="stickyNoteStatus" style="font-weight:400;"></span>
      </div>
      <textarea id="stickyNoteInput" rows="3" placeholder="Jot something down for yourself…" style="width:100%; padding:8px 10px; border:1px solid #E0CE8A; border-radius:6px; font-family:inherit; font-size:13px; background:#FFFDF6; resize:vertical;">${stickyNote.content || ""}</textarea>
    </div>
    ${!canCoordinate ? `
      <div class="card" style="margin-bottom:16px;">
        <div class="section-label">✉️ Message admin</div>
        <p class="muted small" style="margin-top:-4px;">Not about a specific event? Send a quick note here instead.</p>
        <textarea id="generalMsgInput" rows="2" placeholder="e.g. Running late today, can we talk about next month's schedule..." style="width:100%; padding:10px; border:1px solid #DDD5C4; border-radius:6px; font-family:inherit; font-size:14px;"></textarea>
        <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
          <button class="btn-primary" id="sendGeneralMsgBtn">Send</button>
          <span class="muted small" id="generalMsgSentNote" style="display:none; color:#5C8A6B;">Sent ✓</span>
        </div>
      </div>
    ` : ""}
    ${teamNotifs.length > 0 ? `
      <div class="section-label" style="display:flex; justify-content:space-between; align-items:center;">
        <span>🔔 Notifications</span>
        <button class="btn-ghost" id="clearAllNotifsBtn" style="font-size:11.5px; padding:3px 8px; font-weight:400;">Clear all</button>
      </div>
      <div class="card reminder-flash" id="teamNotifCard" style="margin-bottom:16px;">
        ${teamNotifs.map((n) => `
          <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
              <div>${n.message}</div>
              <div class="muted small">${fmtDateTime(n.created_at)}</div>
            </div>
            <div style="display:flex; gap:6px; flex-shrink:0;">
              ${n.assignment_status === "cancel_requested" ? `
                <button class="btn-primary" data-resolve-cancel="${n.assignment_id}" data-approve="true" style="padding:5px 10px; font-size:12px;">Approve</button>
                <button class="btn-ghost" data-resolve-cancel="${n.assignment_id}" data-approve="false" style="padding:5px 10px; font-size:12px;">Reject</button>
              ` : ""}
              <button class="icon-btn" data-dismiss-admin-notif="${n.id}">✕</button>
            </div>
          </div>
        `).join("")}
      </div>
    ` : ""}
    ${announcements.length > 0 ? `
      <div class="section-label">📢 Announcements</div>
      <div class="card" style="margin-bottom:16px; border-color:#C1602B;">
        ${announcements.map((a) => `
          <div class="dash-list-item">
            <div>${a.message}</div>
            <div class="muted small">${a.created_by} · ${fmtDateTime(a.created_at)}</div>
          </div>
        `).join("")}
      </div>
    ` : ""}
    <div class="dash-stats">
      ${hasLeadsAccess() ? `
      <button class="card dash-stat dash-stat-click" id="statNew"><div class="muted">New queries</div><div class="mono big">${data.newLeadsCount}</div></button>
      <button class="card dash-stat dash-stat-click" id="statFollowup"><div class="muted">Awaiting follow-up</div><div class="mono big" style="color:${STAGE_COLOR["Follow-up"]}">${data.pendingFollowUps.length}</div></button>
      <button class="card dash-stat dash-stat-click" id="statInterested"><div class="muted">Interested</div><div class="mono big" style="color:${STAGE_COLOR.Interested}">${data.interestedLeads.length}</div></button>
      <button class="card dash-stat dash-stat-click" id="statTentative"><div class="muted">Tentative holds</div><div class="mono big" style="color:${STAGE_COLOR.Tentative}">${data.tentativeBookings.length}</div></button>
      ` : ""}
      <button class="card dash-stat dash-stat-click" id="statUpcoming"><div class="muted">Upcoming events</div><div class="mono big" style="color:${STAGE_COLOR.Confirmed}">${data.upcomingEventsCount}</div></button>
    </div>
    <div class="card" id="dashCalCard" style="margin-bottom:16px;">
      <div class="section-label">Calendar</div>
      ${calendarGridMarkup()}
    </div>
    ${isAdmin ? `
    <div class="card" style="margin-bottom:16px;">
      <div class="section-label" style="display:flex; justify-content:space-between; align-items:center;">
        <span>📋 Today's activity</span>
        ${activity.length > 0 ? `<button class="btn-ghost" id="clearAllActivityBtn" style="font-size:11.5px; padding:3px 8px; font-weight:400;">Clear all</button>` : ""}
      </div>
      ${activity.length === 0 ? `<p class="muted small">Nothing logged yet today.</p>` : `
        <div class="activity-log">
          ${activity.map((a) => `
            <div class="dash-list-item" style="display:flex; gap:10px; justify-content:space-between; align-items:flex-start;">
              <div style="display:flex; gap:10px;">
                <span class="muted small mono" style="flex-shrink:0; width:52px;">${fmtTime(a.created_at)}</span>
                <span>${a.message}${a.actor && a.actor !== "System" ? ` <span class="muted small">— ${a.actor}</span>` : ""}</span>
              </div>
              <button class="icon-btn" data-dismiss-activity="${a.id}" title="Remove this entry">✕</button>
            </div>
          `).join("")}
        </div>
      `}
    </div>
    ` : ""}
    <div class="dash-grid">
      <div class="card">
        <div class="section-label">Upcoming events${data.upcomingEventsCount > data.upcomingEvents.length ? ` <span class="muted" style="font-weight:400;">(next ${data.upcomingEvents.length} of ${data.upcomingEventsCount} — see all in Leads)</span>` : ""}</div>
        ${data.upcomingEvents.length === 0 ? `<p class="muted small">Nothing confirmed and upcoming yet.</p>` : data.upcomingEvents.map((l) => `
          <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <div class="dash-list-item-click" data-lead-id="${l.id}" style="flex:1; cursor:pointer;">
              <div>${l.name} — <span class="mono">${fmtDate(l.date)}</span></div>
              <div class="muted">${packageName(l.event_type)} · ${l.city || ""}</div>
            </div>
            <button class="btn-ghost open-event-chat-btn" data-lead-id="${l.id}" data-lead-name="${l.name}" style="flex-shrink:0; font-size:12px; padding:4px 8px;">💬 Chat</button>
          </div>
        `).join("")}
      </div>
      ${hasLeadsAccess() ? `
      <div class="card">
        <div class="section-label">Leads waiting on a follow-up</div>
        ${data.pendingFollowUps.length === 0 ? `<p class="muted small">No one's waiting on you right now.</p>` : data.pendingFollowUps.map((l) => `
          <div class="dash-list-item dash-list-item-click" data-lead-id="${l.id}">
            <div>${l.name} <span class="muted">— ${packageName(l.event_type)}</span></div>
            <div class="muted">${fmtDate(l.date)} · ${l.city || ""}</div>
          </div>
        `).join("")}
      </div>
      ` : ""}
    </div>
  `;

  wireCalendarGrid(main.querySelector("#dashCalCard"));
  {
    const noteInput = main.querySelector("#stickyNoteInput");
    const noteStatus = main.querySelector("#stickyNoteStatus");
    let saveTimeout = null;
    const saveNote = async () => {
      noteStatus.textContent = "Saving…";
      try {
        await api("/api/my/sticky-note", { method: "PUT", body: JSON.stringify({ content: noteInput.value }) });
        noteStatus.textContent = "Saved ✓";
        setTimeout(() => { if (noteStatus.textContent === "Saved ✓") noteStatus.textContent = ""; }, 1500);
      } catch (err) {
        noteStatus.textContent = "Couldn't save";
      }
    };
    noteInput.addEventListener("input", () => {
      noteStatus.textContent = "";
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(saveNote, 800);
    });
    noteInput.addEventListener("blur", () => {
      if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; saveNote(); }
    });
  }
  main.querySelectorAll("[data-resolve-cancel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/assignments/${btn.dataset.resolveCancel}/resolve-cancel`, {
        method: "POST",
        body: JSON.stringify({ approve: btn.dataset.approve === "true" }),
      });
      renderMain();
    });
  });
  main.querySelectorAll("[data-dismiss-admin-notif]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/admin/notifications/${btn.dataset.dismissAdminNotif}`, { method: "DELETE" });
      btn.closest(".dash-list-item").remove();
    });
  });
  const clearAllNotifsBtn = main.querySelector("#clearAllNotifsBtn");
  if (clearAllNotifsBtn) {
    clearAllNotifsBtn.addEventListener("click", async () => {
      if (!confirm("Clear all notifications? Any pending cancellation requests will still need resolving from the affected event's Team page.")) return;
      await api("/api/admin/notifications", { method: "DELETE" });
      renderMain();
    });
  }
  main.querySelectorAll("[data-dismiss-activity]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/activity/${btn.dataset.dismissActivity}`, { method: "DELETE" });
      btn.closest(".dash-list-item").remove();
    });
  });
  const clearAllActivityBtn = main.querySelector("#clearAllActivityBtn");
  if (clearAllActivityBtn) {
    clearAllActivityBtn.addEventListener("click", async () => {
      if (!confirm("Clear today's entire activity log?")) return;
      await api("/api/activity", { method: "DELETE" });
      renderMain();
    });
  }
  const generalMsgBtn = main.querySelector("#sendGeneralMsgBtn");
  if (generalMsgBtn) {
    generalMsgBtn.addEventListener("click", async () => {
      const input = main.querySelector("#generalMsgInput");
      const body = input.value.trim();
      if (!body) return;
      generalMsgBtn.disabled = true;
      try {
        await api("/api/messages/general", { method: "POST", body: JSON.stringify({ body }) });
        input.value = "";
        const note = main.querySelector("#generalMsgSentNote");
        note.style.display = "inline";
        setTimeout(() => { note.style.display = "none"; }, 2000);
      } catch (err) {
        alert(err.message);
      } finally {
        generalMsgBtn.disabled = false;
      }
    });
  }

  main.querySelector("#dashExportBtn").addEventListener("click", async () => {
    const [{ bookings }, expenses] = await Promise.all([api("/api/accounts"), api("/api/expenses")]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(LEADS), "Leads");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bookings), "Accounts");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(expenses), "Expenses");
    XLSX.writeFile(wb, `TOL-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
  const openEventForCurrentUser = (leadId, fallbackStage) => {
    if (hasLeadsAccess()) {
      const lead = LEADS.find((l) => l.id === leadId);
      goToLeads(lead ? lead.stage : (fallbackStage || "all"));
    } else if (canAssignTeam()) {
      openAssignTeamModal(leadId);
    }
    // No Leads access and no assign_team capability: nothing appropriate to open.
  };
  const statNewEl = main.querySelector("#statNew");
  if (statNewEl) statNewEl.addEventListener("click", () => goToLeads("New"));
  const statFollowupEl = main.querySelector("#statFollowup");
  if (statFollowupEl) statFollowupEl.addEventListener("click", () => goToLeads("Follow-up"));
  const statInterestedEl = main.querySelector("#statInterested");
  if (statInterestedEl) statInterestedEl.addEventListener("click", () => goToLeads("Interested"));
  const statTentativeEl = main.querySelector("#statTentative");
  if (statTentativeEl) statTentativeEl.addEventListener("click", () => goToLeads("Tentative"));
  main.querySelector("#statUpcoming").addEventListener("click", () => {
    if (hasLeadsAccess()) goToLeads("Confirmed");
    else { currentTab = "calendar"; renderNav(); renderMain(); }
  });
  main.querySelectorAll(".dash-list-item-click").forEach((row) => {
    row.addEventListener("click", () => openEventForCurrentUser(row.dataset.leadId));
  });
  main.querySelectorAll(".open-event-chat-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEventChat(btn.dataset.leadId, btn.dataset.leadName);
    });
  });
}

// ---------- Tasks ----------
async function renderTasks(main) {
  main.innerHTML = `<div class="view-head"><div><h2>Tasks &amp; Chats</h2></div></div><p class="muted">Loading…</p>`;
  await refreshLeads();
  const chatEvents = LEADS.filter((l) => l.stage === "Confirmed").sort((a, b) => new Date(a.date) - new Date(b.date));
  main.innerHTML = `
    <div class="view-head"><div><h2>Tasks &amp; Chats</h2><p class="muted">The checklist behind each booking, and the team chat for each event.</p></div></div>

    <div class="section-label">Team chats</div>
    <div class="card" style="margin-bottom:20px;">
      ${chatEvents.length === 0 ? `<p class="muted small">No confirmed events yet — chats appear here once an event is Confirmed.</p>` : chatEvents.map((l) => `
        <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div>${l.name}</div>
            <div class="muted small">${packageName(l.event_type)} · ${fmtDate(l.date)} · ${l.city || ""}</div>
          </div>
          <button class="btn-ghost open-event-chat-btn" data-lead-id="${l.id}" data-lead-name="${l.name}">💬 Open chat</button>
        </div>
      `).join("")}
    </div>

    <div class="section-label">Tasks</div>
    <div class="card" style="margin-bottom:16px;">
      <div class="section-label">New task</div>
      <div class="task-form">
        <input type="text" id="taskTitle" placeholder="e.g. Confirm venue booking" />
        <select id="taskLead"><option value="">No specific lead</option>${LEADS.slice().sort((a, b) => new Date(a.date) - new Date(b.date)).map((l) => `<option value="${l.id}">${l.name} — ${fmtDate(l.date)}${l.city ? `, ${l.city}` : ""}</option>`).join("")}</select>
        <select id="taskAssignee"><option value="">Unassigned</option>${TEAM.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}</select>
        <input type="date" id="taskDue" />
        <button class="btn-primary" id="addTaskBtn">Add</button>
      </div>
    </div>
    <div class="table">
      <div id="taskRows"></div>
    </div>
  `;

  main.querySelectorAll(".open-event-chat-btn").forEach((btn) => {
    btn.addEventListener("click", () => openEventChat(btn.dataset.leadId, btn.dataset.leadName));
  });

  const rows = main.querySelector("#taskRows");
  const today = new Date().toISOString().slice(0, 10);
  if (TASKS.length === 0) rows.innerHTML = `<div class="board-empty">No tasks yet — add one above</div>`;

  TASKS.forEach((t) => {
    const lead = LEADS.find((l) => l.id === t.lead_id);
    const assignee = TEAM.find((m) => m.id === t.assigned_to);
    const overdue = !t.done && t.due_date && t.due_date < today;
    rows.appendChild(el(`
      <div class="task-row${t.done ? " done" : ""}">
        <input type="checkbox" data-task-id="${t.id}" ${t.done ? "checked" : ""} />
        <div class="task-title">${t.title}${lead ? ` <span class="muted">— ${lead.name}</span>` : ""}</div>
        <div class="task-meta${overdue ? " task-overdue" : ""}">${t.due_date ? fmtDate(t.due_date) : "No due date"}</div>
        <div class="task-meta">${assignee ? assignee.name : "Unassigned"}</div>
        <button class="icon-btn" data-delete-task="${t.id}">✕</button>
      </div>
    `));
  });

  rows.querySelectorAll("[data-task-id]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      await api(`/api/tasks/${cb.dataset.taskId}`, { method: "PATCH", body: JSON.stringify({ done: cb.checked }) });
      await refreshTasks();
      renderMain();
    });
  });
  rows.querySelectorAll("[data-delete-task]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/tasks/${btn.dataset.deleteTask}`, { method: "DELETE" });
      await refreshTasks();
      renderMain();
    });
  });

  main.querySelector("#addTaskBtn").addEventListener("click", async () => {
    const title = main.querySelector("#taskTitle").value;
    if (!title) return;
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        leadId: main.querySelector("#taskLead").value || null,
        assignedTo: main.querySelector("#taskAssignee").value || null,
        dueDate: main.querySelector("#taskDue").value || null,
      }),
    });
    await refreshTasks();
    renderMain();
  });
}

// ---------- Documents ----------
async function renderDocuments(main) {
  // Completed events drop off here — once an event's done there's no more need to
  // send it documents — and the remaining (Confirmed) events sort soonest-first,
  // same convention as the Calendar tab's "Upcoming confirmed events" list.
  const eventLeads = LEADS.filter((l) => l.stage === "Confirmed").slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  main.innerHTML = `
    <div class="view-head"><div><h2>Documents</h2><p class="muted">General files, plus files kept against a specific confirmed event — tag riders/contracts and send them straight to the client.</p></div></div>
    <div class="card" style="margin-bottom:16px;">
      <div class="section-label">Upload a file</div>
      <div class="upload-form">
        <select id="docLead">
          <option value="">General (not tied to an event)</option>
          ${eventLeads.map((l) => `<option value="${l.id}">${l.name} — ${fmtDate(l.date)}${l.city ? `, ${l.city}` : ""}</option>`).join("")}
        </select>
        <input type="text" id="docLabel" list="docLabelOptions" placeholder="Label (e.g. Tech Rider, Hospitality Rider)" />
        <datalist id="docLabelOptions">
          <option value="Tech Rider"></option>
          <option value="Hospitality Rider"></option>
          <option value="Contract"></option>
          <option value="Invoice"></option>
        </datalist>
        <input type="file" id="docFile" />
        <button class="btn-primary" id="uploadBtn">Upload</button>
      </div>
      ${eventLeads.length === 0 ? `<p class="muted small" style="margin-top:8px;">No confirmed events yet — once a lead's stage is "Confirmed" or "Completed" it'll show up here to attach files to.</p>` : ""}
    </div>
    <div id="docGroups"></div>
  `;

  const docs = await api("/api/documents");
  const groups = main.querySelector("#docGroups");

  function renderRow(d, lead, showPicker) {
    const fullUrl = window.location.origin + d.url;
    const waPhone = lead ? (lead.whatsapp_number || lead.phone || "").replace(/\D/g, "") : "";
    const waText = encodeURIComponent(fillTemplate(MESSAGE_TEMPLATES.document_share || TEMPLATE_META.document_share.default, { label: d.notes || "document", link: fullUrl }));
    const clientsWithPhone = eventLeads.filter((l) => l.phone);
    return `
      <div class="doc-row">
        <div class="doc-name">${d.notes ? `<strong>${d.notes}</strong> — ` : ""}<a href="${d.url}" target="_blank">${d.original_name}</a></div>
        <div class="muted mono">${fmtDate(d.uploaded_at.slice(0, 10))}</div>
        ${lead && waPhone ? `<a class="btn-ghost" href="https://wa.me/${waPhone}?text=${waText}" target="_blank" style="font-size:12px; padding:4px 8px;">Send to client</a>` : ""}
        ${showPicker && clientsWithPhone.length > 0 ? `
          <select class="doc-send-select" data-doc-id="${d.id}" style="font-size:12px; max-width:140px;">
            <option value="">Send to…</option>
            ${clientsWithPhone.map((l) => `<option value="${l.id}">${l.name}</option>`).join("")}
          </select>
        ` : ""}
        <button class="icon-btn" data-delete-doc="${d.id}">✕</button>
      </div>
    `;
  }

  const general = docs.filter((d) => !d.lead_id);
  const byLead = {};
  docs.filter((d) => d.lead_id).forEach((d) => { (byLead[d.lead_id] = byLead[d.lead_id] || []).push(d); });

  let html = `
    <div class="card" style="margin-bottom:14px;">
      <div class="section-label">General documents</div>
      <p class="muted small" style="margin-top:-4px; margin-bottom:8px;">Shared across events — use "Send to…" on any row to send it to a specific client.</p>
      ${general.length === 0 ? `<p class="muted small">No general documents yet.</p>` : `<div class="table">${general.map((d) => renderRow(d, null, true)).join("")}</div>`}
    </div>
  `;

  eventLeads.forEach((l) => {
    const leadDocs = byLead[l.id] || [];
    html += `
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label">${l.name} — <span class="muted">${fmtDate(l.date)} · ${l.city || ""}</span></div>
        ${leadDocs.length === 0 ? `<p class="muted small">No documents uploaded for this event yet.</p>` : `<div class="table">${leadDocs.map((d) => renderRow(d, l, false)).join("")}</div>`}
      </div>
    `;
  });

  // Completed events' documents are intentionally left out entirely — once an
  // event's done, its files aren't part of this workflow anymore. Other stray
  // leads (e.g. still New) still show up here so nothing's silently hidden.
  const orphanLeadIds = Object.keys(byLead).filter((id) => {
    if (eventLeads.some((l) => l.id === id)) return false;
    const lead = LEADS.find((l) => l.id === id);
    return !lead || lead.stage !== "Completed";
  });
  orphanLeadIds.forEach((id) => {
    const lead = LEADS.find((l) => l.id === id);
    html += `
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label">${lead ? lead.name : "Unknown lead"} <span class="muted">(${lead ? lead.stage : "—"})</span></div>
        <div class="table">${byLead[id].map((d) => renderRow(d, null, false)).join("")}</div>
      </div>
    `;
  });

  groups.innerHTML = html;

  groups.querySelectorAll(".doc-send-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      if (!sel.value) return;
      const doc = general.find((d) => d.id === sel.dataset.docId);
      const lead = eventLeads.find((l) => l.id === sel.value);
      if (!doc || !lead || !(lead.whatsapp_number || lead.phone)) return;
      const fullUrl = window.location.origin + doc.url;
      const waPhone = (lead.whatsapp_number || lead.phone).replace(/\D/g, "");
      const waText = encodeURIComponent(fillTemplate(MESSAGE_TEMPLATES.document_share || TEMPLATE_META.document_share.default, { label: doc.notes || "document", link: fullUrl }));
      window.open(`https://wa.me/${waPhone}?text=${waText}`, "_blank");
      sel.value = "";
    });
  });

  groups.querySelectorAll("[data-delete-doc]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch(`/api/documents/${btn.dataset.deleteDoc}`, { method: "DELETE" });
      renderMain();
    });
  });

  main.querySelector("#uploadBtn").addEventListener("click", async () => {
    const fileInput = main.querySelector("#docFile");
    if (!fileInput.files[0]) return alert("Choose a file first.");
    const formData = new FormData();
    formData.append("file", fileInput.files[0]);
    formData.append("leadId", main.querySelector("#docLead").value || "");
    formData.append("notes", main.querySelector("#docLabel").value || "");
    const btn = main.querySelector("#uploadBtn");
    btn.disabled = true;
    btn.textContent = "Uploading…";
    try {
      await fetch("/api/documents", { method: "POST", body: formData });
      renderMain();
    } finally {
      btn.disabled = false;
      btn.textContent = "Upload";
    }
  });
}


function openConfirmEventModal(lead) {
  const root = document.getElementById("modalRoot");
  const conflict = LEADS.find((l) => l.id !== lead.id && (l.stage === "Confirmed" || l.stage === "Tentative") && l.date === lead.date);

  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal-card">
        <div class="modal-head"><h3>Confirm ${lead.name}</h3><button class="icon-btn" id="closeModal">✕</button></div>
        <div class="modal-body">
          <p class="muted small">This moves the lead to Confirmed and records the final closed rate.</p>
          ${conflict ? `
            <div style="background:#FFF4E5; color:#8A5A1F; padding:10px 12px; border-radius:6px; font-size:13px; margin-bottom:12px;">
              ⚠️ ${conflict.name} is already ${conflict.stage} for ${fmtDate(lead.date)}. Double-check before confirming another event the same day.
              ${conflict.stage === "Tentative" ? `<div style="margin-top:8px;"><button class="btn-ghost" id="reconfirmOtherBtn" style="font-size:12px; padding:4px 10px;">Reconfirm ${conflict.name} instead</button></div>` : ""}
            </div>
          ` : ""}
          ${lead.alt_date ? `
            <label>Event date</label>
            <select id="ceDateChoice">
              <option value="${lead.date}">${fmtDate(lead.date)} (original request)${conflict ? " — already booked" : ""}</option>
              <option value="${lead.alt_date}">${fmtDate(lead.alt_date)} (customer's alternative)</option>
            </select>
          ` : ""}
          <div class="muted small mono" style="margin-bottom:8px;">Quoted: ${lead.quote_amount ? inr(lead.quote_amount) : "—"}</div>
          <label>Final closed rate (₹)</label>
          <input id="ceAmount" type="number" value="${lead.quote_amount || ""}" placeholder="e.g. 145000" />
          <label style="margin-top:10px;">Advance received now (optional)</label>
          <div class="row-2">
            <input id="ceAdvanceAmount" type="number" placeholder="e.g. 20000" />
            <input id="ceAdvanceDate" type="date" value="${new Date().toISOString().slice(0, 10)}" max="${new Date().toISOString().slice(0, 10)}" />
          </div>
          <select id="ceAdvanceMode" style="margin-top:8px;">
            <option value="">Mode —</option>
            <option value="Cash">Cash</option>
            <option value="UPI">UPI</option>
          </select>
        </div>
        <div class="modal-foot"><button class="btn-ghost" id="cancelModal">Cancel</button><button class="btn-primary" id="submitModal">Confirm event</button></div>
      </div>
    </div>
  `;
  const close = () => { root.innerHTML = ""; renderMain(); };
  root.querySelector("#closeModal").addEventListener("click", close);
  root.querySelector("#cancelModal").addEventListener("click", close);
  root.querySelector("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") close(); });
  root.querySelector("#reconfirmOtherBtn")?.addEventListener("click", () => openConfirmEventModal(conflict));
  root.querySelector("#submitModal").addEventListener("click", async () => {
    const finalAmount = root.querySelector("#ceAmount").value;
    const chosenDate = root.querySelector("#ceDateChoice")?.value || lead.date;
    const stillConflicting = LEADS.find((l) => l.id !== lead.id && (l.stage === "Confirmed" || l.stage === "Tentative") && l.date === chosenDate);
    if (stillConflicting && !confirm(`${stillConflicting.name} is already ${stillConflicting.stage} for this date. Confirm ${lead.name} anyway?`)) {
      return;
    }
    try {
      await api(`/api/leads/${lead.id}`, { method: "PATCH", body: JSON.stringify({ stage: "Confirmed", finalAmount: finalAmount || null, date: chosenDate }) });
      const advanceAmount = root.querySelector("#ceAdvanceAmount").value;
      if (advanceAmount && Number(advanceAmount) > 0) {
        try {
          await api(`/api/leads/${lead.id}/payments`, {
            method: "POST",
            body: JSON.stringify({ amount: Number(advanceAmount), date: root.querySelector("#ceAdvanceDate").value, mode: root.querySelector("#ceAdvanceMode").value || null }),
          });
        } catch (err) {
          alert(`Event confirmed, but the advance couldn't be recorded: ${err.message}. You can add it from Accounts instead.`);
        }
      }
      await refreshLeads();
      const freshLead = LEADS.find((l) => l.id === lead.id) || { ...lead, stage: "Confirmed", final_amount: finalAmount || null, date: chosenDate };
      openConfirmationMessageModal(freshLead);
    } catch (err) {
      alert(err.message);
    }
  });
}

function openConfirmationMessageModal(lead) {
  const root = document.getElementById("modalRoot");
  const firstName = (lead.name || "").split(" ")[0] || "there";
  const finalAmount = lead.final_amount || lead.quote_amount || 0;
  const received = lead.received || 0;
  const outstanding = finalAmount - received;
  const isPheras = lead.event_type === "pheras";
  const amountLine = lead.final_amount ? `\nTotal: ₹${Number(lead.final_amount).toLocaleString("en-IN")}` : "";
  const tpl = MESSAGE_TEMPLATES.confirmed || TEMPLATE_META.confirmed.default;
  let message = fillTemplate(tpl, {
    firstName,
    clientName: lead.name || "",
    experience: packageName(lead.event_type),
    date: fmtDate(lead.date),
    cityClause: lead.city ? ` in ${lead.city}` : "",
    amountLine,
    location: lead.venue || lead.city || "",
    occasion: lead.occasion || "",
    pieces: lead.pcs || "",
    duration: lead.duration || "75-90 Minutes",
    performanceFee: finalAmount ? Number(finalAmount).toLocaleString("en-IN") : "",
    advance: Number(received || 0).toLocaleString("en-IN"),
    outstanding: finalAmount ? Number(outstanding).toLocaleString("en-IN") : "",
  });
  // The Confirmed template is shared across every package (unlike the quote
  // wording, which is per-package) -- so Pheras' "no fixed duration" is
  // handled here by dropping the line after filling, rather than forking the
  // whole template.
  if (isPheras) {
    message = message.replace(/^Duration:.*\n?/m, "");
  }
  const digitsOnly = (lead.whatsapp_number || lead.phone || "").replace(/\D/g, "");
  const waLink = digitsOnly ? `https://wa.me/${digitsOnly}?text=${encodeURIComponent(message)}` : null;
  const mailLink = lead.email ? `mailto:${lead.email}?subject=${encodeURIComponent("Your event is confirmed — Together, Out Loud")}&body=${encodeURIComponent(message)}` : null;

  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal-card">
        <div class="modal-head"><h3>Send confirmation to ${lead.name}</h3><button class="icon-btn" id="closeModal">✕</button></div>
        <div class="modal-body">
          <textarea id="ceMessage" rows="8" style="width:100%; padding:10px; border:1px solid #DDD5C4; border-radius:6px; font-family:inherit; font-size:13px;">${message}</textarea>
        </div>
        <div class="modal-foot">
          ${waLink ? `<button class="btn-ghost" id="waBtn">💬 WhatsApp</button>` : `<span class="muted small">No phone on file</span>`}
          ${mailLink ? `<button class="btn-ghost" id="mailBtn">✉️ Email</button>` : ""}
          <button class="btn-primary" id="doneBtn">Done</button>
        </div>
      </div>
    </div>
  `;
  const close = () => { root.innerHTML = ""; renderMain(); };
  root.querySelector("#closeModal").addEventListener("click", close);
  root.querySelector("#doneBtn").addEventListener("click", close);
  root.querySelector("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") close(); });
  if (waLink) root.querySelector("#waBtn").addEventListener("click", () => window.open(`https://wa.me/${digitsOnly}?text=${encodeURIComponent(root.querySelector("#ceMessage").value)}`, "_blank"));
  if (mailLink) root.querySelector("#mailBtn").addEventListener("click", () => {
    window.location.href = `mailto:${lead.email}?subject=${encodeURIComponent("Your event is confirmed — Together, Out Loud")}&body=${encodeURIComponent(root.querySelector("#ceMessage").value)}`;
  });
}

function openNewLeadModal() {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal-card">
        <div class="modal-head"><h3>New lead</h3><button class="icon-btn" id="closeModal">✕</button></div>
        <div class="modal-body">
          <label>Name / organisation</label>
          <input id="mName" placeholder="e.g. Priya & Raj Sharma" />
          <div class="row-2">
            <div><label>Phone</label><input id="mPhone" placeholder="+91 ..." /></div>
            <div><label>Email</label><input id="mEmail" placeholder="name@example.com" /></div>
          </div>
          <label class="check-row" style="margin-top:6px;">
            <input type="checkbox" id="mIsCombo" />
            <span>Combo booking — same client, multiple formats/dates under one combined price (e.g. Bhajan Jamming on the 20th + Musical Pheras on the 21st)</span>
          </label>

          <div id="singleEventFields">
            <div class="row-2">
              <div><label>Format wanted</label><select id="mType">${CONFIG.packages.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}</select></div>
              <div><label>City</label><input id="mCity" placeholder="e.g. Siliguri" /></div>
            </div>
            <div class="row-2">
              <div><label>Event date</label><input id="mDate" type="date" /></div>
              <div><label>Budget (optional)</label><input id="mBudget" placeholder="e.g. 90000" /></div>
            </div>
          </div>

          <div id="comboEventFields" style="display:none;">
            <label>City</label>
            <input id="mComboCity" placeholder="e.g. Siliguri" style="margin-bottom:10px;" />
            <label>Formats &amp; dates</label>
            <div id="comboRows"></div>
            <button class="btn-ghost" id="addComboRowBtn" style="margin-top:4px; font-size:12px; padding:4px 10px;">+ Add another format/date</button>
            <label style="margin-top:10px;">Combined price (₹)</label>
            <input id="mComboBudget" placeholder="e.g. 175000 (covers all events above)" />
          </div>

          <div class="row-2" style="margin-top:10px;">
            <div><label>No. of guests</label><select id="mGuests"><option value="">Not specified</option>${CONFIG.guestRanges.map((g) => `<option value="${g}">${g}</option>`).join("")}</select></div>
            <div><label>Occasion</label><select id="mOccasion"><option value="">Not specified</option>${CONFIG.occasions.map((o) => `<option value="${o}">${o}</option>`).join("")}</select></div>
          </div>
          <div class="row-2" id="mPcsRow">
            <div><label>Pcs (No. of Musicians)</label><input id="mPcs" type="number" placeholder="e.g. 5" /></div>
            <div></div>
          </div>
          <label>Venue (optional)</label>
          <input id="mVenue" placeholder="e.g. Radhika Function Hall, MG Road" />
          <label class="check-row" style="margin-top:10px;">
            <input type="checkbox" id="mAlreadyConfirmed" />
            <span>Already confirmed — skip straight to Confirmed (e.g. someone you know called and booked directly)</span>
          </label>
          <div id="comboFinalRateField" style="display:none; margin-top:8px;">
            <label>Final combined rate (₹)</label>
            <input id="mComboFinalRate" placeholder="e.g. 175000" />
            <label style="margin-top:8px;">Advance received now (optional)</label>
            <div class="row-2">
              <input id="mComboAdvanceAmount" type="number" placeholder="e.g. 20000" />
              <input id="mComboAdvanceDate" type="date" value="${new Date().toISOString().slice(0, 10)}" max="${new Date().toISOString().slice(0, 10)}" />
            </div>
            <select id="mComboAdvanceMode" style="margin-top:8px;">
              <option value="">Mode —</option>
              <option value="Cash">Cash</option>
              <option value="UPI">UPI</option>
            </select>
          </div>
        </div>
        <div class="modal-foot"><button class="btn-ghost" id="cancelModal">Cancel</button><button class="btn-primary" id="submitModal">Add lead</button></div>
      </div>
    </div>
  `;
  const close = () => (root.innerHTML = "");
  root.querySelector("#closeModal").addEventListener("click", close);
  root.querySelector("#cancelModal").addEventListener("click", close);
  root.querySelector("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") close(); });

  const comboRowsEl = root.querySelector("#comboRows");
  function addComboRow() {
    comboRowsEl.insertAdjacentHTML("beforeend", `
      <div class="row-2 combo-row" style="margin-top:6px;">
        <select class="combo-type">${CONFIG.packages.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}</select>
        <input class="combo-date" type="date" />
      </div>
    `);
  }
  addComboRow();
  addComboRow();
  root.querySelector("#addComboRowBtn").addEventListener("click", addComboRow);

  root.querySelector("#mIsCombo").addEventListener("change", (e) => {
    root.querySelector("#singleEventFields").style.display = e.target.checked ? "none" : "";
    root.querySelector("#comboEventFields").style.display = e.target.checked ? "" : "none";
  });
  root.querySelector("#mAlreadyConfirmed").addEventListener("change", (e) => {
    root.querySelector("#comboFinalRateField").style.display = (e.target.checked && root.querySelector("#mIsCombo").checked) ? "" : "none";
  });
  root.querySelector("#mIsCombo").addEventListener("change", (e) => {
    root.querySelector("#comboFinalRateField").style.display = (e.target.checked && root.querySelector("#mAlreadyConfirmed").checked) ? "" : "none";
  });
  root.querySelector("#mType").addEventListener("change", (e) => {
    root.querySelector("#mPcsRow").style.display = e.target.value === "pheras" ? "none" : "";
  });

  root.querySelector("#submitModal").addEventListener("click", async () => {
    const name = root.querySelector("#mName").value;
    if (!name) return alert("Name is required.");
    const alreadyConfirmed = root.querySelector("#mAlreadyConfirmed").checked;
    const isCombo = root.querySelector("#mIsCombo").checked;

    if (isCombo) {
      const events = [...comboRowsEl.querySelectorAll(".combo-row")].map((row) => ({
        eventType: row.querySelector(".combo-type").value,
        date: row.querySelector(".combo-date").value,
      }));
      if (events.some((e) => !e.date)) return alert("Every row needs a date.");
      const created = await api("/api/leads/combo", {
        method: "POST",
        body: JSON.stringify({
          name,
          phone: root.querySelector("#mPhone").value,
          email: root.querySelector("#mEmail").value,
          city: root.querySelector("#mComboCity").value,
          events,
          budget: root.querySelector("#mComboBudget").value ? Number(root.querySelector("#mComboBudget").value) : null,
          finalAmount: root.querySelector("#mComboFinalRate").value ? Number(root.querySelector("#mComboFinalRate").value) : null,
          guestRange: root.querySelector("#mGuests").value || null,
          occasion: root.querySelector("#mOccasion").value || null,
          alreadyConfirmed,
          advanceAmount: root.querySelector("#mComboAdvanceAmount").value ? Number(root.querySelector("#mComboAdvanceAmount").value) : null,
          advanceDate: root.querySelector("#mComboAdvanceDate").value || null,
          advanceMode: root.querySelector("#mComboAdvanceMode").value || null,
        }),
      });
      await refreshLeads();
      close();
      renderMain();
      return;
    }

    const date = root.querySelector("#mDate").value;
    if (!date) return alert("Event date is required.");
    const created = await api("/api/leads", {
      method: "POST",
      body: JSON.stringify({
        name,
        phone: root.querySelector("#mPhone").value,
        email: root.querySelector("#mEmail").value,
        eventType: root.querySelector("#mType").value,
        city: root.querySelector("#mCity").value,
        date,
        budget: root.querySelector("#mBudget").value ? Number(root.querySelector("#mBudget").value) : null,
        guestRange: root.querySelector("#mGuests").value || null,
        occasion: root.querySelector("#mOccasion").value || null,
        venue: root.querySelector("#mVenue").value || null,
        pcs: root.querySelector("#mPcs").value || null,
      }),
    });
    await refreshLeads();
    close();
    if (alreadyConfirmed) {
      // Reuse the same Confirm flow used elsewhere — same conflict-checking and
      // final-rate prompt — rather than duplicating that logic here.
      const freshLead = LEADS.find((l) => l.id === created.id) || created;
      openConfirmEventModal(freshLead);
    } else {
      renderMain();
    }
  });
}

function openEditLeadModal(leadId) {
  const lead = LEADS.find((l) => l.id === leadId);
  if (!lead) return;
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal-card">
        <div class="modal-head"><h3>Edit lead</h3><button class="icon-btn" id="closeModal">✕</button></div>
        <div class="modal-body">
          <label>Name / organisation</label>
          <input id="mName" value="${lead.name || ""}" />
          <div class="row-2">
            <div><label>Phone</label><input id="mPhone" value="${lead.phone || ""}" placeholder="+91 ..." /></div>
            <div><label>Email</label><input id="mEmail" value="${lead.email || ""}" placeholder="name@example.com" /></div>
          </div>
          <label>WhatsApp number <span class="muted small">(only if different from phone above)</span></label>
          <input id="mWhatsapp" value="${lead.whatsapp_number || ""}" placeholder="+91 ... (leave blank if same as phone)" />
          <div class="row-2">
            <div><label>Format wanted</label><select id="mType">${CONFIG.packages.map((p) => `<option value="${p.id}" ${p.id === lead.event_type ? "selected" : ""}>${p.name}</option>`).join("")}</select></div>
            <div><label>City</label><input id="mCity" value="${lead.city || ""}" placeholder="e.g. Siliguri" /></div>
          </div>
          <div class="row-2">
            <div><label>Event date</label><input id="mDate" type="date" value="${lead.date || ""}" /></div>
            <div><label>Quoted amount (₹)</label><input id="mQuoteAmount" type="number" value="${lead.quote_amount || ""}" placeholder="e.g. 150000" /></div>
          </div>
          <div class="row-2">
            <div><label>No. of guests</label><select id="mGuests"><option value="">Not specified</option>${CONFIG.guestRanges.map((g) => `<option value="${g}" ${g === lead.guest_range ? "selected" : ""}>${g}</option>`).join("")}</select></div>
            <div><label>Occasion</label><select id="mOccasion"><option value="">Not specified</option>${CONFIG.occasions.map((o) => `<option value="${o}" ${o === lead.occasion ? "selected" : ""}>${o}</option>`).join("")}</select></div>
          </div>
          ${(lead.stage === "Confirmed" || lead.stage === "Completed") ? `<label>Final confirmed amount (₹)</label><input id="mFinalAmount" type="number" value="${lead.final_amount || ""}" placeholder="e.g. 150000" />` : ""}
          ${lead.combo_group_id ? `<p class="muted small">This event is part of a combo booking. Editing the format/date here only changes this one event — the shared client details are separate per event.</p>` : ""}
          <label>Internal notes <span class="muted small">(not shown to the client — shows on the Leads card, e.g. "follow up after 10 Aug")</span></label>
          <textarea id="mNotes" rows="3" style="width:100%; padding:10px; border:1px solid #DDD5C4; border-radius:6px; font-family:inherit; font-size:14px;">${lead.notes || ""}</textarea>
        </div>
        <div class="modal-foot"><button class="btn-ghost" id="cancelModal">Cancel</button><button class="btn-primary" id="submitModal">Save changes</button></div>
      </div>
    </div>
  `;
  const close = () => (root.innerHTML = "");
  root.querySelector("#closeModal").addEventListener("click", close);
  root.querySelector("#cancelModal").addEventListener("click", close);
  root.querySelector("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") close(); });
  root.querySelector("#submitModal").addEventListener("click", async () => {
    const name = root.querySelector("#mName").value.trim();
    if (!name) return alert("Name is required.");
    const btn = root.querySelector("#submitModal");
    btn.disabled = true;
    try {
      await api(`/api/leads/${leadId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          phone: root.querySelector("#mPhone").value.trim() || null,
          email: root.querySelector("#mEmail").value.trim() || null,
          whatsappNumber: root.querySelector("#mWhatsapp").value.trim() || null,
          eventType: root.querySelector("#mType").value,
          city: root.querySelector("#mCity").value.trim() || null,
          date: root.querySelector("#mDate").value || lead.date,
          quoteAmount: root.querySelector("#mQuoteAmount").value ? Number(root.querySelector("#mQuoteAmount").value) : null,
          guestRange: root.querySelector("#mGuests").value || null,
          occasion: root.querySelector("#mOccasion").value || null,
          notes: root.querySelector("#mNotes").value.trim() || null,
          ...(root.querySelector("#mFinalAmount") ? { finalAmount: root.querySelector("#mFinalAmount").value ? Number(root.querySelector("#mFinalAmount").value) : null } : {}),
        }),
      });
      await refreshLeads();
      close();
      renderMain();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  });
}

// ---------- Settings — self-service message wording, admin only ----------
const TEMPLATE_META = {
  followup: {
    label: "Follow-up message",
    description: "Sent from the Leads tab's \"💬 Follow up\" button, for New/Follow-up leads.",
    placeholders: ["firstName", "experience", "dateClause"],
    default: "Hi {firstName}, just following up on your enquiry with Together, Out Loud for {experience}{dateClause}. Let us know if you have any questions or would like to go ahead — happy to help!",
  },
  tentative_followup: {
    label: "Tentative client follow-up",
    description: "Sent from the same \"💬 Follow up\" button, but for Tentative leads instead.",
    placeholders: ["firstName", "experience", "dateClause"],
    default: "Hi {firstName}, following up on your {experience}{dateClause} — we've tentatively held this date for you with Together, Out Loud. Let us know if you'd like to go ahead so we can lock it in for you!",
  },
  confirmed: {
    label: "Confirmed client message",
    description: "Starting text shown when you confirm an event — you can still tweak it per-send before it goes out. Location, Set, Duration, Fee, Advance, and Outstanding are pulled automatically from the lead.",
    placeholders: ["firstName", "clientName", "experience", "date", "cityClause", "amountLine", "location", "occasion", "pieces", "duration", "performanceFee", "advance", "outstanding"],
    default: "Hi {firstName}, wonderful news — your event with Together, Out Loud ({experience}) on {date}{cityClause} is now confirmed!{amountLine}\n\nWe are pleased to confirm our booking for: {clientName}\nLocation: {location}\nDate: {date}\nOccasion: {occasion}\nSet: {pieces} Pieces\nDuration: {duration}\nPerformance Fee: ₹{performanceFee}/-\nAdvance: ₹{advance}/-\nOutstanding: ₹{outstanding}\n\nAs discussed, we request your support in arranging the travel, accommodation, meals, local transfers, and venue technical requirements.\nWe look forward to creating a soulful and memorable musical experience with you and your guests.\n\nWarm regards,\nTogether, Out Loud",
  },
  document_share: {
    label: "Document share message",
    description: "Sent with \"Send to client\" / \"Send to…\" on the Documents tab.",
    placeholders: ["label", "link"],
    default: "Hi! Sharing the {label} for your event with Together, Out Loud: {link}",
  },
};

const QUOTE_TEMPLATE_PLACEHOLDERS = ["firstName", "formatUpper", "location", "date", "guests", "duration", "setPieces", "formatType", "amountLine", "sessionConditions"];

// ---------- Website content management (CMS for the marketing site) ----------
async function renderWebsiteContent(main) {
  const [content, gallery] = await Promise.all([
    api("/api/site-content"),
    api("/api/gallery"),
  ]);

  main.innerHTML = `
    <div class="view-head">
      <div><h2>Website</h2><p class="muted">Edit what shows on togetheroutloud.in — no code needed. Changes save per section below.</p></div>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="section-label">Stats override</div>
      <p class="muted small" style="margin-top:-4px;">Leave a field blank to keep showing the live number pulled from Instagram.</p>
      <div class="row-2" style="margin-top:10px;">
        <div><label>Instagram followers</label><input id="statFollowers" placeholder="e.g. 12000" value="${content.stats_override.followers || ""}" /></div>
        <div><label>Likes on reels</label><input id="statLikes" placeholder="e.g. 600000" value="${content.stats_override.likes || ""}" /></div>
      </div>
      <div class="row-2" style="margin-top:10px;">
        <div><label>Cities across India</label><input id="statCities" placeholder="e.g. 15" value="${content.stats_override.cities || ""}" /></div>
        <div><label>International shows</label><input id="statIntl" placeholder="e.g. Europe & Thailand" value="${content.stats_override.international || ""}" /></div>
      </div>
      <button class="btn-primary" id="saveStatsBtn" style="margin-top:12px;">Save stats override</button>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="section-label">Cities performed</div>
      <div id="citiesList"></div>
      <div class="row-2" style="margin-top:10px;">
        <input id="newCityInput" placeholder="Add a city…" />
        <button class="btn-ghost" id="addCityBtn">+ Add city</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="section-label">FAQs</div>
      <div id="faqsList"></div>
      <button class="btn-ghost full" id="addFaqBtn" style="margin-top:10px;">+ Add FAQ</button>
      <button class="btn-primary" id="saveFaqsBtn" style="margin-top:10px;">Save FAQs</button>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="section-label">Testimonials</div>
      <div id="testimonialsList"></div>
      <button class="btn-ghost full" id="addTestimonialBtn" style="margin-top:10px;">+ Add testimonial</button>
      <button class="btn-primary" id="saveTestimonialsBtn" style="margin-top:10px;">Save testimonials</button>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="section-label">Press mentions</div>
      <div id="pressList"></div>
      <button class="btn-ghost full" id="addPressBtn" style="margin-top:10px;">+ Add press mention</button>
      <button class="btn-primary" id="savePressBtn" style="margin-top:10px;">Save press mentions</button>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="section-label">Team (public bios)</div>
      <p class="muted small" style="margin-top:-4px;">Separate from your internal roster — only who you want shown publicly.</p>
      <div id="teamList"></div>
      <button class="btn-ghost full" id="addTeamBtn" style="margin-top:10px;">+ Add team member</button>
      <button class="btn-primary" id="saveTeamBtn" style="margin-top:10px;">Save team</button>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="section-label">Services (what we do)</div>
      <p class="muted small" style="margin-top:-4px;">Overrides the blurb shown for a format on the homepage — leave title blank to skip.</p>
      <div id="servicesList"></div>
      <button class="btn-ghost full" id="addServiceBtn" style="margin-top:10px;">+ Add service override</button>
      <button class="btn-primary" id="saveServicesBtn" style="margin-top:10px;">Save services</button>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="section-label">Hero banners</div>
      <p class="muted small" style="margin-top:-4px;">Headline/subhead + an image or video URL for a rotating hero, once you have footage.</p>
      <div id="heroList"></div>
      <button class="btn-ghost full" id="addHeroBtn" style="margin-top:10px;">+ Add hero banner</button>
      <button class="btn-primary" id="saveHeroBtn" style="margin-top:10px;">Save hero banners</button>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="section-label">Gallery</div>
      <div id="galleryGrid" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:10px; margin-bottom:14px;"></div>
      <div class="row-2">
        <input type="file" id="galleryFile" accept="image/*" />
        <input id="galleryCaption" placeholder="Caption (optional)" />
      </div>
      <button class="btn-primary" id="uploadGalleryBtn" style="margin-top:10px;">Upload image</button>
    </div>
  `;

  // ---- Stats override ----
  main.querySelector("#saveStatsBtn").addEventListener("click", async () => {
    const value = {
      followers: main.querySelector("#statFollowers").value.trim() || null,
      likes: main.querySelector("#statLikes").value.trim() || null,
      cities: main.querySelector("#statCities").value.trim() || null,
      international: main.querySelector("#statIntl").value.trim() || null,
    };
    try {
      await api("/api/site-content/stats_override", { method: "PUT", body: JSON.stringify({ value }) });
      alert("Saved.");
    } catch (err) {
      alert(`Couldn't save: ${err.message}`);
    }
  });

  // ---- Cities ----
  let cities = Array.isArray(content.cities) ? [...content.cities] : [];
  function renderCities() {
    const list = main.querySelector("#citiesList");
    list.innerHTML = cities.length
      ? cities.map((c, i) => `<span class="chip" style="margin:0 6px 6px 0; display:inline-flex; align-items:center; gap:6px;">${c} <button data-remove-city="${i}" style="border:none; background:none; cursor:pointer; color:var(--muted);">✕</button></span>`).join("")
      : `<p class="muted small">No cities added yet.</p>`;
    list.querySelectorAll("[data-remove-city]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        cities.splice(Number(btn.dataset.removeCity), 1);
        try {
          await api("/api/site-content/cities", { method: "PUT", body: JSON.stringify({ value: cities }) });
        } catch (err) {
          alert(`Couldn't save: ${err.message}`);
        }
        renderCities();
      });
    });
  }
  renderCities();
  main.querySelector("#addCityBtn").addEventListener("click", async () => {
    const input = main.querySelector("#newCityInput");
    const val = input.value.trim();
    if (!val) return;
    cities.push(val);
    try {
      await api("/api/site-content/cities", { method: "PUT", body: JSON.stringify({ value: cities }) });
      input.value = "";
    } catch (err) {
      cities.pop();
      alert(`Couldn't save: ${err.message}`);
    }
    renderCities();
  });

  // ---- Generic repeatable-row list editor for FAQs / Testimonials / Press / Team / Hero ----
  function setupListEditor({ items, containerId, addBtnId, saveBtnId, contentKey, fields, rowHtml }) {
    let rows = Array.isArray(items) ? items.map((it) => ({ ...it })) : [];
    function render() {
      const container = main.querySelector(`#${containerId}`);
      container.innerHTML = rows.length
        ? rows.map((row, i) => rowHtml(row, i)).join("")
        : `<p class="muted small">Nothing added yet.</p>`;
      container.querySelectorAll("[data-remove-row]").forEach((btn) => {
        btn.addEventListener("click", () => { rows.splice(Number(btn.dataset.removeRow), 1); render(); });
      });
      container.querySelectorAll("[data-field]").forEach((input) => {
        input.addEventListener("input", () => {
          rows[Number(input.dataset.rowIndex)][input.dataset.field] = input.value;
        });
      });
    }
    render();
    main.querySelector(`#${addBtnId}`).addEventListener("click", () => {
      const blank = {};
      fields.forEach((f) => (blank[f] = ""));
      rows.push(blank);
      render();
    });
    main.querySelector(`#${saveBtnId}`).addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api(`/api/site-content/${contentKey}`, { method: "PUT", body: JSON.stringify({ value: rows }) });
        alert("Saved.");
      } catch (err) {
        alert(`Couldn't save: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    });
  }

  setupListEditor({
    items: content.faqs, containerId: "faqsList", addBtnId: "addFaqBtn", saveBtnId: "saveFaqsBtn",
    contentKey: "faqs", fields: ["q", "a"],
    rowHtml: (row, i) => `
      <div class="dash-list-item" style="margin-bottom:8px;">
        <input data-row-index="${i}" data-field="q" placeholder="Question" value="${row.q || ""}" style="margin-bottom:6px;" />
        <textarea data-row-index="${i}" data-field="a" placeholder="Answer" rows="2">${row.a || ""}</textarea>
        <button class="icon-btn" data-remove-row="${i}" style="margin-top:6px;">✕ Remove</button>
      </div>
    `,
  });

  setupListEditor({
    items: content.testimonials, containerId: "testimonialsList", addBtnId: "addTestimonialBtn", saveBtnId: "saveTestimonialsBtn",
    contentKey: "testimonials", fields: ["name", "quote", "videoUrl"],
    rowHtml: (row, i) => `
      <div class="dash-list-item" style="margin-bottom:8px;">
        <input data-row-index="${i}" data-field="name" placeholder="Client name" value="${row.name || ""}" style="margin-bottom:6px;" />
        <textarea data-row-index="${i}" data-field="quote" placeholder="What they said" rows="2" style="margin-bottom:6px;">${row.quote || ""}</textarea>
        <input data-row-index="${i}" data-field="videoUrl" placeholder="Video URL (optional)" value="${row.videoUrl || ""}" />
        <button class="icon-btn" data-remove-row="${i}" style="margin-top:6px;">✕ Remove</button>
      </div>
    `,
  });

  setupListEditor({
    items: content.press, containerId: "pressList", addBtnId: "addPressBtn", saveBtnId: "savePressBtn",
    contentKey: "press", fields: ["outlet", "quote", "link"],
    rowHtml: (row, i) => `
      <div class="dash-list-item" style="margin-bottom:8px;">
        <input data-row-index="${i}" data-field="outlet" placeholder="Outlet name" value="${row.outlet || ""}" style="margin-bottom:6px;" />
        <input data-row-index="${i}" data-field="quote" placeholder="Headline / quote" value="${row.quote || ""}" style="margin-bottom:6px;" />
        <input data-row-index="${i}" data-field="link" placeholder="Link" value="${row.link || ""}" />
        <button class="icon-btn" data-remove-row="${i}" style="margin-top:6px;">✕ Remove</button>
      </div>
    `,
  });

  setupListEditor({
    items: content.team, containerId: "teamList", addBtnId: "addTeamBtn", saveBtnId: "saveTeamBtn",
    contentKey: "team", fields: ["name", "role"],
    rowHtml: (row, i) => `
      <div class="dash-list-item" style="display:flex; gap:8px; margin-bottom:8px; align-items:center;">
        <input data-row-index="${i}" data-field="name" placeholder="Name" value="${row.name || ""}" style="flex:1;" />
        <input data-row-index="${i}" data-field="role" placeholder="Role" value="${row.role || ""}" style="flex:1;" />
        <button class="icon-btn" data-remove-row="${i}">✕</button>
      </div>
    `,
  });

  setupListEditor({
    items: Array.isArray(content.services) ? content.services : [], containerId: "servicesList", addBtnId: "addServiceBtn", saveBtnId: "saveServicesBtn",
    contentKey: "services", fields: ["title", "blurb"],
    rowHtml: (row, i) => `
      <div class="dash-list-item" style="margin-bottom:8px;">
        <input data-row-index="${i}" data-field="title" placeholder="Format title (e.g. Bhajan Jamming)" value="${row.title || ""}" style="margin-bottom:6px;" />
        <textarea data-row-index="${i}" data-field="blurb" placeholder="Description" rows="2">${row.blurb || ""}</textarea>
        <button class="icon-btn" data-remove-row="${i}" style="margin-top:6px;">✕ Remove</button>
      </div>
    `,
  });

  setupListEditor({
    items: content.hero_banners, containerId: "heroList", addBtnId: "addHeroBtn", saveBtnId: "saveHeroBtn",
    contentKey: "hero_banners", fields: ["headline", "subhead", "imageUrl", "videoUrl"],
    rowHtml: (row, i) => `
      <div class="dash-list-item" style="margin-bottom:8px;">
        <input data-row-index="${i}" data-field="headline" placeholder="Headline" value="${row.headline || ""}" style="margin-bottom:6px;" />
        <input data-row-index="${i}" data-field="subhead" placeholder="Subhead" value="${row.subhead || ""}" style="margin-bottom:6px;" />
        <input data-row-index="${i}" data-field="imageUrl" placeholder="Image URL (optional)" value="${row.imageUrl || ""}" style="margin-bottom:6px;" />
        <input data-row-index="${i}" data-field="videoUrl" placeholder="Video URL (optional)" value="${row.videoUrl || ""}" />
        <button class="icon-btn" data-remove-row="${i}" style="margin-top:6px;">✕ Remove</button>
      </div>
    `,
  });

  // ---- Gallery ----
  function renderGallery() {
    const grid = main.querySelector("#galleryGrid");
    grid.innerHTML = gallery.length
      ? gallery.map((g) => `
        <div style="position:relative;">
          <img src="${g.url}" alt="${g.caption || ""}" style="width:100%; height:100px; object-fit:cover; border-radius:8px;" />
          <button class="icon-btn" data-delete-gallery="${g.id}" style="position:absolute; top:4px; right:4px; background:rgba(255,255,255,0.9); border-radius:50%;">✕</button>
        </div>
      `).join("")
      : `<p class="muted small">No images uploaded yet.</p>`;
    grid.querySelectorAll("[data-delete-gallery]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this image?")) return;
        await api(`/api/gallery/${btn.dataset.deleteGallery}`, { method: "DELETE" });
        renderWebsiteContent(main);
      });
    });
  }
  renderGallery();
  main.querySelector("#uploadGalleryBtn").addEventListener("click", async () => {
    const fileInput = main.querySelector("#galleryFile");
    if (!fileInput.files[0]) return alert("Choose an image first.");
    const formData = new FormData();
    formData.append("file", fileInput.files[0]);
    formData.append("caption", main.querySelector("#galleryCaption").value.trim());
    await fetch("/api/gallery", { method: "POST", body: formData });
    renderWebsiteContent(main);
  });
}

async function renderSettings(main) {
  main.innerHTML = `
    <div class="view-head"><div><h2>Settings</h2><p class="muted">Customize wording and options yourself — no code changes needed. Tap a section to expand it.</p></div></div>

    <div id="templateCards"></div>

    <div class="card" style="margin-bottom:16px;">
      <div class="section-label">Data backup</div>
      <p class="muted small" style="margin-top:-4px;">A full export of every lead, payment, expense, quote, team assignment, and task is emailed to togetheroutloudclub@gmail.com automatically on the 1st of each month. You can also get one right now:</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:8px;">
        <a class="btn-ghost" href="/api/admin/backup" id="downloadBackupBtn">⬇ Download now</a>
        <button class="btn-primary" id="emailBackupBtn">✉️ Email it to me now</button>
        <span class="muted small" id="backupSentNote" style="display:none; color:#5C8A6B;">Sent ✓</span>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="section-label">Pricing</div>
      <p class="muted small" style="margin-top:-4px;">Rate by number of musicians (Pcs), per experience. This is what auto-fills "Performance charges" in the Quotation tab — change it here and both the WhatsApp/email text and the downloaded PDF will use the new rate the next time you generate a quote.</p>
      <select id="pricingPackageSelect">
        ${CONFIG.packages.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}
      </select>
      <div id="pricingEditor" style="margin-top:12px;"></div>
      <div style="display:flex; gap:8px; align-items:center; margin-top:12px;">
        <button class="btn-primary" id="savePricingBtn">Save pricing</button>
        <span class="muted small" id="pricingSavedNote" style="display:none; color:#5C8A6B;">Saved ✓</span>
      </div>
    </div>

    <details class="card" style="margin-bottom:16px;">
      <summary style="cursor:pointer; font-weight:600;">Quotation wording (advanced)</summary>
      <p class="muted small" style="margin-top:8px;">This only changes the WhatsApp/email wording text — not pricing, and not the PDF. Most of the time you just want Pricing above instead.</p>
      <select id="quoteTemplateSelect">
        ${CONFIG.packages.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}
      </select>
      <div id="quoteTemplateEditor" style="margin-top:12px;"></div>
    </details>
  `;

  const container = main.querySelector("#templateCards");
  container.innerHTML = Object.entries(TEMPLATE_META).map(([key, meta]) => `
    <details class="card" style="margin-bottom:12px;">
      <summary style="cursor:pointer; font-weight:600;">${meta.label}</summary>
      <p class="muted small" style="margin-top:8px;">${meta.description}</p>
      <p class="muted small">Placeholders you can use: ${meta.placeholders.map((p) => `<code>{${p}}</code>`).join(", ")}</p>
      <textarea id="tpl-${key}" rows="4" style="width:100%; padding:10px; border:1px solid #DDD5C4; border-radius:6px; font-family:inherit; font-size:13px;">${MESSAGE_TEMPLATES[key] || meta.default}</textarea>
      <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
        <button class="btn-primary" data-save-template="${key}">Save</button>
        <button class="btn-ghost" data-reset-template="${key}">Reset to default</button>
        <span class="muted small" data-saved-note="${key}" style="display:none; color:#5C8A6B;">Saved ✓</span>
      </div>
    </details>
  `).join("");

  container.querySelectorAll("[data-reset-template]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.resetTemplate;
      main.querySelector(`#tpl-${key}`).value = TEMPLATE_META[key].default;
    });
  });
  container.querySelectorAll("[data-save-template]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.saveTemplate;
      const value = main.querySelector(`#tpl-${key}`).value;
      btn.disabled = true;
      try {
        await api(`/api/message-templates/${key}`, { method: "PATCH", body: JSON.stringify({ template: value }) });
        MESSAGE_TEMPLATES[key] = value;
        const note = main.querySelector(`[data-saved-note="${key}"]`);
        note.style.display = "inline";
        setTimeout(() => { note.style.display = "none"; }, 2000);
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // ---- Pricing (Pcs -> rate per experience, one experience shown at a time) ----
  const pricingEditor = main.querySelector("#pricingEditor");
  const pricingSelect = main.querySelector("#pricingPackageSelect");
  // Work on a local copy so nothing is sent until "Save pricing" is clicked.
  const pricingDraft = JSON.parse(JSON.stringify(CONFIG.pricing || {}));
  CONFIG.packages.forEach((p) => { if (!pricingDraft[p.id]) pricingDraft[p.id] = {}; });

  // Reads whatever's currently on screen back into pricingDraft for the given package,
  // so switching the dropdown (or saving) never silently drops an edit.
  function syncVisibleRowsIntoDraft(pkgId) {
    const tiers = {};
    pricingEditor.querySelectorAll(".row-2").forEach((row) => {
      const pcs = row.querySelector(".pricing-pcs").value;
      const rate = row.querySelector(".pricing-rate").value;
      if (pcs && rate) tiers[pcs] = Number(rate);
    });
    pricingDraft[pkgId] = tiers;
  }

  function renderPricingEditor() {
    const pkgId = pricingSelect.value;
    pricingEditor.innerHTML = `
      <div data-pricing-rows="${pkgId}">
        ${Object.entries(pricingDraft[pkgId] || {}).map(([pcs, rate]) => `
          <div class="row-2" style="margin-top:4px;">
            <input type="number" class="pricing-pcs" value="${pcs}" placeholder="Pcs" />
            <input type="number" class="pricing-rate" value="${rate}" placeholder="Rate (₹)" />
          </div>
        `).join("")}
      </div>
      <button class="btn-ghost" id="addPricingRowBtn" style="margin-top:4px; font-size:12px; padding:4px 10px;">+ Add Pcs tier</button>
    `;
    pricingEditor.querySelector("#addPricingRowBtn").addEventListener("click", () => {
      pricingEditor.querySelector(`[data-pricing-rows="${pkgId}"]`).insertAdjacentHTML("beforeend", `
        <div class="row-2" style="margin-top:4px;">
          <input type="number" class="pricing-pcs" placeholder="Pcs" />
          <input type="number" class="pricing-rate" placeholder="Rate (₹)" />
        </div>
      `);
    });
  }
  pricingSelect.addEventListener("change", (e) => {
    // e.target's *new* value is already selected, so grab the previous package
    // from a data attribute we keep in sync, to know which draft entry to save into.
    syncVisibleRowsIntoDraft(pricingEditor.dataset.currentPkg);
    pricingEditor.dataset.currentPkg = e.target.value;
    renderPricingEditor();
  });
  pricingEditor.dataset.currentPkg = pricingSelect.value;
  renderPricingEditor();

  main.querySelector("#emailBackupBtn").addEventListener("click", async () => {
    const btn = main.querySelector("#emailBackupBtn");
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Sending…";
    try {
      await api("/api/admin/backup/email", { method: "POST", body: JSON.stringify({}) });
      const note = main.querySelector("#backupSentNote");
      note.style.display = "inline";
      setTimeout(() => { note.style.display = "none"; }, 3000);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  main.querySelector("#savePricingBtn").addEventListener("click", async () => {
    syncVisibleRowsIntoDraft(pricingSelect.value);
    const btn = main.querySelector("#savePricingBtn");
    btn.disabled = true;
    try {
      await api("/api/pricing", { method: "PATCH", body: JSON.stringify({ pricing: pricingDraft }) });
      CONFIG.pricing = JSON.parse(JSON.stringify(pricingDraft));
      const note = main.querySelector("#pricingSavedNote");
      note.style.display = "inline";
      setTimeout(() => { note.style.display = "none"; }, 2000);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- Quotation templates (one at a time, picked via the dropdown) ----
  const quoteEditor = main.querySelector("#quoteTemplateEditor");
  const quoteSelect = main.querySelector("#quoteTemplateSelect");
  function renderQuoteEditor() {
    const pkgId = quoteSelect.value;
    const key = `quotation_${pkgId}`;
    quoteEditor.innerHTML = `
      <p class="muted small">Placeholders: ${QUOTE_TEMPLATE_PLACEHOLDERS.map((p) => `<code>{${p}}</code>`).join(", ")}</p>
      <textarea id="quoteTplBody" rows="14" style="width:100%; padding:10px; border:1px solid #DDD5C4; border-radius:6px; font-family:'JetBrains Mono',monospace; font-size:12.5px;">${MESSAGE_TEMPLATES[key] || ""}</textarea>
      <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
        <button class="btn-primary" id="saveQuoteTplBtn">Save</button>
        <span class="muted small" id="quoteTplSavedNote" style="display:none; color:#5C8A6B;">Saved ✓</span>
      </div>
    `;
    quoteEditor.querySelector("#saveQuoteTplBtn").addEventListener("click", async () => {
      const value = quoteEditor.querySelector("#quoteTplBody").value;
      const btn = quoteEditor.querySelector("#saveQuoteTplBtn");
      btn.disabled = true;
      try {
        await api(`/api/message-templates/${key}`, { method: "PATCH", body: JSON.stringify({ template: value }) });
        MESSAGE_TEMPLATES[key] = value;
        const note = quoteEditor.querySelector("#quoteTplSavedNote");
        note.style.display = "inline";
        setTimeout(() => { note.style.display = "none"; }, 2000);
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }
  quoteSelect.addEventListener("change", renderQuoteEditor);
  renderQuoteEditor();
}

// ---------- Main dispatch ----------
function renderMain() {
  const main = document.getElementById("main");
  // Without this, switching tabs (or logging back in) can leave the view
  // scrolled to wherever the previous screen was, instead of starting fresh
  // at the top.
  main.scrollTop = 0;
  main.scrollLeft = 0;
  window.scrollTo(0, 0);
  if (currentTab === "dashboard") renderDashboard(main);
  else if (currentTab === "leads") renderLeadsLog(main);
  else if (currentTab === "quotation") renderQuotation(main);
  else if (currentTab === "tasks") renderTasks(main);
  else if (currentTab === "documents") renderDocuments(main);
  else if (currentTab === "calendar") renderCalendar(main);
  else if (currentTab === "team") renderTeam(main);
  else if (currentTab === "accounts") renderAccounts(main);
  else if (currentTab === "myevents") renderMyEvents(main);
  else if (currentTab === "settings") renderSettings(main);
  else if (currentTab === "website") renderWebsiteContent(main);
}

// ---------- Auth ----------
function renderLoginScreen(errorMsg) {
  const app = document.querySelector(".tol-app");
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card card">
        <img src="/logo.png" class="brand-mark" style="margin:0 auto 14px;" alt="Together, Out Loud" />
        <h2 style="text-align:center; margin-bottom:4px;">Together, Out Loud</h2>
        <p class="muted" style="text-align:center; margin-bottom:20px;">Sign in to the workflow app</p>
        ${errorMsg ? `<p style="color:#A64B3C; font-size:13px; margin-bottom:10px;">${errorMsg}</p>` : ""}
        <label>Username</label>
        <input id="loginUsername" autocomplete="username" />
        <label>Password</label>
        <input id="loginPassword" type="password" autocomplete="current-password" />
        <button class="btn-primary full" id="loginBtn" style="margin-top:16px;">Sign in</button>
      </div>
    </div>
  `;
  const doLogin = async () => {
    const username = document.getElementById("loginUsername").value;
    const password = document.getElementById("loginPassword").value;
    const btn = document.getElementById("loginBtn");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      window.location.reload();
    } catch (err) {
      renderLoginScreen(err.message);
    }
  };
  document.getElementById("loginBtn").addEventListener("click", doLogin);
  document.getElementById("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
}

async function handleLogout() {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  window.location.reload();
}

// ---------- My Events (for a Staff/Admin account that's also flagged as a performer) ----------
async function renderMyEvents(main) {
  main.innerHTML = `<div class="view-head"><div><h2>My Events</h2><p class="muted">Your own assigned events — accept/decline, artist fee, and pay status.</p></div></div><p class="muted">Loading your events…</p>`;
  const allEvents = await api("/api/my/events");
  const today = new Date().toISOString().slice(0, 10);
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const events = allEvents.filter((e) => e.date >= today);
  // Upcoming events need the full accept/decline workflow; past ones are just
  // for checking "did I get paid for that gig" — so a lighter read-only card,
  // capped to the last 60 days so this doesn't grow forever.
  const recentPast = allEvents.filter((e) => e.date < today && e.date >= sixtyDaysAgo && e.stage !== "Cancelled").sort((a, b) => new Date(b.date) - new Date(a.date));
  const statusLabel = { pending: "Awaiting your response", accepted: "Confirmed", declined: "Declined", cancel_requested: "Cancellation requested" };
  const statusColor = { pending: "#B6752C", accepted: "#5C8A6B", declined: "#A64B3C", cancel_requested: "#B6752C" };

  main.innerHTML = `
    <div class="view-head"><div><h2>My Events</h2><p class="muted">Your own assigned events — accept/decline, artist fee, and pay status.</p></div></div>
    ${events.length === 0 ? `<p class="muted small">No upcoming events assigned to you.</p>` : events.map((e) => `
      <div class="card performer-event-card" style="margin-bottom:14px;">
        <div class="performer-event-head">
          <div>
            <div class="team-name">${e.lead_name}</div>
            <div class="muted small">${packageName(e.event_type)}${e.occasion ? ` · ${e.occasion}` : ""} · ${fmtDate(e.date)} · ${e.city || ""}</div>
          </div>
          ${e.stage === "Cancelled"
            ? `<span class="tag" style="color:#A64B3C; font-weight:700;">⚠ CANCELLED</span>`
            : `<span class="tag" style="color:${statusColor[e.status]};">${statusLabel[e.status]}</span>`}
        </div>
        ${e.stage === "Cancelled" ? `<p class="muted small" style="color:#A64B3C; margin-top:4px;">This event has been cancelled by the team — no action needed.</p>` : `
        ${e.event_time || e.soundcheck_time ? `
        <div class="performer-event-row">
          <span class="muted small">Timing:</span>
          <span>${e.soundcheck_time ? `Sound check ${fmtTimeHM(e.soundcheck_time)}` : ""}${e.soundcheck_time && e.event_time ? " · " : ""}${e.event_time ? `Event ${fmtTimeHM(e.event_time)}` : ""}</span>
        </div>
        ` : ""}
        ${e.venue ? `
        <div class="performer-event-row">
          <span class="muted small">Venue:</span>
          <span>${e.venue}</span>
        </div>
        ` : ""}
        <div class="performer-event-row">
          <span class="muted small">Artist fee:</span>
          <span class="mono">${e.fee_amount ? inr(e.fee_amount) : "—"}</span>
        </div>
        <div class="performer-event-row">
          <span class="muted small">Payment:</span>
          <span class="tag" style="color:${e.paid ? "#5C8A6B" : "#A64B3C"};">${e.paid ? "Paid" : "Unpaid"}</span>
          ${e.paid && e.payment_date ? `<span class="muted small">on ${fmtDate(e.payment_date)}${e.payment_mode ? ` via ${e.payment_mode}` : ""}</span>` : ""}
        </div>
        ${e.status === "cancel_requested" ? `
          <p class="muted small" style="margin-top:8px;">Waiting on admin to review your cancellation request.</p>
        ` : `
          <div style="margin-top:10px;">
            <label class="muted small">Your response</label>
            <select class="respond-select" data-respond-select="${e.id}">
              <option value="pending" ${e.status === "pending" ? "selected" : ""}>Pending — not responded yet</option>
              <option value="accepted" ${e.status === "accepted" ? "selected" : ""}>Accept</option>
              <option value="declined" ${e.status === "declined" ? "selected" : ""}>Decline</option>
            </select>
          </div>
        `}
        ${e.status === "accepted" ? `
          <button class="btn-ghost full" data-request-cancel="${e.id}" style="margin-top:8px; color:#A64B3C;">Request to cancel</button>
        ` : ""}
        <button class="btn-ghost full" data-chat-lead="${e.lead_id}" data-chat-name="${e.lead_name}" style="margin-top:10px;">💬 Event chat</button>
        `}
      </div>
    `).join("")}

    ${recentPast.length > 0 ? `
      <div class="section-label" style="margin-top:20px;">Recently completed — pay status</div>
      ${recentPast.map((e) => `
        <div class="card performer-event-card" style="margin-bottom:10px;">
          <div class="performer-event-head">
            <div>
              <div class="team-name">${e.lead_name}</div>
              <div class="muted small">${packageName(e.event_type)} · ${fmtDate(e.date)}</div>
            </div>
            <span class="tag" style="color:${e.paid ? "#5C8A6B" : "#A64B3C"};">${e.paid ? "Paid" : "Unpaid"}</span>
          </div>
          <div class="performer-event-row">
            <span class="muted small">Artist fee:</span>
            <span class="mono">${e.fee_amount ? inr(e.fee_amount) : "—"}</span>
          </div>
          ${e.paid && e.payment_date ? `<div class="muted small">Paid on ${fmtDate(e.payment_date)}${e.payment_mode ? ` via ${e.payment_mode}` : ""}</div>` : ""}
        </div>
      `).join("")}
    ` : ""}
  `;

  main.querySelectorAll("[data-respond-select]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const value = sel.value;
      if (value === "pending") { renderMyEvents(main); return; }
      try {
        await api(`/api/my/assignments/${sel.dataset.respondSelect}/respond`, { method: "POST", body: JSON.stringify({ status: value }) });
        renderMyEvents(main);
      } catch (err) {
        alert(err.message);
        renderMyEvents(main);
      }
    });
  });
  main.querySelectorAll("[data-request-cancel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const reason = prompt("Why do you need to cancel this event? This goes to the admin for review.");
      if (reason === null) return;
      if (!reason.trim()) return alert("A reason is required.");
      try {
        await api(`/api/my/assignments/${btn.dataset.requestCancel}/request-cancel`, { method: "POST", body: JSON.stringify({ reason }) });
        renderMyEvents(main);
      } catch (err) {
        alert(err.message);
      }
    });
  });
  main.querySelectorAll("[data-chat-lead]").forEach((btn) => {
    btn.addEventListener("click", () => openEventChat(btn.dataset.chatLead, btn.dataset.chatName));
  });
}

// ---------- Performer/photographer view (deliberately minimal) ----------
function performerCalendarMarkup(events) {
  const first = new Date(calYear, calMonth - 1, 1);
  const startDay = first.getDay();
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const cells = Array(startDay).fill(null).concat(Array.from({ length: daysInMonth }, (_, i) => i + 1));
  const statusColor = { pending: "#B6752C", accepted: "#5C8A6B", declined: "#A64B3C" };
  const byDay = {};
  events.forEach((e) => {
    if (!e.date) return;
    const d = new Date(e.date + "T00:00:00");
    if (d.getFullYear() === calYear && d.getMonth() === calMonth - 1) {
      (byDay[d.getDate()] = byDay[d.getDate()] || []).push(e);
    }
  });
  const cellsHtml = cells.map((d) => {
    const evs = d ? (byDay[d] || []) : [];
    return `
      <div class="cal-cell${d ? "" : " cal-cell-empty"}">
        ${d ? `<div class="cal-day">${d}</div>` : ""}
        ${evs.map((ev) => `<div class="cal-event" style="background:${statusColor[ev.status]}; color:#fff;" title="${ev.lead_name} (${ev.status})">${ev.lead_name.split(" ")[0]}</div>`).join("")}
      </div>
    `;
  }).join("");
  return `
    <div class="cal-nav">
      <button class="btn-ghost" id="prevMonth">‹</button>
      <div class="cal-month">${first.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</div>
      <button class="btn-ghost" id="nextMonth">›</button>
    </div>
    <div class="cal-grid cal-head">${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => `<div>${d}</div>`).join("")}</div>
    <div class="cal-grid">${cellsHtml}</div>
    <p class="muted small" style="margin-top:8px;">🟢 Confirmed · 🟠 Tentative (awaiting your response) · 🔴 Declined</p>
  `;
}

async function renderPerformerApp() {
  const app = document.querySelector(".tol-app");
  app.innerHTML = `
    <div class="performer-app">
      <div class="performer-header">
        <img src="/logo.png" class="brand-mark" alt="Together, Out Loud" />
        <div>
          <div class="brand-name">${CURRENT_USER.name || CURRENT_USER.username}</div>
          <div class="muted small">Together, Out Loud</div>
        </div>
        <a href="#" id="performerLogout" style="margin-left:auto; color:#C1602B;">Log out</a>
      </div>
      <div class="performer-body" id="performerBody">
        <p class="muted">Loading your events…</p>
      </div>
    </div>
  `;
  document.getElementById("performerLogout").addEventListener("click", (e) => { e.preventDefault(); handleLogout(); });

  CONFIG = await api("/api/config");
  const [events, tasks, announcements, notifications] = await Promise.all([
    api("/api/my/events"), api("/api/my/tasks"), api("/api/announcements"), api("/api/my/notifications"),
  ]);
  const body = document.getElementById("performerBody");

  const statusLabel = { pending: "Awaiting your response", accepted: "Confirmed", declined: "Declined", cancel_requested: "Cancellation requested" };
  const statusColor = { pending: "#B6752C", accepted: "#5C8A6B", declined: "#A64B3C", cancel_requested: "#B6752C" };
  const activeEvents = events.filter((e) => e.stage !== "Cancelled");
  const today0 = new Date().toISOString().slice(0, 10);
  // "Your events" below is a flat upcoming list, not a browsable calendar, so
  // past/completed gigs are dropped here (the Calendar section above still
  // shows everything, since browsing past months there is legitimate).
  const upcomingEvents = activeEvents.filter((e) => e.date >= today0);
  // Performers still need to check "did I get paid" for a gig they just did,
  // even though it's no longer "upcoming" — capped to 60 days back.
  const sixtyDaysAgo0 = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const recentPastEvents = activeEvents.filter((e) => e.date < today0 && e.date >= sixtyDaysAgo0).sort((a, b) => new Date(b.date) - new Date(a.date));
  const paidCount = activeEvents.filter((e) => e.paid).length;
  const unpaidCount = activeEvents.length - paidCount;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekAhead = new Date(today.getTime() + 7 * 86400000);
  const soonEvents = activeEvents.filter((e) => {
    if (e.status !== "accepted" || !e.date) return false;
    const d = new Date(e.date + "T00:00:00");
    return d >= today && d <= weekAhead;
  });

  body.innerHTML = `
    ${soonEvents.length > 0 ? `
      <div class="section-label">⏰ Coming up this week</div>
      <div class="card reminder-flash" style="margin-bottom:20px;">
        ${soonEvents.map((e) => `
          <div class="dash-list-item">
            <div><strong>${e.lead_name}</strong> — ${packageName(e.event_type)}${e.occasion ? ` · ${e.occasion}` : ""}</div>
            <div class="muted small">${fmtDate(e.date)}${e.city ? ` · ${e.city}` : ""}</div>
          </div>
        `).join("")}
      </div>
    ` : ""}
    ${notifications.length > 0 ? `
      <div class="section-label">🔔 Updates for you</div>
      <div class="card" id="perfNotifCard" style="margin-bottom:20px; border-color:#C1602B;">
        ${notifications.map((n) => `
          <div class="dash-list-item" style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div><div>${n.message}</div><div class="muted small">${fmtDateTime(n.created_at)}</div></div>
            <button class="icon-btn" data-dismiss-notif="${n.id}">✕</button>
          </div>
        `).join("")}
      </div>
    ` : ""}
    ${announcements.length > 0 ? `
      <div class="section-label">📢 Announcements</div>
      <div class="card" style="margin-bottom:20px; border-color:#C1602B;">
        ${announcements.map((a) => `
          <div class="dash-list-item">
            <div>${a.message}</div>
            <div class="muted small">${a.created_by} · ${fmtDateTime(a.created_at)}</div>
          </div>
        `).join("")}
      </div>
    ` : ""}
    <div class="card" style="margin-bottom:20px;">
      <div class="section-label">✉️ Message admin</div>
      <p class="muted small" style="margin-top:-4px;">Not about a specific event? Send a quick note here instead.</p>
      <textarea id="generalMsgInput" rows="2" placeholder="e.g. Running late today, can we talk about next month's schedule..." style="width:100%; padding:10px; border:1px solid #DDD5C4; border-radius:6px; font-family:inherit; font-size:14px;"></textarea>
      <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
        <button class="btn-primary" id="sendGeneralMsgBtn">Send</button>
        <span class="muted small" id="generalMsgSentNote" style="display:none; color:#5C8A6B;">Sent ✓</span>
      </div>
    </div>
    <div class="section-label">Calendar</div>
    <div class="card" id="perfCalCard" style="margin-bottom:20px;">${performerCalendarMarkup(activeEvents)}</div>

    <div class="section-label">Your events</div>
    ${upcomingEvents.length === 0 ? `<p class="muted small" style="margin-bottom:20px;">No upcoming events assigned to you.</p>` : upcomingEvents.map((e) => `
      <div class="card performer-event-card">
        <div class="performer-event-head">
          <div>
            <div class="team-name">${e.lead_name}</div>
            <div class="muted small">${packageName(e.event_type)}${e.occasion ? ` · ${e.occasion}` : ""} · ${fmtDate(e.date)} · ${e.city || ""}</div>
          </div>
          ${e.stage === "Cancelled"
            ? `<span class="tag" style="color:#A64B3C; font-weight:700;">⚠ CANCELLED</span>`
            : `<span class="tag" style="color:${statusColor[e.status]};">${statusLabel[e.status]}</span>`}
        </div>
        ${e.stage === "Cancelled" ? `<p class="muted small" style="color:#A64B3C; margin-top:4px;">This event has been cancelled by the team — no action needed.</p>` : `
        ${e.event_time || e.soundcheck_time ? `
        <div class="performer-event-row">
          <span class="muted small">Timing:</span>
          <span>${e.soundcheck_time ? `Sound check ${fmtTimeHM(e.soundcheck_time)}` : ""}${e.soundcheck_time && e.event_time ? " · " : ""}${e.event_time ? `Event ${fmtTimeHM(e.event_time)}` : ""}</span>
        </div>
        ` : ""}
        ${e.venue ? `
        <div class="performer-event-row">
          <span class="muted small">Venue:</span>
          <span>${e.venue}</span>
        </div>
        ` : ""}
        <div class="performer-event-row">
          <span class="muted small">Payment:</span>
          <span class="tag" style="color:${e.paid ? "#5C8A6B" : "#A64B3C"};">${e.paid ? "Paid" : "Unpaid"}</span>
          ${e.paid && e.payment_date ? `<span class="muted small">on ${fmtDate(e.payment_date)}${e.payment_mode ? ` via ${e.payment_mode}` : ""}</span>` : ""}
        </div>
        ${e.status === "cancel_requested" ? `
          <p class="muted small" style="margin-top:8px;">Waiting on admin to review your cancellation request.</p>
        ` : `
          <div style="margin-top:10px;">
            <label class="muted small">Your response</label>
            <select class="respond-select" data-respond-select="${e.id}">
              <option value="pending" ${e.status === "pending" ? "selected" : ""}>Pending — not responded yet</option>
              <option value="accepted" ${e.status === "accepted" ? "selected" : ""}>Accept</option>
              <option value="declined" ${e.status === "declined" ? "selected" : ""}>Decline</option>
            </select>
          </div>
        `}
        ${e.status === "accepted" ? `
          <button class="btn-ghost full" data-request-cancel="${e.id}" style="margin-top:8px; color:#A64B3C;">Request to cancel</button>
        ` : ""}
        <button class="btn-ghost full" data-chat-lead="${e.lead_id}" data-chat-name="${e.lead_name}" style="margin-top:10px;">💬 Event chat</button>
        `}
      </div>
    `).join("")}

    ${recentPastEvents.length > 0 ? `
      <div class="section-label" style="margin-top:20px;">Recently completed — pay status</div>
      ${recentPastEvents.map((e) => `
        <div class="card performer-event-card" style="margin-bottom:10px;">
          <div class="performer-event-head">
            <div>
              <div class="team-name">${e.lead_name}</div>
              <div class="muted small">${packageName(e.event_type)} · ${fmtDate(e.date)}</div>
            </div>
            <span class="tag" style="color:${e.paid ? "#5C8A6B" : "#A64B3C"};">${e.paid ? "Paid" : "Unpaid"}</span>
          </div>
          <div class="performer-event-row">
            <span class="muted small">Artist fee:</span>
            <span class="mono">${e.fee_amount ? inr(e.fee_amount) : "—"}</span>
          </div>
          ${e.paid && e.payment_date ? `<div class="muted small">Paid on ${fmtDate(e.payment_date)}${e.payment_mode ? ` via ${e.payment_mode}` : ""}</div>` : ""}
        </div>
      `).join("")}
    ` : ""}

    <div class="section-label" style="margin-top:20px;">Your tasks</div>
    <div class="card" id="perfTasksCard" style="margin-bottom:20px;">
      ${tasks.length === 0 ? `<p class="muted small">No tasks assigned to you.</p>` : tasks.map((t) => `
        <div class="task-row${t.done ? " done" : ""}">
          <input type="checkbox" data-task-id="${t.id}" ${t.done ? "checked" : ""} />
          <div class="task-title">${t.title}</div>
          <div class="task-meta">${t.due_date ? fmtDate(t.due_date) : "No due date"}</div>
        </div>
      `).join("")}
    </div>

    <div class="section-label">Payment summary</div>
    <div class="dash-stats" style="grid-template-columns:1fr 1fr;">
      <div class="card dash-stat"><div class="muted">Paid</div><div class="mono big" style="color:#5C8A6B">${paidCount}</div></div>
      <div class="card dash-stat"><div class="muted">Unpaid</div><div class="mono big" style="color:#A64B3C">${unpaidCount}</div></div>
    </div>
  `;

  wireCalendarGridPerformer(document.getElementById("perfCalCard"), activeEvents);

  body.querySelectorAll("[data-dismiss-notif]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/my/notifications/${btn.dataset.dismissNotif}`, { method: "DELETE" });
      btn.closest(".dash-list-item").remove();
      if (!document.querySelector("#perfNotifCard .dash-list-item")) {
        document.querySelector("#perfNotifCard")?.previousElementSibling?.remove();
        document.querySelector("#perfNotifCard")?.remove();
      }
    });
  });

  const perfGeneralMsgBtn = body.querySelector("#sendGeneralMsgBtn");
  if (perfGeneralMsgBtn) {
    perfGeneralMsgBtn.addEventListener("click", async () => {
      const input = body.querySelector("#generalMsgInput");
      const msgBody = input.value.trim();
      if (!msgBody) return;
      perfGeneralMsgBtn.disabled = true;
      try {
        await api("/api/messages/general", { method: "POST", body: JSON.stringify({ body: msgBody }) });
        input.value = "";
        const note = body.querySelector("#generalMsgSentNote");
        note.style.display = "inline";
        setTimeout(() => { note.style.display = "none"; }, 2000);
      } catch (err) {
        alert(err.message);
      } finally {
        perfGeneralMsgBtn.disabled = false;
      }
    });
  }

  body.querySelectorAll("[data-respond-select]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const value = sel.value;
      if (value === "pending") { renderPerformerApp(); return; } // no valid way back to pending, just refresh
      try {
        await api(`/api/my/assignments/${sel.dataset.respondSelect}/respond`, { method: "POST", body: JSON.stringify({ status: value }) });
        renderPerformerApp();
      } catch (err) {
        alert(err.message);
        renderPerformerApp();
      }
    });
  });
  body.querySelectorAll("[data-request-cancel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const reason = prompt("Why do you need to cancel this event? This goes to the admin for review.");
      if (reason === null) return;
      if (!reason.trim()) return alert("A reason is required.");
      try {
        await api(`/api/my/assignments/${btn.dataset.requestCancel}/request-cancel`, { method: "POST", body: JSON.stringify({ reason }) });
        renderPerformerApp();
      } catch (err) {
        alert(err.message);
      }
    });
  });
  body.querySelectorAll("[data-chat-lead]").forEach((btn) => {
    btn.addEventListener("click", () => openEventChat(btn.dataset.chatLead, btn.dataset.chatName));
  });
  body.querySelectorAll("[data-task-id]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      await api(`/api/tasks/${cb.dataset.taskId}`, { method: "PATCH", body: JSON.stringify({ done: cb.checked }) });
      renderPerformerApp();
    });
  });
}

function wireCalendarGridPerformer(container, events) {
  if (!container) return;
  container.querySelector("#prevMonth").addEventListener("click", () => {
    calMonth--; if (calMonth < 1) { calMonth = 12; calYear--; }
    container.innerHTML = performerCalendarMarkup(events);
    wireCalendarGridPerformer(container, events);
  });
  container.querySelector("#nextMonth").addEventListener("click", () => {
    calMonth++; if (calMonth > 12) { calMonth = 1; calYear++; }
    container.innerHTML = performerCalendarMarkup(events);
    wireCalendarGridPerformer(container, events);
  });
}

// Shared event-chat modal — used by both the performer view and the admin's Assign Team modal.
let eventChatInterval = null;
async function openEventChat(leadId, leadName) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal-card">
        <div class="modal-head"><h3>${leadName} — chat</h3><button class="icon-btn" id="closeModal">✕</button></div>
        <div class="modal-body">
          <div id="chatMessages" class="chat-messages"></div>
          <div style="display:flex; gap:8px; margin-top:10px;">
            <input id="chatInput" placeholder="Message the team…" style="flex:1;" />
            <button class="btn-primary" id="chatSendBtn">Send</button>
          </div>
        </div>
      </div>
    </div>
  `;
  const close = () => {
    if (eventChatInterval) clearInterval(eventChatInterval);
    eventChatInterval = null;
    root.innerHTML = "";
  };
  root.querySelector("#closeModal").addEventListener("click", close);
  root.querySelector("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") close(); });

  async function loadMessages() {
    let msgs;
    try {
      msgs = await api(`/api/my/events/${leadId}/messages`);
    } catch {
      return;
    }
    const container = root.querySelector("#chatMessages");
    if (!container) return;
    container.innerHTML = msgs.length === 0
      ? `<p class="muted small">No messages yet — say hello.</p>`
      : msgs.map((m) => `
          <div style="margin-bottom:8px;">
            <div class="muted small"><strong>${m.author_name}</strong> · ${new Date(m.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
            <div>${m.body}</div>
          </div>
        `).join("");
    container.scrollTop = container.scrollHeight;
  }

  root.querySelector("#chatSendBtn").addEventListener("click", async () => {
    const input = root.querySelector("#chatInput");
    if (!input.value.trim()) return;
    await api(`/api/my/events/${leadId}/messages`, { method: "POST", body: JSON.stringify({ body: input.value }) });
    input.value = "";
    loadMessages();
  });
  root.querySelector("#chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") root.querySelector("#chatSendBtn").click();
  });

  await loadMessages();
  eventChatInterval = setInterval(loadMessages, 5000);
}

// ---------- Boot ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

(async function init() {
  try {
    CURRENT_USER = await api("/api/auth/me");
  } catch {
    renderLoginScreen();
    return;
  }
  if (CURRENT_USER.accessLevel === "performer") {
    renderPerformerApp();
    return;
  }
  const brandTag = document.getElementById("brandTag");
  if (brandTag) brandTag.textContent = CURRENT_USER.name || CURRENT_USER.username;
  await loadAll();
  renderNav();
  renderMain();
  initMobileNav();
  initLogoNav();
})();
