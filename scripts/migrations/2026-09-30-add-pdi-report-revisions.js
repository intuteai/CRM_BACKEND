require('dotenv').config();
const pool = require('../../config/db');

// Backs docs/superpowers/specs/2026-09-30-pdi-finalized-report-editing-design.md.
// revision_no starts at 1 for every existing report (additive, no backfill
// needed). pdi_report_revisions holds one row per past edit to an
// already-Completed report -- each row's `data` is what the report's own
// `data` column looked like immediately BEFORE that edit (the revision_no
// column on this table names which revision that snapshot WAS, not what it
// became). photos are deliberately not snapshotted here -- see the spec.
// ON DELETE CASCADE matters here: deleteReport does a plain `DELETE FROM
// pre_dispatch_inspection_reports` with no special-casing -- without cascade,
// deleting any report that has ever been edited-while-Completed (i.e. has
// revision history) would fail outright with a foreign-key-violation error.
async function migrate() {
  const statements = [
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS revision_no INTEGER NOT NULL DEFAULT 1`,
    `CREATE TABLE IF NOT EXISTS pdi_report_revisions (
      revision_id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL REFERENCES pre_dispatch_inspection_reports(report_id) ON DELETE CASCADE,
      revision_no INTEGER NOT NULL,
      data JSONB NOT NULL,
      edited_by INTEGER REFERENCES users(user_id),
      edited_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
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
