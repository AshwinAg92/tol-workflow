# Together Out Loud — Workflow App

A real, working backend + dashboard for the TOL lead-to-booking process: dashboard overview,
lead capture, quotation, status pipeline, task management, document storage, team assignment,
calendar, and accounts — backed by an actual SQLite database (not mock data).

## New to this? Start here

This is a real app, not just pictures of one — so it needs to actually run on a computer
to work. Here's the least technical way to get it going:

1. Install **Node.js** from [nodejs.org](https://nodejs.org) (pick the "LTS" version, click
   through the installer like any other program).
2. Unzip this folder somewhere on your computer.
3. Open the **Terminal** app (Mac) or **Command Prompt** (Windows).
4. Type `cd ` followed by a space, then drag the unzipped folder into the terminal window,
   and press Enter. This tells the terminal "work inside this folder."
5. Type `npm install` and press Enter. Wait for it to finish (this downloads the pieces the
   app needs — only needed once).
6. Type `npm start` and press Enter. You'll see a line saying the app is running.
7. Open your browser and go to **http://localhost:3300**.

That's it — you're looking at your real dashboard. Leave the terminal window open while
you use it; closing it turns the app off. When we're ready to make it available online for
your whole team (not just your computer), I'll walk you through that too.

## Run it locally

```bash
npm install
npm start
```

Then open **http://localhost:3300** in your browser. The dashboard is the main app; the
public lead-capture form (the link you share with a new query) lives at
**http://localhost:3300/lead-form.html**.

The database file `tol.db` is created automatically on first run, seeded with a few sample
leads so the dashboard isn't empty. Every submission through the public form, or anything
you add/change in the dashboard, is saved for real and will still be there the next time
you start the server.

## Sending real quotation emails

By default, quotes are computed and shown as a preview, but **not actually emailed** —
you'll see "Not emailed — SMTP not configured" in the quotation screen. To send for real:

1. Copy `.env.example` to `.env`
2. Fill in your email provider's SMTP details (Gmail, Zoho Mail, or any provider that
   gives you an SMTP host/port/username/password — for Gmail, use an
   [App Password](https://support.google.com/accounts/answer/185833), not your normal login)
3. Restart the server

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=you@gmail.com
```

## Editing pricing, formats, stages, or the team

All of this lives in `config.js` — one file, no code changes needed elsewhere:
- `PACKAGES` — your experience formats and base rates (Bhajan Jamming, Bhajan Clubbing,
  Musical Pheras, Bollywood Jamming, Devotional Satsang, Shraddhanjali Satsang)
- `ADDONS` — sound, lighting, stage, travel
- `STAGES` — the pipeline stages a lead moves through
- `TEAM` — who can be assigned to a lead

## Putting this online for your team

Right now this only runs on your own machine. To give your team access from anywhere:

1. Push this folder to a GitHub repo
2. Deploy it on a service like **Render** or **Railway** (both have free tiers) — point it
   at `npm start`, and it'll give you a public URL
3. Share that URL with your team, and use `<that-url>/lead-form.html` as your lead-capture link

Note: this uses a file-based SQLite database, which works well for one server instance.
If you outgrow that later, migrating to a hosted database (like a small Postgres instance)
is a straightforward next step.

## What's not included yet

- Team member logins (right now, anyone with the dashboard URL can act as any team member —
  there's no password-protected access per person yet)
- Automatic reminders for follow-ups or overdue tasks
- PDF quotations (currently email/text only, matching your WhatsApp-first quoting style)
- The public-facing marketing website (planned as its own later phase)

Happy to build any of these next — just ask.
