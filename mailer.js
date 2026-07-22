const nodemailer = require("nodemailer");

// Sends the quotation email if SMTP_HOST/SMTP_USER/SMTP_PASS are set in .env.
// Without them, this just reports back that no email was sent — the caller
// still gets the subject/body to show or copy manually.
async function sendQuoteEmail({ to, subject, body }) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return { sent: false, reason: "SMTP not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS in .env to send for real" };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    await transporter.sendMail({
      from: SMTP_FROM || SMTP_USER,
      to,
      subject,
      text: body,
    });

    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendQuoteEmail };
