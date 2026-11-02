# Together, Out Loud (TOL) — CRM + website

Node/Express + PostgreSQL app with a vanilla-JS single-page CRM and the public marketing site.
Live at https://www.togetheroutloud.in · repo `AshwinAg92/tol-workflow` (branch `main`).
(README.md still describes an old SQLite version — this file is the current reference.)

## Layout
- `server.js` (~6k lines) — all API routes, auth, scheduled jobs (reminders, backups). `db.js` — schema + migrations. `config.js`, `rider.js`, `backup-core.js`, `scripts/restore-backup.js`.
- `public/app.js` (~13.6k lines) — the whole CRM SPA (module-level state, string-template rendering). `public/index.html` (CRM shell; `/login` serves it), `public/home.html` (marketing site), `lead-form.html` (public enquiry form), `me.html` (artist portal), `styles.css`.

## Run locally
- Needs PostgreSQL. `DATABASE_URL=postgres://user:pass@localhost:5432/db PORT=3111 ADMIN_USERNAME=admin ADMIN_PASSWORD=... node server.js` (first boot creates tables and the admin login). Use a throwaway database for testing, never production data.
- Optional env: `SESSION_SECRET`, `WINDSOR_API_KEY` (Instagram stats/reels), `GOOGLE_CLIENT_ID/SECRET` (Calendar + Analytics), `VAPID_*` (push), `SMTP_*` or `RESEND_*` (email), `BACKUP_*`, `REMINDER_FROM_HOUR`.
- Check syntax before committing: `node --check server.js && node --check public/app.js`.
- Browser tests: Playwright (`require('playwright')`). Log in by POSTing `/api/auth/login`, then load `/login`. Block external hosts (fonts/CDNs) with `page.route` or pages load slowly.

## Deploy
- Railway auto-deploys on push to `main`. After pushing, confirm the deployment reaches SUCCESS and the log shows "TOL workflow app running".
- Never use Railway "redeploy" to ship updates (it rebuilds the old commit) — push a new commit instead. If a build fails at the image-build step with no code error, it is a Railway platform issue; retry with an empty commit.
- Production DB is Railway PostgreSQL. Keep its public TCP proxy closed. Never commit secrets or tokens.

## Rules that have bitten before
- **Migrations:** `CREATE TABLE IF NOT EXISTS` never adds columns to an existing table. Every new column needs `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in db.js (runs every boot).
- **Test before claiming done:** run the change against a local throwaway DB in a real browser and report what was tested and what still needs checking on the live site.
- Keep existing data intact; take a backup before major data changes.

## Product rules (final unless Ashwin says otherwise)
- Prakriti Modi's name always comes before Ashwin's.
- Managers never see any commercials (fees, rates, quotes, payments, invoices) or artist fees. Team tab and Musicians pool are admin-only.
- Musicians/freelancers see only an event's location (venue/city), never the client's name — in links, screens, notifications, messages.
- Client-facing ledger: simple — total and total due only; do not expose fee-vs-reimbursement allocation.
- Event-specific admin actions (e.g. approving reimbursements) live in that event's Team & Expenses modal, not Accounts.
- A nav link is added whenever a new website section is added. Gallery captions show only what the admin wrote. India map uses real geocoding only.
- Lead form: email optional, WhatsApp separate from phone, confirmed dates blocked with a graceful alternative.

## Domain notes
- Leads: `first_name` (may be several words; used in greetings via `leadFirstName()`), `last_name`, `name` = full display name. Old leads may have only `name`.
- Combo events share `combo_group_id` (one travel plan, anchored on the earliest-date lead). Travel Desk groups them into one row.
- Travel Desk "next action" order: add travel → book → attach tickets → done. "No travel needed" is stored on `leads.no_travel`.
- Confirmation message template uses `{clientArrangements}` so it only asks the client to arrange what the fee doesn't include.
- Website contact numbers are editable in CRM → Website → Contact numbers (stored in `site_content`); the website's WhatsApp buttons use them.
- Reels on the website come from Windsor.ai (cached 6 h). Instagram reports reels as `VIDEO` with a `/reel/` link.
- Wedding Dates (nav: panchang): Hindu vivah muhurat calendar. Seed data + no-wedding periods live in `panchang-data.js` (loaded once into table `panchang_dates`, then admin-editable in the CRM). Covers Nov 2026 – 14 Dec 2027; extend by adding rows in the CRM or updating the seed for new years (sources noted in the file).
