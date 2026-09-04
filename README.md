# Sprog Log

A baby weight tracker that plots logged measurements against WHO growth centiles, with a simple linear-regression trendline projection.

## Prerequisites

- Node.js 18+
- A Postgres database

## Environment variables

Copy `.env.example` to `.env` and fill in:

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
npm start
```

On boot, the server creates the `measurements` and `profile` tables if they don't already exist (`initDb()` in `server.js`), so a fresh database works out of the box. On first load the app shows an onboarding modal asking for the child's name, birth date, and sex; this is stored as a single profile row in Postgres.

## PIN access

The app is protected by a shared PIN gate (no user accounts). The frontend and all `/api/*` data endpoints require an unlocked session.

- **First run / upgrading:** if no PIN is configured yet (fresh install or an existing deployment that upgraded to this version), the app starts in *setup mode* and the first visitor is prompted to create a PIN. The PIN is stored in Postgres as an `scrypt` hash. All data endpoints stay locked until a PIN exists.
- **Unlocking:** entering the correct PIN sets a signed `httpOnly` cookie that keeps that device unlocked for 30 days.
- **Recovery (`APP_PIN`):** if the in-app PIN is forgotten, set the `APP_PIN` environment variable and restart. While set, `APP_PIN` takes precedence over the stored PIN and lets you back in. Setting or changing the effective PIN invalidates all existing sessions.
- **Brute-force protection:** failed unlock attempts are rate-limited per IP; 5 consecutive failures lock the IP out for 15 minutes.

Note: this is a single shared PIN, so anyone who knows it has full access. It is intended to keep the deployment private from strangers and bots, not to provide per-user security.

## Known limitations

- **Girls-only reference data.** The WHO/UK-WHO growth centiles bundled in the app are for girls. If a boy's profile is selected, the app shows an inline warning that the plotted centiles are not accurate for boys. Adding a boys dataset is a known follow-up (see the LMS parameters note in the source comments).
- **0–12 month range only.** Both the percentile band data and the LMS centile table stop at 12 months; measurements logged beyond that age will clamp to the 12-month reference row and show a misleading centile.
- **Shared PIN, not accounts.** Access is gated by a single shared PIN (see [PIN access](#pin-access)); there are no per-user accounts, roles, or audit trails, and anyone with the PIN has full read/write access.
- **Single child only.** The profile table is a pinned singleton row; multi-child support is not implemented.
