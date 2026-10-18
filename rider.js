// Tech rider: instrument catalog, auto-spec (channels, stands, power, monitors, stage size),
// stage-plot SVG whose layout follows the chosen instruments, and the client-facing page.
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// row: "front" (vocals / melody players) or "back" (rhythm / keys). code = badge on the stage plot.
const CATALOG = [
  { id: "vocal_lead", label: "Lead vocal", code: "VOX", row: "front", ch: 1, mic: "Vocal mic (dynamic, e.g. SM58 / e835) on boom stand", stands: 1, di: 0, power: 0, monitor: 1, seated: 0, color: "#C1602B", prio: 0 },
  { id: "vocal_2", label: "Second vocal", code: "VOX", row: "front", ch: 1, mic: "Vocal mic (dynamic, e.g. SM58 / e835) on boom stand", stands: 1, di: 0, power: 0, monitor: 1, seated: 0, color: "#C1602B", prio: 1 },
  { id: "backing_vocal", label: "Backing vocal", code: "BV", row: "front", ch: 1, mic: "Vocal mic (dynamic) on boom stand", stands: 1, di: 0, power: 0, monitor: 1, seated: 0, color: "#C1602B", prio: 2 },
  { id: "harmonium", label: "Harmonium", code: "HAR", row: "front", ch: 1, mic: "Condenser mic on stand (or DI if fitted)", stands: 1, di: 0, power: 0, monitor: 1, seated: 1, color: "#8A5A1F", prio: 3 },
  { id: "guitar_ac", label: "Acoustic guitar", code: "AGT", row: "front", ch: 1, mic: "DI box (XLR) from pickup", stands: 0, di: 1, power: 0, monitor: 1, seated: 0, color: "#1C7A80", prio: 4 },
  { id: "flute", label: "Flute", code: "FLT", row: "front", ch: 1, mic: "Condenser / clip-on mic on stand", stands: 1, di: 0, power: 0, monitor: 1, seated: 0, color: "#1C7A80", prio: 5 },
  { id: "violin", label: "Violin", code: "VLN", row: "front", ch: 1, mic: "Mic on stand (or DI if fitted)", stands: 1, di: 0, power: 0, monitor: 1, seated: 0, color: "#1C7A80", prio: 6 },
  { id: "guitar_el", label: "Electric guitar", code: "EGT", row: "front", ch: 1, mic: "Amp mic (dynamic) or DI — own amp", stands: 1, di: 0, power: 1, monitor: 1, seated: 0, color: "#1C7A80", prio: 7 },
  { id: "keys", label: "Keyboard", code: "KEY", row: "back", ch: 2, mic: "2× DI box (stereo L / R)", stands: 0, di: 2, power: 1, monitor: 0, seated: 0, color: "#6B4FA0", prio: 5 },
  { id: "bass", label: "Bass guitar", code: "BAS", row: "back", ch: 1, mic: "DI box (XLR)", stands: 0, di: 1, power: 0, monitor: 0, seated: 0, color: "#6B4FA0", prio: 6 },
  { id: "dholak", label: "Dholak", code: "DHO", row: "back", ch: 2, mic: "2× mic, one per side (clip-on or short stand)", stands: 2, di: 0, power: 0, monitor: 0, seated: 1, color: "#B6752C", prio: 1 },
  { id: "tabla", label: "Tabla", code: "TAB", row: "back", ch: 2, mic: "2× condenser mics (tabla + bayan)", stands: 2, di: 0, power: 0, monitor: 0, seated: 1, color: "#B6752C", prio: 2 },
  { id: "percussion", label: "Percussion / octapad", code: "PRC", row: "back", ch: 2, mic: "2× DI box (pad outputs L / R)", stands: 0, di: 2, power: 1, monitor: 0, seated: 0, color: "#B6752C", prio: 3 },
  { id: "cajon", label: "Cajon", code: "CAJ", row: "back", ch: 1, mic: "1× dynamic mic on short boom", stands: 1, di: 0, power: 0, monitor: 0, seated: 1, color: "#B6752C", prio: 4 },
  { id: "drums", label: "Drum kit", code: "DRM", row: "back", ch: 5, mic: "Kick, snare, 2 toms + overhead mic (kit supplied separately)", stands: 4, di: 0, power: 0, monitor: 0, seated: 0, color: "#A6432B", prio: 0 },
];
const BY_ID = Object.fromEntries(CATALOG.map((c) => [c.id, c]));
// Sensible starting bands by size — the builder lets you change any of it.
const PRESETS = {
  2: ["vocal_lead", "harmonium"],
  3: ["vocal_lead", "harmonium", "dholak"],
  4: ["vocal_lead", "vocal_2", "harmonium", "dholak"],
  5: ["vocal_lead", "vocal_2", "guitar_ac", "keys", "dholak"],
  6: ["vocal_lead", "vocal_2", "harmonium", "guitar_ac", "keys", "dholak"],
  7: ["vocal_lead", "vocal_2", "harmonium", "guitar_ac", "keys", "dholak", "percussion"],
  8: ["vocal_lead", "vocal_2", "backing_vocal", "harmonium", "guitar_ac", "keys", "dholak", "percussion"],
};
const entryFromCatalog = (id) => { const c = BY_ID[id]; return c ? { id, label: c.label, mic: c.mic, ch: c.ch, note: "" } : null; };

const num = (v, d, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v, n) => String(v == null ? "" : v).slice(0, n);

// Keep only what we understand; fill spec fields (row, stands, power…) from the catalog so the client can't skew the maths.
function sanitize(input) {
  const d = input || {};
  const entries = (Array.isArray(d.instruments) ? d.instruments : []).slice(0, 16).map((e) => {
    const c = BY_ID[e && e.id];
    if (c) return { id: c.id, label: str(e.label || c.label, 40), mic: str(e.mic || c.mic, 120), ch: num(e.ch, c.ch, 0, 12), note: str(e.note, 120) };
    return { id: "custom", label: str((e && e.label) || "Other instrument", 40), mic: str((e && e.mic) || "Mic or DI — please confirm with us", 120), ch: num(e && e.ch, 1, 0, 12), note: str(e && e.note, 120), row: e && e.row === "back" ? "back" : "front" };
  });
  return {
    instruments: entries,
    soundBy: d.soundBy === "tol" ? "tol" : "venue",
    stageW: str(d.stageW, 20), stageD: str(d.stageD, 20),
    arrival: str(d.arrival, 40), soundcheck: str(d.soundcheck, 40), showTime: str(d.showTime, 40),
    contactName: str(d.contactName, 60), contactPhone: str(d.contactPhone, 30),
    requirements: str(d.requirements, 4000), notes: str(d.notes, 2000),
  };
}
const spec = (e) => { const c = BY_ID[e.id]; return c ? { row: c.row, stands: c.stands, di: c.di, power: c.power, monitor: c.monitor, seated: c.seated, code: c.code, color: c.color, prio: c.prio } : { row: e.row || "front", stands: e.ch || 1, di: 0, power: 0, monitor: 1, seated: 0, code: "OTH", color: "#7A6A58", prio: 20 }; };

function summarize(data) {
  const es = data.instruments.map((e) => ({ e, s: spec(e) }));
  const front = es.filter((x) => x.s.row === "front"), back = es.filter((x) => x.s.row === "back");
  const rows = Math.ceil(front.length / 5) + Math.ceil(back.length / 5);
  const widest = Math.max(1, Math.min(5, front.length || 0), Math.min(5, back.length || 0));
  const w = Math.max(16, widest * 6 + 4), dep = Math.max(12, Math.max(1, rows) * 6 + 4);
  return {
    pcs: es.length, channels: es.reduce((t, x) => t + x.e.ch, 0),
    stands: es.reduce((t, x) => t + (x.s.stands && x.e.ch ? x.s.stands : 0), 0), di: es.reduce((t, x) => t + x.s.di, 0),
    powerPts: es.reduce((t, x) => t + x.s.power, 0), seated: es.reduce((t, x) => t + x.s.seated, 0),
    monitors: Math.max(2, Math.min(6, es.filter((x) => x.s.monitor).length)), front: front.length, back: back.length,
    stage: `${data.stageW || w} ft × ${data.stageD || dep} ft`,
  };
}

// The text bullets under "What we need from the venue". Plain strings; the builder can edit any of them.
function autoRequirements(data) {
  const m = summarize(data), L = [];
  L.push(`Stage: minimum ${m.stage}, level, clean and covered (if outdoors), with a backdrop or banner space behind the band.`);
  if (data.soundBy === "tol") {
    L.push("Together, Out Loud brings its own sound system and engineer. Please provide clear access for load-in and a power supply as listed below.");
  } else {
    L.push(`Professional PA system suited to the venue and audience size, with an experienced sound engineer at front of house.`);
    L.push(`Mixer with at least ${m.channels + 2} input channels (${m.channels} used + 2 spare).`);
    L.push(`${m.monitors} stage monitor wedges on at least ${m.monitors > 3 ? 3 : 2} independent mixes.`);
    L.push(`${m.stands} microphone stands${m.di ? ` and ${m.di} DI boxes` : ""} as per the channel list below.`);
  }
  L.push(`Power: ${m.powerPts + 2} × 230 V power points on stage (surge-protected extension boards)${m.powerPts ? ` (${m.powerPts} for instruments)` : ""}, plus 2 spare.`);
  if (m.seated) L.push(`Seating: ${m.seated} low ${m.seated === 1 ? "stool / floor mat" : "stools / floor mats"} (rugs) for seated players, placed as shown on the plan.`);
  L.push("Stage lighting: warm front wash. Please avoid strobes or harsh flashing lights aimed at the performers.");
  L.push("Soundcheck: stage, sound and power ready and the venue quiet before our soundcheck slot.");
  L.push("Drinking water (room temperature) for the band on stage.");
  return L;
}

function stageSvg(data) {
  const es = data.instruments.map((e) => ({ e, s: spec(e) }));
  const place = (arr) => { // centre-out ordering by priority
    const sorted = arr.slice().sort((a, b) => a.s.prio - b.s.prio);
    const out = [];
    sorted.forEach((x, i) => { out[i % 2 === 0 ? "push" : "unshift"](x); });
    return out;
  };
  const chunk = (arr) => { const c = []; for (let i = 0; i < arr.length; i += 5) c.push(arr.slice(i, i + 5)); return c; };
  const frontRows = chunk(es.filter((x) => x.s.row === "front").sort((a, b) => a.s.prio - b.s.prio)).map(place);
  const backRows = chunk(es.filter((x) => x.s.row === "back").sort((a, b) => a.s.prio - b.s.prio)).map(place);
  // Audience is at the bottom: back rows first (top of the picture), front rows last.
  const ordered = [...backRows, ...frontRows]; // top → bottom
  const W = 680, rowH = 120, top = 70, H = top + Math.max(1, ordered.length) * rowH + 90;
  const stageX = 30, stageW = W - 60;
  let nodes = "";
  // channel numbers follow the order of the channel list (the order the entries were added)
  const chStart = new Map(); let c = 1; es.forEach((x) => { chStart.set(x.e, c); c += x.e.ch; });
  ordered.forEach((r, ri) => {
    const y = top + ri * rowH + 50;
    r.forEach((x, i) => {
      const cx = stageX + (stageW * (i + 1)) / (r.length + 1);
      const col = x.s.color, a = chStart.get(x.e), b = a + x.e.ch - 1;
      const chTxt = x.e.ch === 0 ? "no channel" : x.e.ch === 1 ? `CH ${a}` : `CH ${a}–${b}`;
      nodes += `<g>
        ${x.s.row === "front" && x.s.monitor ? `<polygon points="${cx - 16},${y + 38} ${cx + 16},${y + 38} ${cx + 10},${y + 50} ${cx - 10},${y + 50}" fill="#E9DFCF" stroke="#8A7A66" stroke-width="1"/>` : ""}
        ${x.s.stands && x.e.ch ? `<circle cx="${cx}" cy="${y + 30}" r="4" fill="none" stroke="#3A2A1A" stroke-width="1.5"/><line x1="${cx}" y1="${y + 34}" x2="${cx}" y2="${y + 38}" stroke="#3A2A1A" stroke-width="1.5"/>` : ""}
        <circle cx="${cx}" cy="${y}" r="26" fill="${col}" fill-opacity="0.92" stroke="#3A2A1A" stroke-width="1.5"/>
        <text x="${cx}" y="${y + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff" font-family="Arial,Helvetica,sans-serif">${esc(x.s.code)}</text>
        ${x.s.power ? `<rect x="${cx + 20}" y="${y - 32}" width="16" height="16" rx="3" fill="#FFF3C4" stroke="#8A5A1F"/><text x="${cx + 28}" y="${y - 20}" text-anchor="middle" font-size="10" font-weight="700" fill="#8A5A1F" font-family="Arial">P</text>` : ""}
        <text x="${cx}" y="${y + 62}" text-anchor="middle" font-size="12" font-weight="700" fill="#3A2A1A" font-family="Arial,Helvetica,sans-serif">${esc(x.e.label.length > 22 ? x.e.label.slice(0, 21) + "…" : x.e.label)}</text>
        <text x="${cx}" y="${y + 76}" text-anchor="middle" font-size="10.5" fill="#7A6A58" font-family="Arial,Helvetica,sans-serif">${esc(chTxt)}</text>
      </g>`;
    });
  });
  const stageBottom = top + ordered.length * rowH + 20;
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Stage plot" style="width:100%;height:auto;background:#fff;border:1px solid #E9DFCF;border-radius:10px">
    <text x="${W / 2}" y="26" text-anchor="middle" font-size="12" letter-spacing="3" fill="#8A7A66" font-family="Arial">BACK OF STAGE</text>
    <rect x="${stageX}" y="38" width="${stageW}" height="${stageBottom - 38}" rx="10" fill="#FBF3E4" stroke="#B49A72" stroke-width="2" stroke-dasharray="6 4"/>
    ${nodes}
    <text x="${W / 2}" y="${stageBottom + 30}" text-anchor="middle" font-size="12" letter-spacing="3" fill="#8A7A66" font-family="Arial">▼  AUDIENCE  ▼</text>
    <g font-family="Arial" font-size="10.5" fill="#5A4A38">
      <circle cx="${stageX + 8}" cy="${H - 16}" r="4" fill="none" stroke="#3A2A1A" stroke-width="1.5"/><text x="${stageX + 18}" y="${H - 12}">mic stand</text>
      <polygon points="${stageX + 90},${H - 20} ${stageX + 106},${H - 20} ${stageX + 102},${H - 10} ${stageX + 94},${H - 10}" fill="#E9DFCF" stroke="#8A7A66"/><text x="${stageX + 112}" y="${H - 12}">monitor wedge</text>
      <rect x="${stageX + 210}" y="${H - 22}" width="14" height="14" rx="3" fill="#FFF3C4" stroke="#8A5A1F"/><text x="${stageX + 217}" y="${H - 11}" text-anchor="middle" font-size="9" font-weight="700" fill="#8A5A1F">P</text><text x="${stageX + 230}" y="${H - 12}">power point</text>
    </g>
  </svg>`;
}

function renderRiderPage({ lead, data, token }) {
  const m = summarize(data);
  const reqs = (data.requirements && data.requirements.trim() ? data.requirements.split(/\n+/).map((s) => s.trim()).filter(Boolean) : autoRequirements(data));
  let chn = 1;
  const rows = data.instruments.map((e) => {
    const a = chn; chn += e.ch;
    return `<tr><td>${e.ch === 0 ? "—" : e.ch === 1 ? a : `${a}–${a + e.ch - 1}`}</td><td><b>${esc(e.label)}</b></td><td>${esc(e.mic)}</td><td>${esc(e.note)}</td></tr>`;
  }).join("");
  const when = (label, v) => (v ? `<div><span class="m">${label}</span><br><b>${esc(v)}</b></div>` : "");
  const venue = [lead.venue, lead.city].filter(Boolean).join(", ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Technical rider — Together, Out Loud</title>
<style>
*{box-sizing:border-box}body{font-family:Georgia,serif;background:#FBF6EC;color:#3A2A1A;margin:0;padding:18px}.w{max-width:760px;margin:0 auto}
h1{font-size:24px;margin:0}h2{font-size:14px;margin:26px 0 10px;text-transform:uppercase;letter-spacing:.08em;color:#8A5A1F;border-bottom:1px solid #E9DFCF;padding-bottom:4px}
.m{color:#7A6A58;font-size:12.5px}.c{background:#fff;border:1px solid #E9DFCF;border-radius:12px;padding:12px 14px}.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E9DFCF;border-radius:10px;overflow:hidden;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #EFE6D2;vertical-align:top}th{background:#F6EBD6;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
li{margin:6px 0;line-height:1.45}.btn{display:inline-block;padding:9px 16px;border-radius:999px;background:#C1602B;color:#fff;text-decoration:none;border:0;font:inherit;cursor:pointer}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
@media print{body{background:#fff;padding:0}.noprint{display:none!important}h2{break-after:avoid}svg,table,.c{break-inside:avoid}}
</style></head><body><div class="w">
<div class="top"><div><div class="m" style="letter-spacing:.14em;text-transform:uppercase">Together, Out Loud · Technical rider</div><h1>${esc(lead.name)}</h1>
<div class="m">${esc(lead.occasion || lead.event_type || "")}${lead.date ? " · " + esc(lead.date) : ""}${venue ? " · " + esc(venue) : ""}</div></div>
<button class="btn noprint" onclick="window.print()">Print / Save as PDF</button></div>
<div class="c" style="margin-top:14px"><div class="g">
<div><span class="m">Band size</span><br><b>${m.pcs} pcs</b></div><div><span class="m">Channels</span><br><b>${m.channels}</b></div><div><span class="m">Stage needed</span><br><b>${esc(m.stage)}</b></div>
${when("Arrival / load-in", data.arrival)}${when("Soundcheck", data.soundcheck)}${when("Show time", data.showTime)}
${data.contactName || data.contactPhone ? `<div><span class="m">Our sound contact</span><br><b>${esc(data.contactName)}${data.contactPhone ? ` · <a href="tel:${esc(String(data.contactPhone).replace(/\s+/g, ""))}" style="color:inherit">${esc(data.contactPhone)}</a>` : ""}</b></div>` : ""}
</div></div>
<h2>Stage plan</h2>${stageSvg(data)}
<p class="m">Indicative layout, viewed from the audience's side — positions can be adjusted on the day with our sound team.</p>
<h2>Channel list</h2><table><thead><tr><th>CH</th><th>Instrument</th><th>Source / mic</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>
<h2>What we need from the venue</h2><div class="c"><ul style="margin:0;padding-left:20px">${reqs.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>
${data.notes && data.notes.trim() ? `<h2>Additional notes</h2><div class="c" style="white-space:pre-wrap">${esc(data.notes)}</div>` : ""}
<p class="m" style="margin-top:26px">Please share this with your sound, stage and lighting team and let us know early if anything can't be arranged — we're happy to adapt. · togetheroutloud.in</p>
</div></body></html>`;
}

module.exports = { CATALOG, PRESETS, entryFromCatalog, sanitize, summarize, autoRequirements, stageSvg, renderRiderPage };
