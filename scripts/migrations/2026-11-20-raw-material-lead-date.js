require('dotenv').config();
const pool = require('../../config/db');

// Raw-material "Lead Date": the expected date a material will arrive.
// Optional, date only (no time), so a plain nullable DATE with no default.
// The API reads it as to_char(lead_date, 'YYYY-MM-DD') so it never shifts
// with the server timezone.
//
// Safe to run more than once. Run: node scripts/migrations/2026-11-20-raw-material-lead-date.js
async function migrate() {
  const statements = [
    'ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS lead_date DATE',
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of statements) {
      console.log('Running:', sql);
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log('Migration complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
