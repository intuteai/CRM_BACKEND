require('dotenv').config();
const pool = require('../../config/db');

async function migrate() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS pdi_report_batches (
      batch_id SERIAL PRIMARY KEY,
      template_id TEXT NOT NULL,
      pdi_no TEXT NOT NULL,
      lot_quantity INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'In Progress',
      drive_file_id TEXT,
      created_by INTEGER REFERENCES users(user_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES pdi_report_batches(batch_id)`,
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS lot_index INTEGER`,
  ];

  for (const sql of statements) {
    console.log('Running:', sql);
    await pool.query(sql);
  }

  console.log('Migration complete.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
