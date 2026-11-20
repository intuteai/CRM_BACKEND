require('dotenv').config();
const pool = require('../../config/db');

// Innopack Parts Roster: the machine parts list Innopack's design engineer
// fills (one row per part, grouped by machine section). Innopack-only data:
// only role 16 (innopack_design) reaches it, through /api/innopack.
//
// Column sizes match the API limits in controllers/innopack/parts.validation.js.
// drg_no is unique and never reused: deleting a part only sets deleted_at.
//
// Safe to run more than once. Run: node scripts/migrations/2026-11-20-innopack-parts.js
async function migrate() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS innopack_parts (
       id             SERIAL PRIMARY KEY,
       sr_no          INTEGER NOT NULL,
       section        VARCHAR(60),
       sourcing       VARCHAR(30),
       part_type      VARCHAR(30),
       part_name      VARCHAR(120),
       description    VARCHAR(300),
       units          VARCHAR(15),
       qty            NUMERIC(12,3) CHECK (qty >= 0),
       material_grade VARCHAR(40),
       design_status  VARCHAR(20),
       rm_dimensions  VARCHAR(60),
       drg_no         VARCHAR(20) NOT NULL UNIQUE,
       bop_supplier   VARCHAR(80),
       part_maturity  VARCHAR(30),
       created_by     INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
       updated_by     INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
       created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
       deleted_at     TIMESTAMPTZ
     )`,
    'CREATE INDEX IF NOT EXISTS innopack_parts_live_sr_idx ON innopack_parts (sr_no) WHERE deleted_at IS NULL',
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of statements) {
      console.log('Running:', sql.split('\n')[0]);
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
