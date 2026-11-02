// Published Hindu vivah muhurat dates (North India / New Delhi panchang), compiled Nov 2026.
// Sources: Drik Panchang figures as republished by hindutone.com (Nov 2026 – Mar 2027, cross-checked with SmartPuja)
// and GaneshaSpeaks (Jan – Dec 2027, with nakshatra and muhurat windows).
// Muhurat dates differ between panchangs, regions and pandits — treat as a planning guide and confirm per client.
// These are only the starting data: admins can add, edit and remove dates in the CRM (Wedding Dates).

const DRIK = "Drik Panchang (New Delhi), via hindutone.com";
const GANESHA = "GaneshaSpeaks";

// "YYYY-MM-DD|nakshatra|window" — repeated dates are merged. A window ending after midnight shows (+1d).
const GANESHA_ROWS = `
2027-01-15|Revati|07:25 AM–02:10 PM
2027-01-18|Rohini, Krittika|09:07 PM–09:09 PM
2027-01-19|Rohini, Mrigashira|07:51 AM–07:20 AM (+1d)
2027-01-20|Mrigashira|07:25 AM–04:14 PM
2027-01-26|Uttara Phalguni, Hasta|08:20 PM–07:18 AM (+1d)
2027-01-27|Hasta|07:23 AM–11:53 PM
2027-01-30|Anuradha|03:57 AM–07:17 AM (+1d)
2027-01-31|Anuradha|07:22 AM–07:31 PM
2027-02-02|Mula|05:49 PM–07:16 AM (+1d)
2027-02-03|Mula|07:21 AM–12:23 PM
2027-02-09|Uttara Bhadrapada|03:42 AM–07:12 AM (+1d)
2027-02-10|Uttara Bhadrapada|07:17 AM–02:42 PM
2027-02-10|Uttara Bhadrapada, Revati|03:06 AM–07:12 AM (+1d)
2027-02-11|Revati|07:17 AM–11:27 PM
2027-02-14|Rohini|04:48 AM–07:09 AM (+1d)
2027-02-15|Rohini|07:14 AM–12:30 PM
2027-02-21|Magha|11:29 AM–01:47 PM
2027-02-22|Uttara Phalguni|11:56 AM–07:03 AM (+1d)
2027-02-25|Swati|09:34 AM–07:01 AM (+1d)
2027-02-26|Swati|07:06 AM–10:10 AM
2027-02-27|Anuradha|10:10 PM–06:59 AM (+1d)
2027-02-28|Anuradha|07:04 AM–01:44 PM
2027-03-01|Mula|11:14 PM–06:58 AM (+1d)
2027-03-02|Mula|07:03 AM–03:21 PM
2027-03-03|Uttara Ashadha|01:08 AM–06:56 AM (+1d)
2027-03-04|Uttara Ashadha|07:01 AM–01:32 AM (+1d)
2027-03-09|Uttara Bhadrapada|10:00 AM–06:51 AM (+1d)
2027-03-10|Uttara Bhadrapada, Revati|06:56 AM–05:10 AM (+1d)
2027-03-14|Rohini|05:12 PM–06:46 AM (+1d)
2027-04-18|Uttara Phalguni|06:19 AM–09:55 PM
2027-04-19|Hasta|07:46 PM–04:37 AM (+1d)
2027-04-21|Swati|04:12 PM–04:40 AM (+1d)
2027-04-23|Anuradha|02:15 PM–03:50 PM
2027-04-23|Anuradha|04:22 AM–06:09 AM (+1d)
2027-04-24|Jyeshtha, Anuradha|06:14 AM–06:53 AM
2027-04-25|Mula|03:37 PM–06:08 AM (+1d)
2027-04-26|Mula|06:13 AM–11:26 AM
2027-04-27|Uttara Ashadha|11:15 PM–06:06 AM (+1d)
2027-04-28|Uttara Ashadha|06:11 AM–05:27 PM
2027-05-04|Revati|04:16 PM–07:27 PM
2027-05-07|Rohini|11:44 PM–06:00 AM (+1d)
2027-05-08|Mrigashira|02:39 AM–05:59 AM (+1d)
2027-05-09|Mrigashira|06:04 AM–07:39 PM
2027-05-13|Magha|07:28 PM–05:56 AM (+1d)
2027-05-14|Magha|06:01 AM–08:47 AM
2027-05-15|Uttara Phalguni|12:02 PM–05:55 AM (+1d)
2027-05-16|Hasta|02:45 AM–05:55 AM (+1d)
2027-05-17|Hasta|06:00 AM–11:26 AM
2027-05-18|Swati|11:57 PM–05:54 AM (+1d)
2027-05-19|Swati|05:59 AM–12:16 PM
2027-05-20|Anuradha|10:28 PM–05:54 AM (+1d)
2027-05-21|Anuradha|05:59 AM–02:48 PM
2027-05-22|Mula|11:29 PM–05:53 AM (+1d)
2027-05-23|Mula|05:58 AM–07:38 AM
2027-05-24|Uttara Ashadha|10:09 PM–05:52 AM (+1d)
2027-05-25|Uttara Ashadha|05:57 AM–01:09 AM (+1d)
2027-05-30|Uttara Bhadrapada|11:34 AM–09:51 PM
2027-05-31|Uttara Bhadrapada, Revati|10:04 AM–05:51 AM (+1d)
2027-06-01|Revati|05:56 AM–06:43 AM
2027-06-05|Mrigashira|11:37 AM–12:07 PM
2027-06-09|Magha|01:28 AM–05:51 AM (+1d)
2027-06-10|Magha|05:56 AM–03:21 PM
2027-06-11|Uttara Phalguni|05:29 PM–05:51 AM (+1d)
2027-06-12|Uttara Phalguni|05:56 AM–10:45 AM
2027-06-13|Hasta|09:07 AM–04:56 PM
2027-06-15|Swati|06:48 AM–06:20 PM
2027-06-16|Anuradha|07:46 PM–05:51 AM (+1d)
2027-06-17|Anuradha|05:56 AM–09:27 PM
2027-06-19|Mula|06:20 AM–02:09 AM (+1d)
2027-06-20|Uttara Ashadha, Purva Ashadha|05:05 AM–05:52 AM (+1d)
2027-06-21|Uttara Ashadha|05:57 AM–11:47 PM
2027-06-26|Uttara Bhadrapada|07:24 PM–05:53 AM (+1d)
2027-06-27|Uttara Bhadrapada, Revati|05:58 AM–05:54 AM (+1d)
2027-06-28|Revati|05:59 AM–11:42 AM
2027-07-07|Magha|06:45 PM–11:55 PM
2027-07-08|Uttara Phalguni|12:20 AM–05:58 AM (+1d)
2027-07-09|Uttara Phalguni|06:03 AM–06:13 PM
2027-07-11|Swati|11:07 PM–05:59 AM (+1d)
2027-07-12|Swati|06:04 AM–11:53 PM
2027-11-10|Uttara Bhadrapada|09:13 AM–11:37 PM
2027-11-11|Revati|10:59 PM–01:39 AM (+1d)
2027-11-15|Rohini|03:23 PM–05:57 AM (+1d)
2027-11-16|Mrigashira|06:55 AM–04:39 PM
2027-11-16|Mrigashira|03:43 AM–04:39 AM (+1d)
2027-11-20|Magha|04:50 AM–06:54 AM (+1d)
2027-11-21|Magha|06:59 AM–07:22 PM
2027-11-23|Uttara Phalguni, Hasta|02:10 PM–06:56 AM (+1d)
2027-11-24|Hasta|07:01 AM–06:50 PM
2027-11-25|Swati|06:19 PM–06:57 AM (+1d)
2027-11-26|Swati|07:02 AM–09:44 AM
2027-11-29|Moola|02:14 AM–02:27 AM (+1d)
2027-12-02|Uttara Ashadha|01:45 PM–02:26 AM (+1d)
2027-12-07|Uttara Bhadrapada|02:16 PM–06:54 AM (+1d)
2027-12-08|Revati|06:37 AM–07:06 AM (+1d)
2027-12-09|Revati|07:11 AM–11:05 AM
2027-12-12|Rohini|04:43 PM–11:51 PM
2027-12-13|Rohini, Mrigashira|10:51 AM–07:09 AM (+1d)
2027-12-14|Mrigashira|07:14 AM–01:21 PM
`;

const byDate = new Map();
for (const line of GANESHA_ROWS.trim().split("\n")) {
  const [date, nak, win] = line.split("|");
  const e = byDate.get(date) || { naks: [], wins: [] };
  if (!e.naks.includes(nak)) e.naks.push(nak);
  e.wins.push(win);
  byDate.set(date, e);
}

const seed = [];
// Drik Panchang list for the first stretch (no windows published in the source).
const drikOnly = {
  "2026-11-21": "First muhurat after Dev Uthani Ekadashi (20 Nov) — weddings resume",
  "2026-11-24": "", "2026-11-25": "", "2026-11-26": "",
  "2026-12-02": "", "2026-12-03": "", "2026-12-04": "", "2026-12-05": "", "2026-12-06": "", "2026-12-11": "", "2026-12-12": "Last muhurat before Kharmas (16 Dec)",
};
for (const [date, note] of Object.entries(drikOnly)) seed.push({ date, note, source: DRIK });
seed.push({ date: "2027-01-24", note: "Listed by Drik Panchang only (not by GaneshaSpeaks) — confirm with your pandit", source: DRIK });
for (const [date, e] of byDate) {
  seed.push({ date, note: `${e.naks.join(" / ")} · ${e.wins.join(" ; ")}`, source: GANESHA });
}
seed.sort((a, b) => a.date.localeCompare(b.date));

// Periods when weddings are not held (shown shaded). Edges are approximate where marked.
const blocks = [
  { from: "2026-11-01", to: "2026-11-19", label: "Chaturmas — no weddings until Dev Uthani Ekadashi (20 Nov)" },
  { from: "2026-12-13", to: "2026-12-15", label: "No suitable nakshatra" },
  { from: "2026-12-16", to: "2027-01-14", label: "Kharmas (Sun in Dhanu) — no weddings" },
  { from: "2027-03-15", to: "2027-04-14", label: "Meena Kharmas (approx.) — no weddings" },
  { from: "2027-07-13", to: "2027-11-09", label: "Chaturmas / Shukra asta (approx.) — no muhurat published" },
];

module.exports = { PANCHANG_SEED: seed, PANCHANG_BLOCKS: blocks, PANCHANG_DATA_RANGE: { from: "2026-11-01", to: "2027-12-14" } };
