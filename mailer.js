const nodemailer = require("nodemailer");

// Every email function here checks for SMTP_HOST/SMTP_USER/SMTP_PASS in .env.
// Without them, functions just report back that no email was sent — the caller
// still gets the subject/body to show or copy manually, and nothing crashes.

function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function send({ to, subject, text }) {
  const transporter = getTransporter();
  if (!transporter) {
    return { sent: false, reason: "SMTP not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS in .env to send for real" };
  }
  try {
    await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// Quotation email — sent from the Quotation tab when staff mark a lead as quoted.
async function sendQuoteEmail({ to, subject, body }) {
  return send({ to, subject, text: body });
}

// Auto-reply sent to the person who just filled in the public enquiry form.
async function sendLeadConfirmationEmail(lead) {
  if (!lead.email) return { sent: false, reason: "Lead did not provide an email address" };
  const firstName = (lead.name || "").split(" ")[0] || "there";
  const text = [
    `Dear ${firstName},`,
    ``,
    `Thank you for reaching out to Together, Out Loud. We've received your enquiry for your event on ${lead.date}${lead.city ? ` in ${lead.city}` : ""}.`,
    ``,
    `Our team will get in touch with you within 24 hours to discuss your event and help create a memorable musical experience.`,
    ``,
    `Warmly,`,
    `Together, Out Loud`,
  ].join("\n");
  return send({ to: lead.email, subject: "We've received your enquiry — Together, Out Loud", text });
}

// Internal notification sent to the team's inbox whenever a new enquiry comes in.
// Set TEAM_NOTIFY_EMAIL in .env to the address that should receive these
// (falls back to SMTP_FROM/SMTP_USER if not set).
async function sendTeamNotificationEmail(lead) {
  const notifyTo = process.env.TEAM_NOTIFY_EMAIL || process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!notifyTo) return { sent: false, reason: "No TEAM_NOTIFY_EMAIL (or SMTP_FROM) configured to notify" };
  const text = [
    `New enquiry received:`,
    ``,
    `Name: ${lead.name}`,
    `Phone: ${lead.phone || "—"}`,
    `Email: ${lead.email || "—"}`,
    `City: ${lead.city || "—"}`,
    `Event date: ${lead.date}`,
    `Experience: ${lead.event_type}`,
    lead.occasion ? `Occasion: ${lead.occasion}` : null,
    lead.guest_range ? `Guests: ${lead.guest_range}` : null,
    lead.how_heard ? `Heard about us via: ${lead.how_heard}` : null,
    lead.details ? `\nDetails:\n${lead.details}` : null,
  ].filter(Boolean).join("\n");
  return send({ to: notifyTo, subject: `New enquiry: ${lead.name}`, text });
}

module.exports = { sendQuoteEmail, sendLeadConfirmationEmail, sendTeamNotificationEmail };
