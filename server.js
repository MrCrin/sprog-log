const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
// Backups can contain years of history; keep the ordinary API's smaller limit.
app.use('/api/backup', express.json({ limit: '10mb' }));
app.use(express.json());

// Respect the platform proxy's X-Forwarded-* headers so req.ip is the real
// client IP (used for the unlock lockout) and req.secure reflects the
// original request scheme. Note: X-Forwarded-For is spoofable, which lets a
// determined attacker rotate lockout buckets - an acceptable tradeoff vs.
// every user sharing one proxy-IP bucket (which one bot could lock out).
app.set('trust proxy', 1);

// Secure connection to your Postgres database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ==========================================
// 1. SERVE THE FRONTEND UI
// ==========================================
// This automatically serves the index.html file from your new 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 2. DATABASE SCHEMA BOOTSTRAP
// ==========================================
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS measurements (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      weight INTEGER NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY DEFAULT 1,
      name TEXT NOT NULL,
      birth_date DATE NOT NULL,
      sex TEXT NOT NULL,
      CONSTRAINT profile_singleton CHECK (id = 1)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS milestones (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      description TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sleep_entries (
      id SERIAL PRIMARY KEY,
      start_time TIMESTAMPTZ NOT NULL,
      end_time TIMESTAMPTZ,
      CHECK (end_time IS NULL OR end_time > start_time)
    )
  `);
  // The inline check is created with the column, and ADD COLUMN is idempotent.
  await pool.query("ALTER TABLE sleep_entries ADD COLUMN IF NOT EXISTS classification_override TEXT CHECK (classification_override IS NULL OR classification_override IN ('nap', 'overnight'))");
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS sleep_one_active ON sleep_entries ((1)) WHERE end_time IS NULL');
  await pool.query('CREATE INDEX IF NOT EXISTS sleep_start_time_idx ON sleep_entries (start_time DESC)');
  // Added for the milestone details/icon feature. Idempotent so existing
  // deployments (which already have the milestones table above) pick up
  // the new columns without a destructive migration. Existing rows
  // backfill to NULL details and the 'trophy' default icon.
  await pool.query('ALTER TABLE milestones ADD COLUMN IF NOT EXISTS details TEXT');
  await pool.query("ALTER TABLE milestones ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT 'trophy'");
}

// Keep in sync with the MILESTONE_ICONS keys defined in public/index.html.
const MILESTONE_ICON_KEYS = [
  'trophy', 'star', 'heart', 'smile', 'foot', 'tooth', 'moon', 'bath',
  'bottle', 'food', 'crawl', 'walk', 'hand', 'wave', 'sit', 'roll',
  'speech', 'music', 'book', 'camera', 'sun', 'gift', 'sparkle', 'medal'
];

function validateMilestoneInput(date, description, details, icon) {
  const dateMatch = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const isRealDate = dateMatch && !isNaN(new Date(date + 'T00:00:00Z').getTime());
  if (!isRealDate) {
    return 'date must be a valid YYYY-MM-DD date';
  }

  const trimmedDescription = typeof description === 'string' ? description.trim() : '';
  if (!trimmedDescription || trimmedDescription.length > 200) {
    return 'description must be between 1 and 200 characters';
  }

  if (details !== undefined && details !== null) {
    if (typeof details !== 'string') {
      return 'details must be a string';
    }
    if (details.trim().length > 2000) {
      return 'details must be 2000 characters or fewer';
    }
  }

  if (icon !== undefined && icon !== null && icon !== '') {
    if (typeof icon !== 'string' || !MILESTONE_ICON_KEYS.includes(icon)) {
      return 'icon is not a recognised icon key';
    }
  }

  return null;
}

// Shared shaping for POST/PUT so both endpoints persist the same
// normalized values: description/details trimmed (empty details -> null),
// icon defaulted to 'trophy' when absent.
function normalizeMilestoneInput(body) {
  const { date, description, details, icon } = body;
  return {
    date,
    description: typeof description === 'string' ? description.trim() : description,
    details: typeof details === 'string' && details.trim() ? details.trim() : null,
    icon: icon || 'trophy'
  };
}

// ==========================================
// 2.5 PIN AUTH
// ==========================================
// Shared-PIN gate: no user accounts. A PIN is either created on first run
// via POST /api/setup/pin (stored scrypt-hashed in app_settings) or supplied
// through the APP_PIN env var, which always takes precedence and serves as
// the lockout-recovery mechanism. Unlocking sets a stateless HMAC-signed
// httpOnly cookie valid for 30 days. The SPA shell in public/ stays public
// (it contains no secrets); all data access is enforced server-side below.

const SESSION_COOKIE = 'sprog_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PIN_MIN_LENGTH = 4;
const PIN_MAX_LENGTH = 64;
const MAX_UNLOCK_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function isValidPin(pin) {
  return typeof pin === 'string' && pin.length >= PIN_MIN_LENGTH && pin.length <= PIN_MAX_LENGTH;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

// record is 'saltHex:hashHex' as stored in app_settings
function verifyPinAgainstRecord(pin, record) {
  if (typeof pin !== 'string' || typeof record !== 'string') return false;
  const separator = record.indexOf(':');
  if (separator === -1) return false;
  const salt = Buffer.from(record.slice(0, separator), 'hex');
  const expected = Buffer.from(record.slice(separator + 1), 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = crypto.scryptSync(pin, salt, expected.length);
  return safeEqual(actual, expected);
}

// Deterministic HMAC key derived from whichever PIN material is in effect,
// so changing/overriding the PIN invalidates every existing session cookie.
function deriveSigningKey(material) {
  return crypto.createHmac('sha256', 'sprog-log session signing key').update(material).digest();
}

// Returns the effective PIN record used for verification and cookie signing:
//   { kind: 'env', pin }                    when APP_PIN is set
//   { kind: 'db', record: 'salt:hash' }     when a PIN was created in-app
//   null                                    setup mode (nothing configured)
async function getEffectivePinRecord() {
  const envPin = process.env.APP_PIN;
  if (envPin) {
    return { kind: 'env', pin: envPin };
  }
  const result = await pool.query("SELECT value FROM app_settings WHERE key = 'pin_hash'");
  if (result.rows.length === 0) return null;
  return { kind: 'db', record: result.rows[0].value };
}

function signingKeyFor(record) {
  return deriveSigningKey(record.kind === 'env' ? record.pin : record.record);
}

function verifyPin(pin, record) {
  if (record.kind === 'env') {
    return typeof pin === 'string' && safeEqual(Buffer.from(pin), Buffer.from(record.pin));
  }
  return verifyPinAgainstRecord(pin, record.record);
}

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const name = pair.slice(0, idx).trim();
    if (!name) return;
    try {
      cookies[name] = decodeURIComponent(pair.slice(idx + 1).trim());
    } catch (e) {
      // Malformed cookie value - ignore it.
    }
  });
  return cookies;
}

function signSessionCookie(signingKey) {
  const expiry = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const mac = crypto.createHmac('sha256', signingKey).update(String(expiry)).digest('hex');
  return expiry + '.' + mac;
}

function verifySessionCookie(value, signingKey) {
  if (typeof value !== 'string') return false;
  const dot = value.lastIndexOf('.');
  if (dot === -1) return false;
  const expiry = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!/^\d+$/.test(expiry)) return false;
  if (Number(expiry) <= Date.now()) return false;
  const expected = crypto.createHmac('sha256', signingKey).update(expiry).digest('hex');
  return safeEqual(Buffer.from(mac), Buffer.from(expected));
}

function sendSessionCookie(req, res, signingKey) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    SESSION_COOKIE + '=' + signSessionCookie(signingKey) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_MAX_AGE_SECONDS + secure
  );
}

// In-memory per-IP failed-unlock tracking. Resets on restart, which is fine
// for this threat model (throttling opportunistic brute force, not a
// determined attacker).
const unlockAttempts = new Map();

function getActiveLockout(ip) {
  const entry = unlockAttempts.get(ip);
  if (!entry) return null;
  if (entry.lockedUntil && entry.lockedUntil <= Date.now()) {
    unlockAttempts.delete(ip);
    return null;
  }
  return entry;
}

function recordFailedUnlock(ip) {
  const entry = unlockAttempts.get(ip) || { fails: 0, lockedUntil: null };
  entry.fails += 1;
  if (entry.fails >= MAX_UNLOCK_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.fails = 0;
  }
  unlockAttempts.set(ip, entry);
}

// GET: auth status probe used by the frontend to pick a screen. Reveals
// nothing but whether a PIN is configured and whether this request is
// already unlocked.
app.get('/api/auth', async (req, res) => {
  try {
    const record = await getEffectivePinRecord();
    if (!record) {
      return res.json({ status: 'setup' });
    }
    const cookies = parseCookies(req.headers.cookie);
    const unlocked = verifySessionCookie(cookies[SESSION_COOKIE], signingKeyFor(record));
    res.json({ status: unlocked ? 'unlocked' : 'locked' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error checking auth status' });
  }
});

// POST: one-time PIN creation. Only works while nothing is configured
// (no DB PIN and no APP_PIN override) - i.e. fresh deploys and existing
// deployments upgrading to this version.
app.post('/api/setup/pin', async (req, res) => {
  const { pin } = req.body || {};
  try {
    const existing = await getEffectivePinRecord();
    if (existing) {
      return res.status(409).json({ error: 'A PIN is already configured' });
    }
    if (!isValidPin(pin)) {
      return res.status(400).json({ error: 'PIN must be ' + PIN_MIN_LENGTH + '-' + PIN_MAX_LENGTH + ' characters' });
    }
    await pool.query(
      "INSERT INTO app_settings (key, value) VALUES ('pin_hash', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [hashPin(pin)]
    );
    const fresh = await getEffectivePinRecord();
    sendSessionCookie(req, res, signingKeyFor(fresh));
    res.status(201).json({ status: 'unlocked' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error saving PIN' });
  }
});

// POST: unlock with the configured PIN.
app.post('/api/unlock', async (req, res) => {
  const { pin } = req.body || {};
  try {
    const record = await getEffectivePinRecord();
    if (!record) {
      return res.status(409).json({ error: 'No PIN is configured yet; create one first' });
    }
    const lockout = getActiveLockout(req.ip);
    if (lockout && lockout.lockedUntil) {
      const retryAfterSeconds = Math.max(1, Math.ceil((lockout.lockedUntil - Date.now()) / 1000));
      return res.status(429).json({ error: 'Too many failed attempts, try again later', retryAfterSeconds });
    }
    if (verifyPin(pin, record)) {
      unlockAttempts.delete(req.ip);
      sendSessionCookie(req, res, signingKeyFor(record));
      return res.json({ status: 'unlocked' });
    }
    recordFailedUnlock(req.ip);
    const newLockout = getActiveLockout(req.ip);
    if (newLockout && newLockout.lockedUntil) {
      const retryAfterSeconds = Math.max(1, Math.ceil((newLockout.lockedUntil - Date.now()) / 1000));
      return res.status(429).json({ error: 'Too many failed attempts, try again later', retryAfterSeconds });
    }
    res.status(401).json({ error: 'Wrong PIN' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error unlocking' });
  }
});

// Everything below requires a valid session cookie. Registered after the
// exempt auth routes above so they stay reachable while locked/in setup.
app.use('/api', async (req, res, next) => {
  try {
    const record = await getEffectivePinRecord();
    if (!record) {
      return res.status(401).json({ error: 'locked', setup_required: true });
    }
    const cookies = parseCookies(req.headers.cookie);
    if (verifySessionCookie(cookies[SESSION_COOKIE], signingKeyFor(record))) {
      return next();
    }
    res.status(401).json({ error: 'locked' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// 3. DATABASE API ENDPOINTS
// ==========================================

// GET: Fetch the child profile (null if not yet onboarded)
app.get('/api/profile', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, sex FROM profile WHERE id = 1"
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching profile' });
  }
});

// POST: Create or update the child profile
app.post('/api/profile', async (req, res) => {
  const { name, birth_date, sex } = req.body;

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length > 60) {
    return res.status(400).json({ error: 'Name must be between 1 and 60 characters' });
  }

  const dateMatch = typeof birth_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(birth_date);
  const isRealDate = dateMatch && !isNaN(new Date(birth_date + 'T00:00:00Z').getTime());
  if (!isRealDate) {
    return res.status(400).json({ error: 'birth_date must be a valid YYYY-MM-DD date' });
  }

  if (sex !== 'male' && sex !== 'female') {
    return res.status(400).json({ error: "sex must be 'male' or 'female'" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO profile (id, name, birth_date, sex)
       VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, birth_date = EXCLUDED.birth_date, sex = EXCLUDED.sex
       RETURNING id, name, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, sex`,
      [trimmedName, birth_date, sex]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error saving profile' });
  }
});

// GET: Fetch all measurements
app.get('/api/measurements', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM measurements ORDER BY date ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching measurements' });
  }
});

// POST: Add a new measurement
app.post('/api/measurements', async (req, res) => {
  const { date, weight } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO measurements (date, weight) VALUES ($1, $2) RETURNING *',
      [date, weight]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error adding measurement' });
  }
});

// PUT: Update a measurement
app.put('/api/measurements/:id', async (req, res) => {
  const { id } = req.params;
  const { date, weight } = req.body;
  try {
    const result = await pool.query(
      'UPDATE measurements SET date = $1, weight = $2 WHERE id = $3 RETURNING *',
      [date, weight, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating measurement' });
  }
});

// DELETE: Remove a measurement
app.delete('/api/measurements/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM measurements WHERE id = $1', [id]);
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error deleting measurement' });
  }
});

// GET: Fetch all milestones
app.get('/api/milestones', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM milestones ORDER BY date ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching milestones' });
  }
});

// POST: Add a new milestone
app.post('/api/milestones', async (req, res) => {
  const { date, description, details, icon } = req.body;
  const validationError = validateMilestoneInput(date, description, details, icon);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }
  const normalized = normalizeMilestoneInput(req.body);
  try {
    const result = await pool.query(
      'INSERT INTO milestones (date, description, details, icon) VALUES ($1, $2, $3, $4) RETURNING *',
      [normalized.date, normalized.description, normalized.details, normalized.icon]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error adding milestone' });
  }
});

// PUT: Update a milestone
app.put('/api/milestones/:id', async (req, res) => {
  const { id } = req.params;
  const { date, description, details, icon } = req.body;
  const validationError = validateMilestoneInput(date, description, details, icon);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }
  const normalized = normalizeMilestoneInput(req.body);
  try {
    const result = await pool.query(
      'UPDATE milestones SET date = $1, description = $2, details = $3, icon = $4 WHERE id = $5 RETURNING *',
      [normalized.date, normalized.description, normalized.details, normalized.icon, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating milestone' });
  }
});

// DELETE: Remove a milestone
app.delete('/api/milestones/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM milestones WHERE id = $1', [id]);
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error deleting milestone' });
  }
});

// All sleep writes, including backup imports, use this transaction lock.
// It serializes overlap checks with writes across multiple server processes.
async function sleepMutation(res, operation) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(73657267, 1)');
    const result = await operation(client);
    await client.query('COMMIT');
    res.status(result.status || 200).json(result.body);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Server error updating sleep' });
  } finally {
    if (client) client.release();
  }
}

async function activeSleep(client) {
  const result = await client.query('SELECT * FROM sleep_entries WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1');
  return result.rows[0] || null;
}

async function sleepConflict(client, message) {
  return { status: 409, body: { error: message, active: await activeSleep(client) } };
}

// Explicit offsets prevent server timezone settings from changing the meaning
// of a timestamp submitted by a browser.
function validSleepTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(value.slice(0, 10) + 'T00:00:00Z');
  return year >= 1 && calendar.getUTCFullYear() === year && calendar.getUTCMonth() + 1 === month && calendar.getUTCDate() === day;
}

function validateSleepInterval(start, end) {
  if (!validSleepTimestamp(start) || !validSleepTimestamp(end)) return 'start_time and end_time must be valid timestamps with timezone';
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (endMs <= startMs) return 'end_time must be after start_time';
  if (startMs > Date.now() || endMs > Date.now()) return 'sleep timestamps cannot be in the future';
  return null;
}

function matchesExpectedSleep(row, body) {
  return validSleepTimestamp(body.expected_start_time) && validSleepTimestamp(body.expected_end_time) &&
    Date.parse(body.expected_start_time) === new Date(row.start_time).getTime() &&
    Date.parse(body.expected_end_time) === new Date(row.end_time).getTime();
}

async function overlapsSleep(client, start, end, excludeId) {
  const result = await client.query(
    `SELECT 1 FROM sleep_entries
     WHERE ($3::integer IS NULL OR id <> $3)
       AND start_time < $2::timestamptz
       AND (end_time IS NULL OR end_time > $1::timestamptz)
     LIMIT 1`,
    [start, end, excludeId || null]
  );
  return result.rows.length > 0;
}

const DISPLAY_DEFAULTS = {
  nap_night_mode: false,
  nap_night_effective_date: null,
  nap_night_bedtime: '19:00',
  nap_night_wake_time: '07:00'
};
const validTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const validOverride = value => value === null || value === 'nap' || value === 'overnight';

function validateDisplaySettings(settings) {
  const date = settings.nap_night_effective_date;
  if (typeof settings.nap_night_mode !== 'boolean' ||
      !(date === null || (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !date.startsWith('0000-') && backupDate(date) === date)) ||
      (settings.nap_night_mode && !date) ||
      !validTime(settings.nap_night_bedtime) || !validTime(settings.nap_night_wake_time) ||
      settings.nap_night_bedtime === settings.nap_night_wake_time) return 'Invalid display settings';
  return null;
}

async function readSleepSettings(client) {
  const result = await client.query("SELECT key, value FROM app_settings WHERE key IN ('sleep_day_start', 'nap_night_mode', 'nap_night_effective_date', 'nap_night_bedtime', 'nap_night_wake_time')");
  const values = Object.fromEntries(result.rows.map(row => [row.key, row.value]));
  return {
    day_start: values.sleep_day_start || '07:00',
    nap_night_mode: values.nap_night_mode === undefined ? false : values.nap_night_mode === 'true' ? true : values.nap_night_mode === 'false' ? false : values.nap_night_mode,
    nap_night_effective_date: values.nap_night_effective_date || null,
    nap_night_bedtime: values.nap_night_bedtime || DISPLAY_DEFAULTS.nap_night_bedtime,
    nap_night_wake_time: values.nap_night_wake_time || DISPLAY_DEFAULTS.nap_night_wake_time
  };
}

async function writeDisplaySettings(client, settings) {
  for (const key of Object.keys(DISPLAY_DEFAULTS)) {
    await client.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, String(settings[key] ?? '')]);
  }
}

app.get('/api/sleep', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sleep_entries ORDER BY start_time DESC, id DESC');
    const settings = await readSleepSettings(pool);
    const entries = result.rows.filter(row => row.end_time !== null);
    res.json({ entries, active: result.rows.find(row => row.end_time === null) || null,
      latest_completed: entries[0] || null, ...settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching sleep' });
  }
});

app.put('/api/sleep/day-start', async (req, res) => {
  const { day_start } = req.body || {};
  if (typeof day_start !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(day_start)) {
    return res.status(400).json({ error: 'day_start must be HH:MM' });
  }
  await sleepMutation(res, async client => {
    await client.query("INSERT INTO app_settings (key, value) VALUES ('sleep_day_start', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [day_start]);
    return { body: { day_start } };
  });
});

app.put('/api/sleep/display-settings', async (req, res) => {
  const settings = { ...(req.body || {}) };
  for (const key of ['nap_night_bedtime', 'nap_night_wake_time']) {
    if (settings[key] === undefined || settings[key] === null || settings[key] === '') settings[key] = DISPLAY_DEFAULTS[key];
  }
  const error = validateDisplaySettings(settings);
  if (error) return res.status(400).json({ error });
  await sleepMutation(res, async client => {
    await writeDisplaySettings(client, settings);
    return { body: Object.fromEntries(Object.keys(DISPLAY_DEFAULTS).map(key => [key, settings[key]])) };
  });
});

app.post('/api/sleep/start', async (req, res) => {
  await sleepMutation(res, async client => {
    const active = await activeSleep(client);
    if (active) return sleepConflict(client, 'Sleep is already active');
    // A future or overlapping completed interval must not be covered by an active sleep.
    const overlap = await client.query('SELECT 1 FROM sleep_entries WHERE end_time > clock_timestamp() LIMIT 1');
    if (overlap.rows.length) return sleepConflict(client, 'Sleep overlaps an existing entry');
    const result = await client.query('INSERT INTO sleep_entries (start_time) VALUES (clock_timestamp()) RETURNING *');
    return { body: result.rows[0] };
  });
});

app.put('/api/sleep/active/start', async (req, res) => {
  const { id, start_time, expected_start_time } = req.body || {};
  if (Object.hasOwn(req.body || {}, 'classification_override') && !validOverride(req.body.classification_override)) return res.status(400).json({ error: 'Invalid classification override' });
  if (Object.hasOwn(req.body || {}, 'expected_classification_override') && !validOverride(req.body.expected_classification_override)) return res.status(400).json({ error: 'Invalid expected classification override' });
  if (!validSleepTimestamp(start_time)) return res.status(400).json({ error: 'start_time must be a valid timestamp with timezone' });
  if (Date.parse(start_time) > Date.now()) return res.status(400).json({ error: 'sleep timestamps cannot be in the future' });
  await sleepMutation(res, async client => {
    const active = await activeSleep(client);
    if (!active || String(active.id) !== String(id) || !validSleepTimestamp(expected_start_time) ||
        Date.parse(expected_start_time) !== new Date(active.start_time).getTime() ||
        (Object.hasOwn(req.body || {}, 'expected_classification_override') && req.body.expected_classification_override !== (active.classification_override ?? null))) {
      return sleepConflict(client, 'Active sleep has changed');
    }
    // PostgreSQL stores microseconds, while JSON/Date only preserves milliseconds.
    // A display-only edit must leave the actual stored instant untouched, and
    // must not turn an adjacent interval into an apparent overlap by rounding.
    const overrideOnly = Object.hasOwn(req.body || {}, 'classification_override') && Date.parse(start_time) === new Date(active.start_time).getTime();
    if (!overrideOnly) {
      // The active interval extends indefinitely, so any later completed entry overlaps it.
      const overlap = await client.query('SELECT 1 FROM sleep_entries WHERE id <> $1 AND (end_time IS NULL OR end_time > $2::timestamptz) LIMIT 1', [active.id, start_time]);
      if (overlap.rows.length) return sleepConflict(client, 'Sleep overlaps an existing entry');
    }
    const result = overrideOnly
      ? await client.query('UPDATE sleep_entries SET classification_override = $2 WHERE id = $1 AND end_time IS NULL RETURNING *', [active.id, req.body.classification_override])
      : Object.hasOwn(req.body || {}, 'classification_override')
        ? await client.query('UPDATE sleep_entries SET start_time = $1, classification_override = $3 WHERE id = $2 AND end_time IS NULL RETURNING *', [start_time, active.id, req.body.classification_override])
        : await client.query('UPDATE sleep_entries SET start_time = $1 WHERE id = $2 AND end_time IS NULL RETURNING *', [start_time, active.id]);
    return { body: result.rows[0] };
  });
});

app.post('/api/sleep/stop', async (req, res) => {
  await sleepMutation(res, async client => {
    const active = await activeSleep(client);
    if (!active || String(active.id) !== String((req.body || {}).id)) return sleepConflict(client, 'Active sleep has changed');
    const result = await client.query('UPDATE sleep_entries SET end_time = clock_timestamp() WHERE id = $1 AND start_time < clock_timestamp() RETURNING *', [active.id]);
    if (!result.rows.length) return sleepConflict(client, 'Sleep cannot end before it starts');
    return { body: result.rows[0] };
  });
});

app.post('/api/sleep', async (req, res) => {
  const { start_time, end_time, classification_override = null } = req.body || {};
  if (!validOverride(classification_override)) return res.status(400).json({ error: 'Invalid classification override' });
  const error = validateSleepInterval(start_time, end_time);
  if (error) return res.status(400).json({ error });
  await sleepMutation(res, async client => {
    if (await overlapsSleep(client, start_time, end_time, null)) return sleepConflict(client, 'Sleep overlaps an existing entry');
    const result = await client.query('INSERT INTO sleep_entries (start_time, end_time, classification_override) VALUES ($1, $2, $3) RETURNING *', [start_time, end_time, classification_override]);
    return { body: result.rows[0] };
  });
});

app.put('/api/sleep/:id', async (req, res) => {
  const { start_time, end_time } = req.body || {};
  if (Object.hasOwn(req.body || {}, 'classification_override') && !validOverride(req.body.classification_override)) return res.status(400).json({ error: 'Invalid classification override' });
  if (Object.hasOwn(req.body || {}, 'expected_classification_override') && !validOverride(req.body.expected_classification_override)) return res.status(400).json({ error: 'Invalid expected classification override' });
  const error = validateSleepInterval(start_time, end_time);
  if (error) return res.status(400).json({ error });
  if (!/^[1-9]\d*$/.test(req.params.id) || Number(req.params.id) > 2147483647) return res.status(400).json({ error: 'Invalid sleep id' });
  await sleepMutation(res, async client => {
    const existing = await client.query('SELECT * FROM sleep_entries WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return { status: 404, body: { error: 'Sleep entry not found' } };
    if (existing.rows[0].end_time === null) return sleepConflict(client, 'Cannot edit active sleep');
    if (!matchesExpectedSleep(existing.rows[0], req.body || {}) ||
        (Object.hasOwn(req.body || {}, 'expected_classification_override') && req.body.expected_classification_override !== (existing.rows[0].classification_override ?? null))) return { status: 409, body: { error: 'Sleep entry has changed', active: await activeSleep(client), entry: existing.rows[0] } };
    const overrideOnly = Object.hasOwn(req.body || {}, 'classification_override') &&
      Date.parse(start_time) === new Date(existing.rows[0].start_time).getTime() &&
      Date.parse(end_time) === new Date(existing.rows[0].end_time).getTime();
    if (!overrideOnly && await overlapsSleep(client, start_time, end_time, req.params.id)) return sleepConflict(client, 'Sleep overlaps an existing entry');
    const result = overrideOnly
      ? await client.query('UPDATE sleep_entries SET classification_override = $2 WHERE id = $1 RETURNING *', [req.params.id, req.body.classification_override])
      : Object.hasOwn(req.body || {}, 'classification_override')
        ? await client.query('UPDATE sleep_entries SET start_time = $1, end_time = $2, classification_override = $4 WHERE id = $3 RETURNING *', [start_time, end_time, req.params.id, req.body.classification_override])
        : await client.query('UPDATE sleep_entries SET start_time = $1, end_time = $2 WHERE id = $3 RETURNING *', [start_time, end_time, req.params.id]);
    return { body: result.rows[0] };
  });
});

app.delete('/api/sleep/:id', async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.id) || Number(req.params.id) > 2147483647) return res.status(400).json({ error: 'Invalid sleep id' });
  await sleepMutation(res, async client => {
    const existing = await client.query('SELECT * FROM sleep_entries WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return { status: 404, body: { error: 'Sleep entry not found' } };
    if (existing.rows[0].end_time === null) return sleepConflict(client, 'Cannot delete active sleep');
    if (!matchesExpectedSleep(existing.rows[0], req.body || {})) return { status: 409, body: { error: 'Sleep entry has changed', active: await activeSleep(client), entry: existing.rows[0] } };
    await client.query('DELETE FROM sleep_entries WHERE id = $1', [req.params.id]);
    return { body: { message: 'Deleted successfully' } };
  });
});

// Versioned backups contain only child data, never app credentials. Each
// property is an independently replaceable section; absent properties are
// deliberately left untouched on import.
const BACKUP_SECTIONS = ['profile', 'weight', 'milestones', 'sleep', 'settings'];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function backupDate(value) {
  // Older exports can contain ISO timestamps from the measurements API.
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?Z)?$/.exec(value);
  if (!match) return null;
  const date = new Date(match[1] + 'T00:00:00Z');
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === match[1] ? match[1] : null;
}

function backupTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.exec(value);
  if (!match || !backupDate(match[1])) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function validateBackup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Backup must be an object');
  const legacy = !hasOwn(data, 'version');
  if (!legacy && data.version !== 1) throw new Error('Unsupported backup version');
  const keys = ['profile', 'entries', 'milestones', 'sleep', 'settings'];
  if (!keys.some(key => hasOwn(data, key))) throw new Error('Backup contains no sections');
  if (legacy && (!Array.isArray(data.entries) || keys.slice(2).some(key => hasOwn(data, key)))) {
    throw new Error('Invalid legacy backup');
  }
  const result = {};
  // Older exports may contain no profile or an incomplete one. Preserve the
  // existing profile in that case rather than inventing or deleting it.
  const legacyProfileComplete = data.profile && typeof data.profile === 'object' &&
    data.profile.name && data.profile.birth_date && data.profile.sex;
  if (hasOwn(data, 'profile') && (!legacy || legacyProfileComplete)) {
    const profile = data.profile;
    if (profile === null) result.profile = null;
    else {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
          typeof profile.name !== 'string' || !profile.name.trim() || profile.name.trim().length > 60 ||
          !backupDate(profile.birth_date) || !['male', 'female'].includes(profile.sex)) throw new Error('Invalid profile');
      result.profile = { name: profile.name.trim(), birth_date: backupDate(profile.birth_date), sex: profile.sex };
    }
  }
  if (hasOwn(data, 'entries')) {
    if (!Array.isArray(data.entries)) throw new Error('Invalid weight entries');
    result.entries = data.entries.map(entry => {
      const date = entry && backupDate(entry.date);
      const weight = entry && (typeof entry.weight === 'number' || (legacy && typeof entry.weight === 'string' && entry.weight.trim()) ? Number(entry.weight) : NaN);
      if (!date || !Number.isInteger(weight) || weight <= 0 || weight > 2147483647) throw new Error('Invalid weight entry');
      return { date, weight };
    });
  }
  if (hasOwn(data, 'milestones')) {
    if (!Array.isArray(data.milestones)) throw new Error('Invalid milestones');
    result.milestones = data.milestones.map(item => {
      if (!item || typeof item !== 'object' || !backupDate(item.date) || validateMilestoneInput(backupDate(item.date), item.description, item.details, item.icon)) throw new Error('Invalid milestone');
      return normalizeMilestoneInput({ ...item, date: backupDate(item.date) });
    });
  }
  if (hasOwn(data, 'sleep')) {
    if (!Array.isArray(data.sleep)) throw new Error('Invalid sleep entries');
    const now = Date.now();
    result.sleep = data.sleep.map(item => {
      if (!item || typeof item !== 'object') throw new Error('Invalid sleep entry');
      const start = backupTimestamp(item.start_time), end = backupTimestamp(item.end_time);
      const override = hasOwn(item, 'classification_override') ? item.classification_override : null;
      if (start === null || end === null || start >= end || end > now || !validOverride(override)) throw new Error('Invalid sleep entry');
      return { start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), classification_override: override };
    }).sort((a, b) => a.start_time.localeCompare(b.start_time));
    for (let i = 1; i < result.sleep.length; i++) {
      if (result.sleep[i].start_time < result.sleep[i - 1].end_time) throw new Error('Sleep entries overlap');
    }
  }
  if (hasOwn(data, 'settings')) {
    if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings) ||
        typeof data.settings.day_start !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.settings.day_start)) throw new Error('Invalid settings');
    const display = { ...DISPLAY_DEFAULTS, ...Object.fromEntries(Object.keys(DISPLAY_DEFAULTS).filter(key => hasOwn(data.settings, key)).map(key => [key, data.settings[key]])) };
    if (validateDisplaySettings(display)) throw new Error('Invalid settings');
    result.settings = { day_start: data.settings.day_start, ...display };
  }
  return result;
}

app.get('/api/backup', async (req, res) => {
  const selected = req.query.sections === undefined ? BACKUP_SECTIONS :
    typeof req.query.sections === 'string' ? req.query.sections.split(',') : [];
  if (!selected.length || selected.some(section => !BACKUP_SECTIONS.includes(section))) {
    return res.status(400).json({ error: 'Invalid backup sections' });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const backup = { version: 1 };
    if (selected.includes('profile')) {
      const result = await client.query("SELECT name, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, sex FROM profile WHERE id = 1");
      backup.profile = result.rows[0] || null;
    }
    if (selected.includes('weight')) {
      backup.entries = (await client.query("SELECT to_char(date, 'YYYY-MM-DD') AS date, weight FROM measurements ORDER BY date, id")).rows;
    }
    if (selected.includes('milestones')) {
      backup.milestones = (await client.query("SELECT to_char(date, 'YYYY-MM-DD') AS date, description, details, icon FROM milestones ORDER BY date, id")).rows;
    }
    if (selected.includes('sleep')) {
      backup.sleep = (await client.query('SELECT start_time, end_time, classification_override FROM sleep_entries WHERE end_time IS NOT NULL ORDER BY start_time, id')).rows;
    }
    if (selected.includes('settings')) {
      backup.settings = await readSleepSettings(client);
    }
    await client.query('COMMIT');
    res.json(backup);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Server error exporting backup' });
  } finally {
    if (client) client.release();
  }
});

app.post('/api/backup/validate', (req, res) => {
  try {
    const data = validateBackup(req.body);
    const sections = Object.keys(data).map(key => key === 'entries' ? 'weight' : key);
    res.json({ sections });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/backup/import', async (req, res) => {
  let data;
  try {
    data = validateBackup(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // The lock is shared with all sleep mutations. Checking after acquiring it
    // closes the race with starting or stopping a timer during an import.
    if (hasOwn(data, 'sleep') || hasOwn(data, 'settings')) {
      await client.query('SELECT pg_advisory_xact_lock(73657267, 1)');
    }
    if (hasOwn(data, 'sleep')) {
      const active = await client.query('SELECT id, start_time, end_time FROM sleep_entries WHERE end_time IS NULL LIMIT 1');
      if (active.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Cannot import sleep while a sleep is active', active: active.rows[0] });
      }
    }
    if (hasOwn(data, 'profile')) {
      await client.query('DELETE FROM profile WHERE id = 1');
      if (data.profile) await client.query('INSERT INTO profile (id, name, birth_date, sex) VALUES (1, $1, $2, $3)', [data.profile.name, data.profile.birth_date, data.profile.sex]);
    }
    if (hasOwn(data, 'entries')) {
      await client.query('DELETE FROM measurements');
      for (const entry of data.entries) await client.query('INSERT INTO measurements (date, weight) VALUES ($1, $2)', [entry.date, entry.weight]);
    }
    if (hasOwn(data, 'milestones')) {
      await client.query('DELETE FROM milestones');
      for (const item of data.milestones) await client.query('INSERT INTO milestones (date, description, details, icon) VALUES ($1, $2, $3, $4)', [item.date, item.description, item.details, item.icon]);
    }
    if (hasOwn(data, 'sleep')) {
      await client.query('DELETE FROM sleep_entries');
      for (const item of data.sleep) await client.query('INSERT INTO sleep_entries (start_time, end_time, classification_override) VALUES ($1, $2, $3)', [item.start_time, item.end_time, item.classification_override]);
    }
    if (hasOwn(data, 'settings')) {
      await client.query("INSERT INTO app_settings (key, value) VALUES ('sleep_day_start', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [data.settings.day_start]);
      await writeDisplaySettings(client, data.settings);
    }
    await client.query('COMMIT');
    res.json({ message: 'Import successful' });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Server error importing backup' });
  } finally {
    if (client) client.release();
  }
});

// Validate APP_PIN early (empty string is treated as unset).
if (process.env.APP_PIN) {
  if (!isValidPin(process.env.APP_PIN)) {
    console.error('APP_PIN must be ' + PIN_MIN_LENGTH + '-' + PIN_MAX_LENGTH + ' characters.');
    process.exit(1);
  }
} else if (process.env.APP_PIN === '') {
  delete process.env.APP_PIN;
}

// Start the server, ensuring the schema exists first
initDb()
  .then(async () => {
    if (!process.env.APP_PIN) {
      const result = await pool.query("SELECT 1 FROM app_settings WHERE key = 'pin_hash'");
      if (result.rows.length === 0) {
        console.log('No PIN configured - the app is in setup mode. Visit the site to create one.');
      }
    }
    app.listen(port, () => {
      console.log("Server running on port " + port);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });