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