# Sprog Log

A single-child tracker for weight, milestones and sleep. Weight measurements are plotted against WHO growth centiles with a simple linear-regression trendline projection.

## Prerequisites

- Node.js 18+
- A Postgres database

## Environment variables

Copy `.env.example` to `.env` and fill in the values below. The server reads environment variables; it does not load `.env` automatically.

| Variable       | Required | Default | Notes                        |
| -------------- | -------- | ------- | ----------------------------- |
| `DATABASE_URL` | Yes      | -       | Postgres connection string    |
| `PORT`         | No       | `3000`  | Port the server listens on    |
| `APP_PIN`      | No       | -       | Optional PIN override; see [PIN access](#pin-access) |

Note: `server.js` connects to Postgres with `ssl: { rejectUnauthorized: false }`. This works with most managed Postgres providers; if your database doesn't support SSL (e.g. a bare local install), you'll need to adjust that option in `server.js`.

## Setup

```bash
npm install
cp .env.example .env   # then edit .env
set -a
. ./.env               # export the values for this shell
set +a
npm start
```

Open `http://localhost:3000` (or the configured port). On boot, the server creates its tables and applies non-destructive schema additions if needed (`initDb()` in `server.js`), so a fresh database works out of the box. After setting up or entering the PIN, enter the child's name, birth date, and sex in the onboarding form; the profile is stored in Postgres. In a hosted environment, configure environment variables through the hosting provider instead of sourcing `.env`.

## PIN access

The app is protected by a shared PIN gate (no user accounts). The application shell is public, but all `/api/*` data endpoints require an unlocked session.

- **First run / upgrading:** if no PIN is configured yet (fresh install or an existing deployment that upgraded to this version), the app starts in *setup mode* and the first visitor is prompted to create a PIN. The PIN is stored in Postgres as an `scrypt` hash. All data endpoints stay locked until a PIN exists.
- **Unlocking:** entering the correct PIN sets a signed `httpOnly` cookie that keeps that device unlocked for 30 days.
- **Recovery (`APP_PIN`):** if the in-app PIN is forgotten, set the `APP_PIN` environment variable and restart. While set, `APP_PIN` takes precedence over the stored PIN and lets you back in. Setting or changing the effective PIN invalidates all existing sessions.
- **Brute-force protection:** failed unlock attempts are rate-limited per IP; 5 consecutive failures lock the IP out for 15 minutes.

Note: this is a single shared PIN, so anyone who knows it has full access. It is intended to keep the deployment private from strangers and bots, not to provide per-user security.

## Sleep tracking

Select **Sleep** in the navigation to start and stop a shared timer or add, edit and delete completed sleep periods. The **Tracking** view retains the Weight and Milestones tabs. Only one timer can run at a time, and sleep periods cannot overlap. The active timer is stored on the server, so it survives reloads and can be stopped on another unlocked device. Devices refresh periodically and when the view regains focus; a network error can delay synchronization.

The timeline shows the newest days first and splits sleeps at the configured day start (07:00 by default). The setting is shared, but boundaries are interpreted in each viewing device's local time zone, so devices in different time zones can show different day groupings. Local daylight-saving transitions can make a displayed day shorter or longer than 24 elapsed hours.

## Backup and restore

Open Settings with the gear button. Settings can export individual sections or all data as JSON: profile, weight, milestones, completed sleeps and the shared sleep-day setting. Active timers, PINs, session credentials and the device's theme are not exported. Keep backups private: they contain the child's information.

Import validates the file and asks for confirmation before **replacing** the sections present in it, rather than adding to existing records; omitted sections remain unchanged. Sleep history cannot be imported while a timer is active. Older `{profile, entries}` and `{birthDate, entries}` weight backups are accepted; an incomplete legacy profile does not replace the existing profile. Imports are applied atomically.

## Tests

Run `npm test` for the focused backup, sleep validation and timeline tests. PostgreSQL integration and browser checks require a running database and a browser.

## Known limitations

- **Girls-only reference data.** The WHO/UK-WHO growth centiles bundled in the app are for girls. If a boy's profile is selected, the app shows an inline warning that the plotted centiles are not accurate for boys. Adding a boys dataset is a known follow-up (see the LMS parameters note in the source comments).
- **0–12 month range only.** Both the percentile band data and the LMS centile table stop at 12 months; measurements logged beyond that age will clamp to the 12-month reference row and show a misleading centile.
- **Shared PIN, not accounts.** Access is gated by a single shared PIN (see [PIN access](#pin-access)); there are no per-user accounts, roles, or audit trails, and anyone with the PIN has full read/write access.
- **Single child only.** The profile table is a pinned singleton row; multi-child support is not implemented.
