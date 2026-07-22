// Shared business config — edit these to change pricing, stages, formats, or team.

const STAGES = ["New", "Quoted", "Follow-up", "Confirmed", "Completed", "Cancelled"];

const PACKAGES = [
  { id: "jam", name: "Bhajan Jamming", rate: 60000 },
  { id: "club", name: "Bhajan Clubbing", rate: 120000 },
  { id: "pheras", name: "Musical Pheras", rate: 100000 },
  { id: "bollywood", name: "Bollywood Jamming", rate: 80000 },
  { id: "satsang", name: "Devotional Satsang", rate: 55000 },
  { id: "shraddhanjali", name: "Shraddhanjali Satsang", rate: 50000 },
];

const ADDONS = [
  { id: "sound", name: "Sound & PA", rate: 15000 },
  { id: "lights", name: "Lighting", rate: 12000 },
  { id: "stage", name: "Stage setup", rate: 18000 },
  { id: "travel", name: "Travel & accommodation", rate: null, note: "billed at actuals" },
];

const TEAM = [
  { id: "t1", name: "Ashwin", role: "Lead & Performer" },
  { id: "t2", name: "Divya", role: "Client Relations" },
  { id: "t3", name: "Karan", role: "Logistics & Sound" },
  { id: "t4", name: "Neha", role: "Accounts" },
];

// Options specific to the public enquiry form.
const EXPERIENCES = [
  { id: "pheras", name: "Musical Pheras" },
  { id: "jam", name: "Bhajan Jamming" },
  { id: "both", name: "Both" },
  { id: "satsang", name: "Devotional Satsang" },
  { id: "shraddhanjali", name: "Shraddhanjali Satsang" },
];

const OCCASIONS = [
  "Wedding", "Engagement", "Sangeet", "Reception", "Housewarming", "Birthday",
  "Corporate Event", "Spiritual Gathering / Satsang", "Temple Event", "Private Celebration", "Other",
];

const GUEST_RANGES = ["Under 200", "200–500", "500–1000", "1000+"];

const HOW_HEARD = [
  "Instagram", "Facebook", "YouTube", "Google", "Linktree", "Friend/Family", "Previous Event", "Wedding Planner", "Other",
];

module.exports = { STAGES, PACKAGES, ADDONS, TEAM, EXPERIENCES, OCCASIONS, GUEST_RANGES, HOW_HEARD };
