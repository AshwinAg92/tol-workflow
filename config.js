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

module.exports = { STAGES, PACKAGES, ADDONS, TEAM };
