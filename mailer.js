// Sends email via the Resend API (HTTPS) instead of raw SMTP sockets.
// Railway (like many hosts) blocks outbound SMTP ports as an anti-spam measure,
// which is why the old nodemailer/SMTP setup timed out. Resend works over
// normal HTTPS, so it isn't affected by that.
//
// Setup: create a free account at resend.com, generate an API key, and set
// RESEND_API_KEY in Railway's Variables tab. Until you verify your own domain
// on Resend, you can only send FROM their shared "onboarding@resend.dev" address
// and only TO the email you signed up with — fine for testing, expand later
// by verifying a domain in the Resend dashboard.

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Together, Out Loud <onboarding@resend.dev>";

async function send({ to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { sent: false, reason: "RESEND_API_KEY not configured — set it in Railway to send for real" };
  }
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || DEFAULT_FROM,
        to,
        subject,
        text,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { sent: false, reason: data.message || `Resend API error (${res.status})` };
    }
    return { sent: true, id: data.id };
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
// (falls back to RESEND_FROM/a fixed address if not set).
async function sendTeamNotificationEmail(lead) {
  const notifyTo = process.env.TEAM_NOTIFY_EMAIL;
  if (!notifyTo) return { sent: false, reason: "No TEAM_NOTIFY_EMAIL configured to notify" };
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
