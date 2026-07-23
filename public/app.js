// ---------- State ----------
let CONFIG = { stages: [], packages: [], addons: [] };
let LEADS = [];
let TEAM = [];
let TASKS = [];
let currentTab = "dashboard";
let leadsFilter = "all";
let leadsStageFilter = "all";
let quotationLeadId = null;
let calYear = 2026, calMonth = 9; // September 2026, 1-indexed

const STAGE_COLOR = {
  New: "#8A8578",
  Quoted: "#C98B3D",
  "Follow-up": "#B6752C",
  Confirmed: "#5C8A6B",
  Completed: "#2E5C63",
  Cancelled: "#A64B3C",
};

const NAV = [
  { id: "dashboard", label: "Dashboard" },
  { id: "leads", label: "Leads" },
  { id: "pipeline", label: "Pipeline" },
  { id: "quotation", label: "Quotation" },
  { id: "tasks", label: "Tasks" },
  { id: "documents", label: "Documents" },
  { id: "calendar", label: "Calendar" },
  { id: "team", label: "Team" },
  { id: "accounts", label: "Accounts" },
];

// ---------- Helpers ----------
const inr = (n) => (n == null ? "—" : "₹" + Number(n).toLocaleString("en-IN"));
const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
const packageName = (id) => CONFIG.packages.find((p) => p.id === id)?.name || id;
const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; };

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers || {}) },
  });
  if (!res.ok) throw new Error((await res.json()).error || "Request failed");
  return res.json();
}

async function loadAll() {
  [CONFIG, LEADS, TEAM, TASKS] = await Promise.all([
    api("/api/config"),
    api("/api/leads"),
    api("/api/team"),
    api("/api/tasks"),
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
  NAV.forEach(({ id, label }) => {
    const btn = el(`<button class="nav-item${currentTab === id ? " nav-item-active" : ""}">${label}</button>`);
    btn.addEventListener("click", () => { currentTab = id; renderNav(); renderMain(); });
    nav.appendChild(btn);
  });
  document.getElementById("sidebarFoot").textContent = "Live — SQLite backend";
}

// Jump from a dashboard card straight to the matching filtered Leads list.
function goToLeads(stage) {
  leadsFilter = "all";
  leadsStageFilter = stage;
  currentTab = "leads";
  renderNav();
  renderMain();
}

// ---------- Mala progress ----------
function malaHtml(stage) {
  const order = ["New", "Quoted", "Follow-up", "Confirmed", "Completed"];
  const idx = order.indexOf(stage);
  return `<div class="mala">${order.map((s, i) =>
    `<span class="bead" style="${i <= idx ? `background:${STAGE_COLOR[stage]}` : ""}" title="${s}"></span>`
  ).join("")}</div>`;
}

// ---------- Leads log ----------
function renderLeadsLog(main) {
  const filtered = (leadsFilter === "all" ? LEADS : LEADS.filter((l) => l.event_type === leadsFilter))
    .filter((l) => leadsStageFilter === "all" || l.stage === leadsStageFilter);
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

    ${leadsStageFilter !== "all" ? `
      <button class="filter-chip filter-chip-active" id="clearStageFilter" style="margin-bottom:10px;">
        Stage: ${leadsStageFilter} ✕
      </button>
    ` : ""}
    <div class="filter-row" id="filterRow"></div>
    <div class="table leads-table">
      <div class="table-head leads-table-row">
        <span>Query</span><span>Format</span><span>City</span><span>Date</span><span>Email</span><span>Stage</span><span></span>
      </div>
      <div id="leadsRows"></div>
    </div>
  `;

  const clearBtn = main.querySelector("#clearStageFilter");
  if (clearBtn) clearBtn.addEventListener("click", () => { leadsStageFilter = "all"; renderMain(); });

  const filterRow = main.querySelector("#filterRow");
  const allChip = el(`<button class="filter-chip${leadsFilter === "all" ? " filter-chip-active" : ""}">All <span class="mono">${LEADS.length}</span></button>`);
  allChip.addEventListener("click", () => { leadsFilter = "all"; renderMain(); });
  filterRow.appendChild(allChip);

  CONFIG.packages.forEach((p) => {
    const chip = el(`<button class="filter-chip${leadsFilter === p.id ? " filter-chip-active" : ""}">${p.name} <span class="mono">${countFor(p.id)}</span></button>`);
    chip.addEventListener("click", () => { leadsFilter = p.id; renderMain(); });
    filterRow.appendChild(chip);
  });

  const rows = main.querySelector("#leadsRows");
  const sorted = filtered.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  if (sorted.length === 0) {
    rows.innerHTML = `<div class="board-empty">No queries in this category yet</div>`;
  } else {
    sorted.forEach((l) => {
      rows.appendChild(el(`
        <div class="table-row leads-table-row">
          <span><div class="lead-name">${l.name}</div><div class="muted small">${l.phone || ""}</div></span>
          <span>${packageName(l.event_type)}</span>
          <span>${l.city || "—"}</span>
          <span class="mono">${fmtDate(l.date)}</span>
          <span class="muted small">${l.email || "—"}</span>
          <span>
            <select class="stage-select" data-lead-id="${l.id}" style="color:${STAGE_COLOR[l.stage]}">
              ${CONFIG.stages.map((s) => `<option value="${s}" ${s === l.stage ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </span>
          <span>
            ${l.stage === "Completed" ? "" : `<button class="btn-ghost quote-lead-btn" data-lead-id="${l.id}">Quote</button>`}
          </span>
        </div>
      `));
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

  main.querySelectorAll(".stage-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const leadId = sel.dataset.leadId;
      const newStage = sel.value;
      sel.disabled = true;
      try {
        await api(`/api/leads/${leadId}`, { method: "PATCH", body: JSON.stringify({ stage: newStage }) });
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

// ---------- Pipeline ----------
function renderPipeline(main) {
  const stages = ["New", "Quoted", "Follow-up", "Confirmed", "Completed"];
  main.innerHTML = `
    <div class="view-head">
      <div><h2>Pipeline</h2><p class="muted">Every lead, from first message to completed event.</p></div>
      <button class="btn-primary" id="newLeadBtn2">+ New lead</button>
    </div>
    <div class="board" id="board"></div>
  `;
  const board = main.querySelector("#board");
  stages.forEach((stage) => {
    const items = LEADS.filter((l) => l.stage === stage);
    const col = el(`
      <div class="board-col">
        <div class="board-col-head">
          <span class="dot" style="background:${STAGE_COLOR[stage]}"></span>
          <span>${stage}</span><span class="count">${items.length}</span>
        </div>
        <div class="colItems"></div>
      </div>
    `);
    const colItems = col.querySelector(".colItems");
    if (items.length === 0) {
      colItems.appendChild(el(`<div class="board-empty">No leads here yet</div>`));
    }
    items.forEach((l) => {
      colItems.appendChild(el(`
        <div class="lead-card">
          <div class="lead-name">${l.name}</div>
          <div class="lead-meta">${packageName(l.event_type)}</div>
          <div class="lead-meta mono">${fmtDate(l.date)} · ${l.city || ""}</div>
          ${malaHtml(l.stage)}
        </div>
      `));
    });
    board.appendChild(col);
  });
  main.querySelector("#newLeadBtn2").addEventListener("click", openNewLeadModal);
}

// ---------- Quotation ----------
