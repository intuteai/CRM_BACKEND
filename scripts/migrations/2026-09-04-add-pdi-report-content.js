require('dotenv').config();
const pool = require('../../config/db');

async function migrate() {
  const statements = [
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS template_id TEXT NOT NULL DEFAULT 'general'`,
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS drive_file_id TEXT`,
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
