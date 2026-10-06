require('dotenv').config();
const pool = require('../../config/db');

// Every lot read (overview, finalize, delete, lot update, the report list's
// lot columns) looks members up by batch_id. The unique index also makes
// "two reports claiming the same slot in one lot" impossible; standalone
// reports (batch_id NULL) are left out of it.
// If the unique index fails, a lot already has a duplicate lot_index. Find it
// with: SELECT batch_id, lot_index, COUNT(*) FROM pre_dispatch_inspection_reports
// WHERE batch_id IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1;
async function migrate() {
  const statements = [
    `CREATE INDEX IF NOT EXISTS idx_pdi_reports_batch_id
       ON pre_dispatch_inspection_reports (batch_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_pdi_reports_batch_lot_index
       ON pre_dispatch_inspection_reports (batch_id, lot_index)
       WHERE batch_id IS NOT NULL`,
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
