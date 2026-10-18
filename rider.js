// Tech rider in TOL's house format: general requirements, lighting, channel list, monitor mixes,
// contact and stage plot — all driven by the instruments chosen for the event.
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const L1 = (source, mic, mount, notes, ch) => ({ source, mic, mount: mount || "—", notes: notes || "", ch: ch == null ? 1 : ch });
const VOC = "Shure Beta 58A (wired)", SUP = "Shure SM58 (wired)", DI = "Passive/Active DI Box", SDC = "Clip-on condenser / SDC";
// row: "front" (vocals / melody) or "back" (rhythm / keys). code = badge on the stage plot.
const CATALOG = [
  { id: "vocal_lead", label: "Lead vocal", code: "VOX", row: "front", color: "#C1602B", prio: 0, power: 0, seated: 0, lines: [L1("Lead Vocal", VOC, "Tall boom stand", "Primary lead vocal")] },
  { id: "vocal_2", label: "Second vocal", code: "VOX", row: "front", color: "#C1602B", prio: 1, power: 0, seated: 0, lines: [L1("Second Vocal", VOC, "Tall boom stand", "Lead/harmony vocal")] },
  { id: "backing_vocal", label: "Backing vocal", code: "BV", row: "front", color: "#C1602B", prio: 2, power: 0, seated: 0, lines: [L1("Backing Vocal", SUP, "Tall boom stand", "Supporting vocal")] },
  { id: "harmonium", label: "Harmonium", code: "HAR", row: "front", color: "#8A5A1F", prio: 3, power: 0, seated: 1, lines: [L1("Harmonium", "Small-diaphragm condenser (or DI if fitted)", "Short boom", "")] },
  { id: "guitar_ac", label: "Acoustic guitar", code: "AGT", row: "front", color: "#1C7A80", prio: 4, power: 0, seated: 0, lines: [L1("Acoustic-Electric Guitar — DI", DI, "—", "Phantom on DI if active")] },
  { id: "flute", label: "Flute", code: "FLT", row: "front", color: "#1C7A80", prio: 5, power: 0, seated: 1, lines: [L1("Flute", "Handheld/clip condenser", "Short boom", "")] },
  { id: "violin", label: "Violin", code: "VLN", row: "front", color: "#1C7A80", prio: 6, power: 0, seated: 0, lines: [L1("Violin", "Condenser on stand (or DI if fitted)", "Short boom", "")] },
  { id: "guitar_el", label: "Electric guitar", code: "EGT", row: "front", color: "#1C7A80", prio: 7, power: 1, seated: 0, lines: [L1("Electric Guitar — amp", "Dynamic (SM57 equiv.) or DI", "Short boom", "Own amp")] },
  { id: "keys", label: "Keyboard", code: "KEY", row: "back", color: "#6B4FA0", prio: 5, power: 1, seated: 0, lines: [L1("Keyboard L/R", "DI Box x2", "—", "Stereo out from keyboard", 2)] },
  { id: "bass", label: "Bass guitar", code: "BAS", row: "back", color: "#6B4FA0", prio: 6, power: 0, seated: 0, lines: [L1("Bass Guitar — DI", DI, "—", "")] },
  { id: "dholak", label: "Dholak", code: "DHO", row: "back", color: "#B6752C", prio: 1, power: 0, seated: 1, lines: [L1("Dholak — both sides", "Clip-on condenser x2", "Small tabletop/clip stand", "", 2)] },
  { id: "tabla", label: "Tabla", code: "TAB", row: "back", color: "#B6752C", prio: 2, power: 0, seated: 1, lines: [L1("Tabla — Dayan (Right)", SDC, "Small tabletop/clip stand", ""), L1("Tabla — Bayan (Left)", SDC, "Small tabletop/clip stand", "")] },
  { id: "percussion", label: "Percussion / octapad", code: "PRC", row: "back", color: "#B6752C", prio: 3, power: 1, seated: 0, lines: [L1("Octapad / Percussion L/R", "DI Box x2", "—", "Pad outputs L / R", 2)] },
  { id: "cajon", label: "Cajon", code: "CAJ", row: "back", color: "#B6752C", prio: 4, power: 0, seated: 1, lines: [L1("Cajon", "Dynamic (SM57 equiv.)", "Short boom", "")] },
  { id: "drums", label: "Drum kit", code: "DRM", row: "back", color: "#A6432B", prio: 0, power: 0, seated: 0, lines: [
    L1("Kick In", "Dynamic (Beta 91A / D6 equiv.)", "Kick clip / short boom", ""), L1("Snare Top", "Dynamic (SM57 equiv.)", "Short boom / clip", ""),
    L1("Hi-Hat", "Small-diaphragm condenser", "Short boom", ""), L1("Overhead L", "Condenser (cardioid)", "Tall boom", "Drum kit overhead pair"),
    L1("Overhead R", "Condenser (cardioid)", "Tall boom", "Drum kit overhead pair"), L1("Drummer — Supporting Vocal", SUP, "Gooseneck / clip on kit", "Vocal while playing")] },
];
const BY_ID = Object.fromEntries(CATALOG.map((c) => [c.id, c]));
const PRESETS = {
  2: ["vocal_lead", "harmonium"],
  3: ["vocal_lead", "harmonium", "dholak"],
  4: ["vocal_lead", "vocal_2", "harmonium", "dholak"],
  5: ["vocal_lead", "vocal_2", "guitar_ac", "drums", "tabla"],
  6: ["vocal_lead", "vocal_2", "harmonium", "guitar_ac", "keys", "dholak"],
  7: ["vocal_lead", "vocal_2", "harmonium", "guitar_ac", "keys", "dholak", "percussion"],
  8: ["vocal_lead", "vocal_2", "backing_vocal", "harmonium", "guitar_ac", "keys", "dholak", "percussion"],
};
const cloneLines = (id) => (BY_ID[id] ? BY_ID[id].lines.map((l) => ({ ...l })) : []);
const entryFromCatalog = (id) => { const c = BY_ID[id]; return c ? { id, label: c.label, player: "", lines: cloneLines(id) } : null; };

const DEFAULT_LIGHTING = [
  { item: "Stage Wash", spec: "Full-stage wash lighting, warm/neutral tones suited to a devotional/satsang setting." },
  { item: "Accent & Spot Lighting", spec: "LED par cans / moving heads for vocalist and lead-instrument highlights, DMX-controlled." },
  { item: "Lyrics Screen", spec: "LED screen or projector facing the audience, displaying live lyrics as performed; plus a stage-facing confidence monitor for performers. (Core to the Bhajan Jamming format.)" },
  { item: "SFX", spec: "Haze/fog machine for atmospheric lighting depth, where permitted by the venue." },
  { item: "Lighting Control", spec: "DMX lighting console/controller, operated by venue LD or a TOL-appointed operator." },
  { item: "Power (Lighting)", spec: "Separate circuit from audio, sized for the full lighting + SFX rig." },
];
const DEFAULT_STAGE_NOTES = [
  "No alcohol, no smoking, no hookah", "Hot & cold water on stage", "Pure vegetarian meals", "Please provide safe power connections", "Keep audience quiet during performance",
  "Sound check: min. 60 minutes (uninterrupted)", "All artists to have 1 IEM + 1 stage monitor", "Stage to be clean, carpeted & free from obstructions",
];
const DEFAULT_CONTACTS = [{ role: "TOL Sound Coordinator", contact: "+91 98323 02004" }];

const num = (v, d, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const cleanLines = (arr, fallback) => (Array.isArray(arr) ? arr : fallback || []).slice(0, 12).map((l) => ({
  source: str(l && l.source, 70), mic: str(l && l.mic, 90), mount: str(l && l.mount, 60), notes: str(l && l.notes, 90), ch: num(l && l.ch, 1, 0, 12),
}));
const pairs = (arr, a, b, max) => (Array.isArray(arr) ? arr.slice(0, max).map((r) => ({ [a]: str(r && r[a], 60), [b]: str(r && r[b], 500) })).filter((r) => r[a] || r[b]) : null);

// Accepts the current shape and older saved riders (single mic/ch per instrument).
function sanitize(input) {
  const d = input || {};
  const entries = (Array.isArray(d.instruments) ? d.instruments : []).slice(0, 16).map((e) => {
    const c = BY_ID[e && e.id];
    let lines;
    if (Array.isArray(e && e.lines)) lines = cleanLines(e.lines);
    else if (c && !(e && e.mic)) lines = cloneLines(c.id);
    else lines = cleanLines([{ source: (e && e.label) || (c && c.label) || "Instrument", mic: e && e.mic, mount: "—", notes: e && e.note, ch: e && e.ch }]);
    const base = { label: str((e && e.label) || (c && c.label) || "Other instrument", 40), player: str(e && e.player, 30).trim(), lines };
    return c ? { id: c.id, ...base } : { id: "custom", ...base, row: e && e.row === "back" ? "back" : "front" };
  });
  return {
    instruments: entries,
    soundBy: d.soundBy === "tol" ? "tol" : "venue",
    monitoring: d.monitoring === "wedge" ? "wedge" : "iem",
    spare: d.spare === false ? false : true,
    stageW: str(d.stageW, 20), stageD: str(d.stageD, 20),
    arrival: str(d.arrival, 40), soundcheck: str(d.soundcheck, 40), showTime: str(d.showTime, 40),
    contacts: pairs(d.contacts, "role", "contact", 6) || DEFAULT_CONTACTS.map((x) => ({ ...x })),
    general: pairs(d.general, "cat", "req", 20), lighting: pairs(d.lighting, "item", "spec", 12),
    stageNotes: Array.isArray(d.stageNotes) ? d.stageNotes.slice(0, 14).map((x) => str(x, 140)).filter(Boolean) : null,
    notes: str(d.notes, 2000),
  };
}
const spec = (e) => { const c = BY_ID[e.id]; return c ? { row: c.row, code: c.code, color: c.color, prio: c.prio, power: c.power, seated: c.seated } : { row: e.row || "front", code: "OTH", color: "#7A6A58", prio: 20, power: 0, seated: 0 }; };
const lineCh = (e) => e.lines.reduce((t, l) => t + l.ch, 0);

// One musician can play several instruments: rows with the same "played by" name are one person (one "pc").
function musicians(data) {
  const groups = [], byName = new Map();
  data.instruments.forEach((e) => {
    const key = (e.player || "").toLowerCase();
    if (key && byName.has(key)) { byName.get(key).push(e); return; }
    const g = [e]; groups.push(g); if (key) byName.set(key, g);
  });
  return groups.map((entries) => {
    const specs = entries.map(spec);
    return {
      entries, player: entries.find((e) => e.player)?.player || "",
      row: specs.some((x) => x.row === "front") ? "front" : "back", prio: Math.min(...specs.map((x) => x.prio)),
      color: specs[0].color, code: [...new Set(specs.map((x) => x.code))].join("+"),
      power: specs.reduce((t, x) => t + x.power, 0), label: entries.map((e) => e.label).join(" + "),
      stand: entries.some((e) => e.lines.some((l) => /boom|stand|clip|gooseneck/i.test(l.mount))),
    };
  });
}

// Left-to-right, centre-out placement; front rows nearest the audience. Returns rows top → bottom plus M-numbers.
function layout(data) {
  const ms = musicians(data);
  const place = (arr) => { const out = []; arr.slice().sort((a, b) => a.prio - b.prio).forEach((x, i) => { out[i % 2 === 0 ? "push" : "unshift"](x); }); return out; };
  const chunk = (arr) => { const c = []; for (let i = 0; i < arr.length; i += 5) c.push(arr.slice(i, i + 5)); return c; };
  const frontRows = chunk(ms.filter((x) => x.row === "front").sort((a, b) => a.prio - b.prio)).map(place);
  const backRows = chunk(ms.filter((x) => x.row === "back").sort((a, b) => a.prio - b.prio)).map(place);
  const ordered = [...backRows, ...frontRows];
  let m = 1; // M1, M2 … left to right, front of stage first (matches the monitor table)
  [...ordered].reverse().forEach((r) => r.forEach((x) => { x.mix = m++; }));
  return { ordered, ms };
}

function channels(data) { // numbered rows for the channel list
  const rows = []; let c = 1;
  data.instruments.forEach((e) => e.lines.forEach((l) => {
    const a = c; c += l.ch;
    rows.push({ ...l, ch: l.ch === 0 ? "—" : l.ch === 1 ? String(a) : `${a}–${a + l.ch - 1}`, first: a, entry: e });
  }));
  if (data.spare) { rows.push({ ch: String(c), first: c, source: "Spare", mic: "—", mount: "—", notes: "Held for line fault / talkback", ch1: 1, entry: null }); c += 1; }
  return { rows, total: c - 1 };
}

function summarize(data) {
  const { ordered, ms } = layout(data);
  const frontN = ms.filter((x) => x.row === "front").length, backN = ms.filter((x) => x.row === "back").length;
  const widest = Math.max(frontN ? Math.min(5, frontN) : 0, backN ? Math.min(5, backN) : 0, 1);
  const pcs = ms.length;
  const w = pcs <= 4 ? 20 : pcs <= 6 ? 24 : 28, dep = pcs <= 4 ? 14 : pcs <= 6 ? 16 : 18;
  const ch = channels(data);
  return {
    pcs, instruments: data.instruments.length, channels: ch.total, mixes: pcs, hasDrums: data.instruments.some((e) => e.id === "drums"),
    powerPts: ms.reduce((t, x) => t + x.power, 0), seated: data.instruments.filter((e) => spec(e).seated).length, widest,
    stage: `${data.stageW || w} ft × ${data.stageD || dep} ft`, stageW: data.stageW || String(w), stageD: data.stageD || String(dep),
  };
}

const ids = (data) => new Set(data.instruments.map((e) => e.id));
const join = (a) => (a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);

// The "General Technical Requirements" table, built from the lineup. Every row can be edited in the builder.
function autoGeneral(data) {
  const m = summarize(data), have = ids(data), R = [];
  const minIn = Math.max(32, Math.ceil((m.channels + 4) / 8) * 8);
  R.push(data.soundBy === "tol"
    ? { cat: "FOH Console", req: "Together, Out Loud brings its own digital console with built-in multi-track USB/recording sound card and a sound engineer. Please provide a clear FOH position with mains power." }
    : { cat: "FOH Console", req: `Digital mixing console, minimum ${minIn} input channels, with built-in multi-track USB/recording sound card (e.g. Behringer X32/M32, Yamaha CL/QL, Allen & Heath SQ/dLive, or equivalent). Every channel is recorded for our archive.` });
  R.push(data.monitoring === "wedge"
    ? { cat: "Monitoring", req: `Stage wedge monitors — one independent mix per on-stage performer (${m.mixes} mixes), matched to band pcs.` }
    : { cat: "Monitoring", req: `Sennheiser IEM (G4 series) — one full stereo mix per on-stage performer, matched to band pcs.${m.hasDrums ? " One additional floor wedge or drum-fill/sub recommended for the drummer for low-end reference." : ""}` });
  const vocals = data.instruments.filter((e) => ["vocal_lead", "vocal_2", "backing_vocal"].includes(e.id));
  if (vocals.length) R.push({ cat: "Vocal Mics", req: "Shure Beta 58A for all lead/melodic vocals; Shure SM58 for supporting vocals. All wired unless a wireless swap is confirmed in advance." });
  const diNames = data.instruments.filter((e) => e.lines.some((l) => /\bDI\b/i.test(l.mic))).map((e) => e.label.replace(/-electric/i, "").replace(/ \/ octapad/i, ""));
  if (diNames.length) {
    const di = data.instruments.reduce((t, e) => t + e.lines.filter((l) => /\bDI\b/i.test(l.mic)).reduce((s, l) => s + Math.max(1, l.ch), 0), 0);
    R.push({ cat: "DI Boxes", req: `Passive/active DI for ${join(diNames)} (${di}x DI in total).` });
  }
  R.push({ cat: "Talkback", req: "Talkback system between FOH, the monitor engineer and the stage — every member of the band and crew must be able to hear and speak on talkback during soundcheck and the show." });
  const hw = [];
  if (vocals.length) hw.push("tall boom stands for vocals");
  if ((have.has("tabla") || have.has("dholak") || have.has("percussion") || have.has("cajon") || have.has("harmonium") || have.has("flute"))) hw.push("short boom/clip stands for " + join(["tabla", "dholak", "percussion", "cajon", "harmonium", "flute"].filter((x) => have.has(x)).map((x) => ({ tabla: "Tabla", dholak: "Dholak", percussion: "Percussion", cajon: "Cajon", harmonium: "Harmonium", flute: "Flute" }[x]))));
  const gtr = data.instruments.filter((e) => e.id === "guitar_ac" || e.id === "guitar_el").length;
  if (gtr) hw.push(`${gtr}x guitar stand${gtr > 1 ? "s" : ""}`);
  if (have.has("keys")) hw.push("1x laptop stand (for keyboard/tracks operator)");
  if (hw.length) R.push({ cat: "Stage Hardware", req: hw.map((x, i) => (i === 0 ? x[0].toUpperCase() + x.slice(1) : x)).join("; ") + "." });
  const bl = [];
  if (have.has("drums")) bl.push("1x Acoustic Drum Kit fitted with a transparent acrylic drum shield");
  if (have.has("guitar_ac")) bl.push("1x Acoustic-Electric Guitar");
  let blText = bl.length ? bl.join("; ") + "." : "";
  if (have.has("drums")) blText += " To confirm with local engineer: full hardware (throne, cymbal stands, sticks)";
  if (have.has("bass") || have.has("keys")) blText += (have.has("drums") ? " and — " : " To confirm with local engineer: ") + `if ${[have.has("bass") && "Bass", have.has("keys") && "Keyboard"].filter(Boolean).join("/")} ${have.has("bass") && have.has("keys") ? "are" : "is"} not carried by the band — local rental of ${[have.has("bass") && "Bass amp/DI", have.has("keys") && "stage piano/keyboard"].filter(Boolean).join(" and ")}`;
  if (blText && !/[.]$/.test(blText)) blText += ".";
  R.push({ cat: "Backline", req: blText.trim() || "The band carries its own instruments. All microphones, DI boxes, stands, cables and the monitor system are provided by the organiser as listed in this rider." });
  R.push({ cat: "Power (Audio)", req: "Dedicated generator or mains connection running throughout the show, clean/isolated earth, separate circuit from stage lighting." });
  R.push({ cat: "Wireless Coordination", req: "If any mic or IEM pack is swapped to wireless on-site, share a frequency list in advance to avoid RF interference with other systems in the venue." });
  R.push({ cat: "Consumables", req: "Spare XLR cables, power strips/extension boards, gaffer tape, spare batteries for wireless packs/active DIs." });
  const when = [data.arrival && `Call time / load-in: ${data.arrival}`, data.soundcheck && `Soundcheck: ${data.soundcheck}`, data.showTime && `Show time: ${data.showTime}`].filter(Boolean);
  R.push({ cat: "Load-in & Soundcheck", req: when.length ? when.join(" · ") + " (soundcheck minimum 60 minutes, uninterrupted)." : "Call time, load-in window and soundcheck duration to be confirmed with the organiser for this show." });
  return R;
}

function backlineByOrganizer(data) {
  const have = ids(data), L = [];
  if (have.has("drums")) L.push("Acoustic drum kit with cymbals", "Drum throne", "Drum shield (acrylic/transparent)");
  if (have.has("keys")) L.push("Keyboard stand (if used)");
  L.push("All microphones, DI boxes, stands, cables", data.monitoring === "wedge" ? "Monitors, power connections" : "Monitors, IEM system, power connections");
  return L;
}

function monitorRows(data) {
  const { ordered } = layout(data);
  const rows = [];
  [...ordered].reverse().forEach((r) => r.forEach((x) => {
    const drummer = x.entries.some((e) => e.id === "drums");
    rows.push({
      mix: x.mix, pos: x.player && x.entries.length > 1 ? `${x.label} (${x.player})` : x.label,
      mon: data.monitoring === "wedge" ? "Stage wedge — own mix" : "Sennheiser IEM (G4) — stereo mix",
      note: drummer && data.monitoring !== "wedge" ? "Add 1 floor wedge or drum-fill sub for low-end feel (recommended)" : "",
    });
  }));
  return rows;
}

function stageSvg(data) {
  const { ordered } = layout(data);
  const W = 680, rowH = 124, top = 70, H = top + Math.max(1, ordered.length) * rowH + 90;
  const stageX = 30, stageW = W - 60;
  const chNo = new Map(); let c = 1; data.instruments.forEach((e) => e.lines.forEach((l) => { chNo.set(l, [c, c + l.ch - 1]); c += l.ch; }));
  const chText = (entries) => {
    const parts = []; entries.forEach((e) => e.lines.forEach((l) => { if (l.ch > 0) { const [a, b] = chNo.get(l); parts.push(a === b ? `${a}` : `${a}–${b}`); } }));
    if (!parts.length) return "no channel";
    const s = parts.join(", "); return "CH " + (s.length > 18 ? parts[0] + " … " + parts[parts.length - 1] : s);
  };
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
  let nodes = "";
  ordered.forEach((r, ri) => {
    const y = top + ri * rowH + 50;
    r.forEach((x, i) => {
      const cx = stageX + (stageW * (i + 1)) / (r.length + 1);
      const multi = x.entries.length > 1, long = x.code.length > 4;
      nodes += `<g>
        <polygon points="${cx - 20},${y + 36} ${cx + 20},${y + 36} ${cx + 14},${y + 52} ${cx - 14},${y + 52}" fill="#2B2B2B" stroke="#111" stroke-width="1"/>
        <text x="${cx}" y="${y + 48}" text-anchor="middle" font-size="10" font-weight="700" fill="#fff" font-family="Arial">M${x.mix}</text>
        ${x.stand ? `<circle cx="${cx + 34}" cy="${y + 12}" r="4" fill="none" stroke="#3A2A1A" stroke-width="1.5"/><line x1="${cx + 34}" y1="${y + 16}" x2="${cx + 34}" y2="${y + 26}" stroke="#3A2A1A" stroke-width="1.5"/>` : ""}
        <circle cx="${cx}" cy="${y}" r="26" fill="${x.color}" fill-opacity="0.92" stroke="#3A2A1A" stroke-width="1.5"/>
        ${multi ? `<circle cx="${cx}" cy="${y}" r="30" fill="none" stroke="${x.color}" stroke-width="1.5" stroke-dasharray="3 3"/>` : ""}
        <text x="${cx}" y="${y + 4}" text-anchor="middle" font-size="${long ? 9.5 : 12}" font-weight="700" fill="#fff" font-family="Arial,Helvetica,sans-serif">${esc(x.code)}</text>
        ${x.power ? `<rect x="${cx - 38}" y="${y - 36}" width="16" height="16" rx="3" fill="#FFF3C4" stroke="#8A5A1F"/><text x="${cx - 30}" y="${y - 24}" text-anchor="middle" font-size="10" font-weight="700" fill="#8A5A1F" font-family="Arial">P</text>` : ""}
        <text x="${cx}" y="${y + 68}" text-anchor="middle" font-size="${multi ? 11 : 12}" font-weight="700" fill="#2A1A1A" font-family="Arial,Helvetica,sans-serif">${esc(clip(x.label, multi ? 30 : 22))}</text>
        <text x="${cx}" y="${y + 82}" text-anchor="middle" font-size="10.5" fill="#7A6A58" font-family="Arial,Helvetica,sans-serif">${esc(x.player && multi ? x.player + " · " : "")}${esc(chText(x.entries))}</text>
      </g>`;
    });
  });
  const stageBottom = top + ordered.length * rowH + 20;
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Stage plot" style="width:100%;height:auto;background:#fff;border:1px solid #E5D5D0;border-radius:6px">
    <text x="${W / 2}" y="26" text-anchor="middle" font-size="12" letter-spacing="3" fill="#8A7A66" font-family="Arial">BACK OF STAGE</text>
    <rect x="${stageX}" y="38" width="${stageW}" height="${stageBottom - 38}" rx="8" fill="#F7EFEC" stroke="#9C6B63" stroke-width="2" stroke-dasharray="6 4"/>
    ${nodes}
    <text x="${W / 2}" y="${stageBottom + 30}" text-anchor="middle" font-size="12" letter-spacing="3" fill="#8A7A66" font-family="Arial">▼  AUDIENCE  ▼</text>
  </svg>`;
}

const fmtD = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ""); if (!m) return d || ""; return `${Number(m[3])} ${["January","February","March","April","May","June","July","August","September","October","November","December"][Number(m[2]) - 1]} ${m[1]}`; };
const PINK = "#F3E4E1", MAROON = "#722F37";
function table(headers, rows) {
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function renderRiderPage({ lead, data }) {
  const m = summarize(data);
  const general = data.general && data.general.length ? data.general : autoGeneral(data);
  const lighting = data.lighting && data.lighting.length ? data.lighting : DEFAULT_LIGHTING;
  const stageNotes = data.stageNotes && data.stageNotes.length ? data.stageNotes : DEFAULT_STAGE_NOTES;
  const ch = channels(data), mons = monitorRows(data);
  const venue = [lead.venue, lead.city].filter(Boolean).join(", ");
  const chRows = ch.rows.map((r) => `<tr><td class="c">${esc(r.ch)}</td><td>${esc(r.source)}${r.entry && r.entry.player && r.entry.player.length ? ` <span class="m">(${esc(r.entry.player)})</span>` : ""}</td><td>${esc(r.mic)}</td><td>${esc(r.mount)}</td><td>${esc(r.notes)}</td></tr>`);
  const monRows = mons.map((r) => `<tr><td><b>M${r.mix}</b> — ${esc(r.pos)}</td><td>${esc(r.mon)}</td><td>${esc(r.note)}</td></tr>`);
  const contactRows = data.contacts.map((r) => `<tr><td><b>${esc(r.role)}</b></td><td>${esc(r.contact)}</td></tr>`);
  const power = [`Min. ${Math.max(3, m.powerPts + 2)} clean 230V AC outlets across the stage`, "Separate power for audio and lighting"];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Technical Rider — Together, Out Loud</title>
<style>
*{box-sizing:border-box}body{font-family:Lato,Calibri,"Helvetica Neue",Arial,sans-serif;background:#fff;color:#2A2220;margin:0;padding:18px;line-height:1.4}.w{max-width:820px;margin:0 auto}
.hd{text-align:center;border-bottom:2px solid ${MAROON};padding-bottom:12px;margin-bottom:14px}.hd .tag{color:#A8601C;font-size:12px;font-style:italic;text-align:right}
h1{font-size:30px;color:#7B1E22;margin:6px 0 2px;letter-spacing:.02em}h3.sub{margin:0;color:#B8741A;font-size:17px;letter-spacing:.03em}.fmt{font-style:italic;font-size:12.5px;margin-top:6px;color:#3a3030}
h2{font-size:19px;color:${MAROON};margin:26px 0 10px;border-bottom:2px solid ${MAROON};padding-bottom:3px}
table{width:100%;border-collapse:collapse;font-size:13.5px;border:1px solid #E5D5D0;margin-bottom:6px}th{background:${MAROON};color:#fff;text-align:left;padding:7px 10px;font-size:12.5px}
td{padding:7px 10px;vertical-align:top;border-bottom:1px solid #EBDDD9}tbody tr:nth-child(even) td{background:${PINK}}td.c{white-space:nowrap;font-weight:700}td:first-child{font-weight:600}
.m{color:#7A6A58;font-size:12.5px;font-weight:400}.btn{display:inline-block;padding:9px 16px;border-radius:999px;background:#C1602B;color:#fff;border:0;font:inherit;cursor:pointer}
.bar{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-top:10px}.card{border:1px solid #D8C4BE;border-radius:6px;padding:8px 10px;font-size:12.5px}.card b{display:block;color:${MAROON};margin-bottom:4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase}.card ul{margin:0;padding-left:16px}
.plothead{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px}.plothead b{color:${MAROON}}
@media print{body{padding:0}.noprint{display:none!important}h2{break-after:avoid}tr,svg,.cards{break-inside:avoid}.plot{break-before:page}.cards{grid-template-columns:repeat(3,1fr)}}
</style></head><body><div class="w">
<div class="bar noprint"><span class="m">${esc(lead.name || "")}${lead.date ? " · " + esc(fmtD(lead.date)) : ""}${venue ? " · " + esc(venue) : ""}</span><button class="btn" onclick="window.print()">Print / Save as PDF</button></div>
<div class="hd"><div class="tag">TOL — Technical Rider — ${m.pcs}-Piece</div><h1>TOGETHER OUT LOUD</h1><h3 class="sub">TECHNICAL RIDER — ${m.pcs}-PIECE — LIVE SOUND</h3>
<div class="fmt">Bhajan Jamming &nbsp;|&nbsp; Bhajan Clubbing &nbsp;|&nbsp; Musical Pheras &nbsp;|&nbsp; Devotional Satsang</div></div>
<p>This rider covers TOL's ${m.pcs}-Piece band configuration${lead.name ? ` for <b>${esc(lead.name)}</b>${lead.date ? `, ${esc(fmtD(lead.date))}` : ""}${venue ? `, ${esc(venue)}` : ""}` : ""}. Share this document with the sound and lighting engineer at the venue ahead of the show.</p>
<h2>General Technical Requirements</h2>
${table(["Category", "Requirement"], general.map((r) => `<tr><td>${esc(r.cat)}</td><td>${esc(r.req)}</td></tr>`))}
<h2>Lighting, LED &amp; SFX</h2>
${table(["Item", "Specification"], lighting.map((r) => `<tr><td>${esc(r.item)}</td><td>${esc(r.spec)}</td></tr>`))}
<h2>Input / Channel List — ${m.pcs}-Piece</h2>
<p><b>Total input channels: ${ch.total}</b> &nbsp;|&nbsp; <b>Monitor mixes required: ${m.mixes}</b>${m.hasDrums && data.monitoring !== "wedge" ? " (+ optional drum-fill, see notes)" : ""}</p>
${table(["Ch", "Source", "Mic / DI", "Mount / Stand", "Notes"], chRows)}
<h2>Monitor Mixes</h2>
${table(["Position", "Monitoring", "Notes"], monRows)}
${data.notes && data.notes.trim() ? `<p style="white-space:pre-wrap"><b>Note:</b> ${esc(data.notes)}</p>` : ""}
<h2>Contact</h2>
${table(["Role", "Contact"], contactRows)}
<p>Please reach out ahead of the show to confirm backline responsibilities and load-in time.</p>
<div class="plot"><h2>Stage Plot</h2>
<p class="m"><i>Reference layout for load-in and monitor placement.</i></p>
<div class="plothead"><b>${m.pcs} PCS SET — STAGE LAYOUT</b><b>STAGE SIZE: MIN. ${esc(m.stageW)} FT (W) × ${esc(m.stageD)} FT (D) OR EQUIVALENT</b></div>
${stageSvg(data)}
<div class="cards">
<div class="card"><b>Legend</b><ul><li>M# — stage monitor</li><li>Dashed ring — one musician, two instruments</li><li>P — needs a power point</li><li>Small ring — mic stand</li></ul></div>
<div class="card"><b>${data.monitoring === "wedge" ? "Monitor mixes" : "IEM mixes"}</b><ul>${mons.map((r) => `<li>M${r.mix} — ${esc(r.pos)}</li>`).join("")}</ul></div>
<div class="card"><b>Instruments / backline by organiser</b><ul>${backlineByOrganizer(data).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
<div class="card"><b>Power distribution</b><ul>${power.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
<div class="card"><b>Stage notes</b><ul>${stageNotes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
</div></div>
<p class="m" style="text-align:center;margin-top:24px">Together Out Loud • togetheroutloud.in</p>
</div></body></html>`;
}

module.exports = { CATALOG, PRESETS, DEFAULT_LIGHTING, DEFAULT_STAGE_NOTES, DEFAULT_CONTACTS, entryFromCatalog, sanitize, summarize, autoGeneral, stageSvg, renderRiderPage };
