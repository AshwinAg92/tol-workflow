// ---------- State ----------
let CONFIG = { stages: [], packages: [], addons: [] };
let LEADS = [];
let TEAM = [];
let TASKS = [];
let currentTab = "dashboard";
let leadsFilter = "all";
let leadsStageFilter = "all";
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
        <span>Query</span><span>Format</span><span>City</span><span>Date</span><span>Email</span><span>Stage</span>
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
        </div>
      `));
    });
  }

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
function renderQuotation(main) {
  const quotable = LEADS.filter((l) => l.stage !== "Completed");
  main.innerHTML = `
    <div class="view-head">
      <div><h2>Quotation</h2><p class="muted">Pick a lead, choose the format, send the number.</p></div>
    </div>
    <div class="quote-grid">
      <div class="card">
        <label>Lead</label>
        <select id="leadSelect">
          ${quotable.map((l) => `<option value="${l.id}">${l.name} — ${fmtDate(l.date)}</option>`).join("")}
        </select>
        <div class="section-label">Format</div>
        <div id="pkgChecks"></div>
        <div class="section-label">Add-ons</div>
        <div id="addonChecks"></div>
        <div class="total-row"><span>Total</span><span class="mono total-amt" id="totalAmt">₹0</span></div>
        <button class="btn-primary full" id="sendQuoteBtn">💬 Mark as quoted & prepare messages</button>
      </div>
      <div class="card email-preview">
        <div class="section-label">Message preview</div>
        <div id="emailPreview"></div>
      </div>
    </div>
  `;

  if (quotable.length === 0) {
    main.querySelector(".quote-grid").innerHTML = `<p class="muted">No leads available to quote right now.</p>`;
    return;
  }

  const pkgChecks = main.querySelector("#pkgChecks");
  CONFIG.packages.forEach((p) => {
    pkgChecks.appendChild(el(`
      <label class="check-row"><input type="checkbox" data-pkg="${p.id}" />
        <span>${p.name}</span><span class="mono right">${inr(p.rate)}</span></label>
    `));
  });
  const addonChecks = main.querySelector("#addonChecks");
  CONFIG.addons.forEach((a) => {
    addonChecks.appendChild(el(`
      <label class="check-row"><input type="checkbox" data-addon="${a.id}" />
        <span>${a.name}</span><span class="mono right muted">${a.rate ? inr(a.rate) : a.note}</span></label>
    `));
  });

  const selected = () => ({
    packageIds: [...main.querySelectorAll("[data-pkg]:checked")].map((c) => c.dataset.pkg),
    addonIds: [...main.querySelectorAll("[data-addon]:checked")].map((c) => c.dataset.addon),
  });

  function updatePreview() {
    const { packageIds, addonIds } = selected();
    const lead = LEADS.find((l) => l.id === main.querySelector("#leadSelect").value);
    const chosenPackages = CONFIG.packages.filter((p) => packageIds.includes(p.id));
    const chosenAddons = CONFIG.addons.filter((a) => addonIds.includes(a.id));
    const total = chosenPackages.reduce((s, p) => s + p.rate, 0) + chosenAddons.reduce((s, a) => s + (a.rate || 0), 0);
    main.querySelector("#totalAmt").textContent = inr(total);

    const items = [...chosenPackages, ...chosenAddons].map((x) => `<li>${x.name}</li>`).join("") || `<li class="muted">Select a format or add-on</li>`;
    main.querySelector("#emailPreview").innerHTML = lead ? `
      <div class="email-field"><span class="muted">WhatsApp to</span> ${lead.phone || "(no phone on file)"}</div>
      <div class="email-field"><span class="muted">Email to</span> ${lead.email || "(no email on file)"}</div>
      <div class="email-field"><span class="muted">Re</span> Quotation for ${packageName(lead.event_type)} — Together Out Loud</div>
      <div class="email-body">Dear ${lead.name.split(" ")[0]},

Thank you for reaching out to Together Out Loud. Here is our quotation for your event on ${fmtDate(lead.date)} in ${lead.city || ""}:
<ul style="margin:8px 0;">${items}</ul>
Total: ${inr(total)}

Excludes travel and accommodation unless noted above. Valid for 7 days.</div>
    ` : `<p class="muted">Select a lead to preview the email.</p>`;
  }

  main.querySelectorAll("[data-pkg], [data-addon]").forEach((c) => c.addEventListener("change", updatePreview));
  main.querySelector("#leadSelect").addEventListener("change", updatePreview);
  updatePreview();

  main.querySelector("#sendQuoteBtn").addEventListener("click", async () => {
    const leadId = main.querySelector("#leadSelect").value;
    const { packageIds, addonIds } = selected();
    if (packageIds.length === 0 && addonIds.length === 0) return;
    const btn = main.querySelector("#sendQuoteBtn");
    btn.disabled = true;
    btn.textContent = "Preparing…";
    try {
      const result = await api(`/api/leads/${leadId}/quote`, { method: "POST", body: JSON.stringify({ packageIds, addonIds }) });
      await refreshLeads();

      const waHtml = result.whatsapp.link
        ? `<div class="email-status sent">💬 Opened WhatsApp for ${result.lead.phone} — <a href="${result.whatsapp.link}" target="_blank">click here</a> if it didn't open</div>`
        : `<div class="email-status unsent">💬 Couldn't prepare WhatsApp message — ${result.whatsapp.reason}</div>`;

      const mailHtml = result.mailto.link
        ? `<div class="email-status sent">✉️ <a href="${result.mailto.link}">Click here to send by email</a> — opens your email app with everything filled in</div>`
        : `<div class="email-status unsent">✉️ Couldn't prepare email — ${result.mailto.reason}</div>`;

      if (result.whatsapp.link) window.open(result.whatsapp.link, "_blank");
      main.querySelector("#emailPreview").insertAdjacentHTML("beforeend", waHtml + mailHtml);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "💬 Mark as quoted & prepare messages";
    }
  });
}

// ---------- Calendar ----------
function renderCalendar(main) {
  const confirmed = LEADS.filter((l) => l.stage === "Confirmed" || l.stage === "Completed");
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
  const monthName = first.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  main.innerHTML = `
    <div class="view-head"><div><h2>Calendar</h2><p class="muted">Confirmed and completed events — spot clashes before you quote.</p></div></div>
    <div class="card">
      <div class="cal-nav">
        <button class="btn-ghost" id="prevMonth">‹</button>
        <div class="cal-month">${monthName}</div>
        <button class="btn-ghost" id="nextMonth">›</button>
      </div>
      <div class="cal-grid cal-head">${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => `<div>${d}</div>`).join("")}</div>
      <div class="cal-grid" id="calCells"></div>
    </div>
    <div class="section-label" style="margin-top:20px;">Upcoming confirmed events</div>
    <div class="list" id="calList"></div>
  `;

  const calCells = main.querySelector("#calCells");
  cells.forEach((d) => {
    const evs = d ? (eventsByDay[d] || []) : [];
    calCells.appendChild(el(`
      <div class="cal-cell${d ? "" : " cal-cell-empty"}">
        ${d ? `<div class="cal-day">${d}</div>` : ""}
        ${evs.map((ev) => `<div class="cal-event" title="${ev.name}">${ev.name.split(" ")[0]}</div>`).join("")}
      </div>
    `));
  });

  const calList = main.querySelector("#calList");
  if (confirmed.length === 0) calList.innerHTML = `<div class="board-empty">No confirmed events yet</div>`;
  confirmed.forEach((l) => {
    calList.appendChild(el(`
      <div class="list-row">
        <span class="mono">${fmtDate(l.date)}</span><span>${l.name}</span><span class="muted">${l.city || ""}</span>
        <span class="tag" style="color:${STAGE_COLOR[l.stage]}">${l.stage}</span>
      </div>
    `));
  });

  main.querySelector("#prevMonth").addEventListener("click", () => { calMonth--; if (calMonth < 1) { calMonth = 12; calYear--; } renderMain(); });
  main.querySelector("#nextMonth").addEventListener("click", () => { calMonth++; if (calMonth > 12) { calMonth = 1; calYear++; } renderMain(); });
}

// ---------- Team ----------
function renderTeam(main) {
  main.innerHTML = `
    <div class="view-head"><div><h2>Team</h2><p class="muted">Who's carrying which leads right now.</p></div></div>
    <div class="team-grid" id="teamGrid"></div>
  `;
  const grid = main.querySelector("#teamGrid");
  TEAM.forEach((m) => {
    grid.appendChild(el(`
      <div class="card team-card">
        <div class="team-avatar">${m.name[0]}</div>
        <div class="team-name">${m.name}</div>
        <div class="muted">${m.role}</div>
        <div class="team-count mono">${m.activeLeads.length} active lead${m.activeLeads.length === 1 ? "" : "s"}</div>
        ${m.activeLeads.map((l) => `<div class="team-lead">› ${l.name}</div>`).join("")}
      </div>
    `));
  });
}

// ---------- Accounts ----------
async function renderAccounts(main) {
  const { bookings, totals } = await api("/api/accounts");
  main.innerHTML = `
    <div class="view-head"><div><h2>Accounts</h2><p class="muted">Quoted, received, and outstanding, per booking.</p></div></div>
    <div class="accounts-summary">
      <div class="card summary-card"><div class="muted">Total quoted</div><div class="mono big">${inr(totals.quoted)}</div></div>
      <div class="card summary-card"><div class="muted">Received</div><div class="mono big" style="color:${STAGE_COLOR.Confirmed}">${inr(totals.received)}</div></div>
      <div class="card summary-card"><div class="muted">Outstanding</div><div class="mono big" style="color:${STAGE_COLOR["Follow-up"]}">${inr(totals.outstanding)}</div></div>
    </div>
    <div class="table">
      <div class="table-head"><span>Booking</span><span>Status</span><span class="right">Quoted</span><span class="right">Received</span><span class="right">Balance</span></div>
      <div id="acctRows"></div>
    </div>
  `;
  const rows = main.querySelector("#acctRows");
  if (bookings.length === 0) rows.innerHTML = `<div class="board-empty">No quoted bookings yet</div>`;
  bookings.forEach((l) => {
    rows.appendChild(el(`
      <div class="table-row">
        <span>${l.name}</span>
        <span class="tag" style="color:${STAGE_COLOR[l.stage]}">${l.stage}</span>
        <span class="right mono">${inr(l.quote_amount)}</span>
        <span class="right mono">${inr(l.advance)}</span>
        <span class="right mono">${inr((l.quote_amount || 0) - (l.advance || 0))}</span>
      </div>
    `));
  });
}

// ---------- Dashboard ----------
async function renderDashboard(main) {
  const data = await api("/api/dashboard");
  main.innerHTML = `
    <div class="view-head"><div><h2>Dashboard</h2><p class="muted">The three things that matter today — click any card to see the list.</p></div></div>
    <div class="dash-stats">
      <button class="card dash-stat dash-stat-click" id="statNew"><div class="muted">New queries</div><div class="mono big">${data.newLeadsCount}</div></button>
      <button class="card dash-stat dash-stat-click" id="statFollowup"><div class="muted">Awaiting follow-up</div><div class="mono big" style="color:${STAGE_COLOR["Follow-up"]}">${data.pendingFollowUps.length}</div></button>
      <button class="card dash-stat dash-stat-click" id="statUpcoming"><div class="muted">Upcoming events</div><div class="mono big" style="color:${STAGE_COLOR.Confirmed}">${data.upcomingEvents.length}</div></button>
    </div>
    <div class="dash-grid">
      <div class="card">
        <div class="section-label">Upcoming events</div>
        ${data.upcomingEvents.length === 0 ? `<p class="muted small">Nothing confirmed and upcoming yet.</p>` : data.upcomingEvents.map((l) => `
          <div class="dash-list-item dash-list-item-click" data-lead-id="${l.id}">
            <div>${l.name} — <span class="mono">${fmtDate(l.date)}</span></div>
            <div class="muted">${packageName(l.event_type)} · ${l.city || ""}</div>
          </div>
        `).join("")}
      </div>
      <div class="card">
        <div class="section-label">Leads waiting on a follow-up</div>
        ${data.pendingFollowUps.length === 0 ? `<p class="muted small">No one's waiting on you right now.</p>` : data.pendingFollowUps.map((l) => `
          <div class="dash-list-item dash-list-item-click" data-lead-id="${l.id}">
            <div>${l.name} <span class="muted">— ${packageName(l.event_type)}</span></div>
            <div class="muted">${fmtDate(l.date)} · ${l.city || ""}</div>
          </div>
        `).join("")}
      </div>
    </div>
  `;

  main.querySelector("#statNew").addEventListener("click", () => goToLeads("New"));
  main.querySelector("#statFollowup").addEventListener("click", () => goToLeads("Follow-up"));
  main.querySelector("#statUpcoming").addEventListener("click", () => goToLeads("Confirmed"));
  main.querySelectorAll(".dash-list-item-click").forEach((row) => {
    row.addEventListener("click", () => {
      const lead = LEADS.find((l) => l.id === row.dataset.leadId);
      goToLeads(lead ? lead.stage : "all");
    });
  });
}

// ---------- Tasks ----------
function renderTasks(main) {
  main.innerHTML = `
    <div class="view-head"><div><h2>Tasks</h2><p class="muted">The checklist behind each booking — who's doing what, by when.</p></div></div>
    <div class="card" style="margin-bottom:16px;">
      <div class="section-label">New task</div>
      <div class="task-form">
        <input type="text" id="taskTitle" placeholder="e.g. Confirm venue booking" />
        <select id="taskLead"><option value="">No specific lead</option>${LEADS.map((l) => `<option value="${l.id}">${l.name}</option>`).join("")}</select>
        <select id="taskAssignee"><option value="">Unassigned</option>${TEAM.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}</select>
        <input type="date" id="taskDue" />
        <button class="btn-primary" id="addTaskBtn">Add</button>
      </div>
    </div>
    <div class="table">
      <div id="taskRows"></div>
    </div>
  `;

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
  main.innerHTML = `
    <div class="view-head"><div><h2>Documents</h2><p class="muted">Contracts, invoices, and files, kept against the booking they belong to.</p></div></div>
    <div class="card" style="margin-bottom:16px;">
      <div class="section-label">Upload a file</div>
      <div class="upload-form">
        <select id="docLead"><option value="">Not tied to a specific lead</option>${LEADS.map((l) => `<option value="${l.id}">${l.name}</option>`).join("")}</select>
        <input type="file" id="docFile" />
        <button class="btn-primary" id="uploadBtn">Upload</button>
      </div>
    </div>
    <div class="table"><div id="docRows"></div></div>
  `;

  const docs = await api("/api/documents");
  const rows = main.querySelector("#docRows");
  if (docs.length === 0) rows.innerHTML = `<div class="board-empty">No documents uploaded yet</div>`;
  docs.forEach((d) => {
    const lead = LEADS.find((l) => l.id === d.lead_id);
    rows.appendChild(el(`
      <div class="doc-row">
        <div class="doc-name"><a href="${d.url}" target="_blank">${d.original_name}</a>${lead ? ` <span class="muted">— ${lead.name}</span>` : ""}</div>
        <div class="muted mono">${fmtDate(d.uploaded_at.slice(0, 10))}</div>
        <button class="icon-btn" data-delete-doc="${d.id}">✕</button>
      </div>
    `));
  });
  rows.querySelectorAll("[data-delete-doc]").forEach((btn) => {
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
          <div class="row-2">
            <div><label>Format wanted</label><select id="mType">${CONFIG.packages.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}</select></div>
            <div><label>City</label><input id="mCity" placeholder="e.g. Siliguri" /></div>
          </div>
          <div class="row-2">
            <div><label>Event date</label><input id="mDate" type="date" /></div>
            <div><label>Budget (optional)</label><input id="mBudget" placeholder="e.g. 90000" /></div>
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
  root.querySelector("#submitModal").addEventListener("click", async () => {
    const name = root.querySelector("#mName").value;
    const date = root.querySelector("#mDate").value;
    if (!name || !date) return alert("Name and event date are required.");
    await api("/api/leads", {
      method: "POST",
      body: JSON.stringify({
        name,
        phone: root.querySelector("#mPhone").value,
        email: root.querySelector("#mEmail").value,
        eventType: root.querySelector("#mType").value,
        city: root.querySelector("#mCity").value,
        date,
        budget: root.querySelector("#mBudget").value ? Number(root.querySelector("#mBudget").value) : null,
      }),
    });
    await refreshLeads();
    close();
    renderMain();
  });
}

// ---------- Main dispatch ----------
function renderMain() {
  const main = document.getElementById("main");
  if (currentTab === "dashboard") renderDashboard(main);
  else if (currentTab === "leads") renderLeadsLog(main);
  else if (currentTab === "pipeline") renderPipeline(main);
  else if (currentTab === "quotation") renderQuotation(main);
  else if (currentTab === "tasks") renderTasks(main);
  else if (currentTab === "documents") renderDocuments(main);
  else if (currentTab === "calendar") renderCalendar(main);
  else if (currentTab === "team") renderTeam(main);
  else if (currentTab === "accounts") renderAccounts(main);
}

// ---------- Boot ----------
(async function init() {
  await loadAll();
  renderNav();
  renderMain();
})();
