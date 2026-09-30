require('dotenv').config();
const pool = require('../../config/db');

// A real multi-motor AutoNXT lot (confirmed against an actual 16-motor
// Compage QA document) repeats Customer Name, Product ID, Product
// Specifications, Dwg. No, and Controller Type identically across every
// motor -- only pdi_no was previously shared at the batch level, so a
// technician had to retype these five fields on every one of N reports.
// These columns let createBatch seed them once and (mirroring pdi_no's
// existing authoritative-at-render behavior) keep them consistent across
// the whole lot even if an individual report's own data drifts.
async function migrate() {
  const statements = [
    `ALTER TABLE pdi_report_batches ADD COLUMN IF NOT EXISTS customer_name TEXT`,
    `ALTER TABLE pdi_report_batches ADD COLUMN IF NOT EXISTS product_id TEXT`,
    `ALTER TABLE pdi_report_batches ADD COLUMN IF NOT EXISTS product_specifications TEXT`,
    `ALTER TABLE pdi_report_batches ADD COLUMN IF NOT EXISTS drawing_no TEXT`,
    `ALTER TABLE pdi_report_batches ADD COLUMN IF NOT EXISTS controller_type TEXT`,
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
