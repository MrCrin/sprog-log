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

Note: `server.js` connects to Postgres with `ssl: { rejectUnauthorized: false }`. This works with most managed Postgres providers; if your database doesn't support SSL (e.g. a bare local install), you'll need to adjust that option in `server.js`.

## Setup

```bash
npm install
cp .env.example .env   # then edit .env
npm start
```

On boot, the server creates the `measurements` and `profile` tables if they don't already exist (`initDb()` in `server.js`), so a fresh database works out of the box. On first load the app shows an onboarding modal asking for the child's name, birth date, and sex; this is stored as a single profile row in Postgres.

## Known limitations

- **Girls-only reference data.** The WHO/UK-WHO growth centiles bundled in the app are for girls. If a boy's profile is selected, the app shows an inline warning that the plotted centiles are not accurate for boys. Adding a boys dataset is a known follow-up (see the LMS parameters note in the source comments).
- **0–12 month range only.** Both the percentile band data and the LMS centile table stop at 12 months; measurements logged beyond that age will clamp to the 12-month reference row and show a misleading centile.
- **No authentication.** Anyone with the deployed URL can read, add, edit, or delete data. Do not use this for anything you wouldn't want publicly accessible.
- **Single child only.** The profile table is a pinned singleton row; multi-child support is not implemented.
