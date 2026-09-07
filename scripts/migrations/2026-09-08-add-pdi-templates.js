require('dotenv').config();
const pool = require('../../config/db');

async function migrate() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS pdi_templates (
      id          TEXT NOT NULL,
      version     INT NOT NULL,
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
      definition  JSONB NOT NULL,
      created_by  INT REFERENCES users(user_id),
      created_at  TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (id, version)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pdi_templates_id_version ON pdi_templates (id, version DESC)`,
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS template_version INT`,
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
