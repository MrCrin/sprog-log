const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
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