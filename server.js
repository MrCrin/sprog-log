const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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

// Start the server, ensuring the schema exists first
initDb()
  .then(() => {
    app.listen(port, () => {
      console.log("Server running on port " + port);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });