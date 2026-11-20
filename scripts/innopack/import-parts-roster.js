// One-time import of Innopack's Excel parts roster into innopack_parts.
// Input: a JSON array of rows with the table's column names (sr_no, section,
// sourcing, part_type, part_name, description, units, qty, material_grade,
// design_status, rm_dimensions, drg_no, bop_supplier, part_maturity), made from
// the workbook "INNOPACK PARTS ROSTER 19112026.xlsx".
// Keeps each row's own sr_no and drg_no. Rows whose drg_no already exists are
// skipped, so running it again changes nothing. Only clean-up: sourcing is
// upper-cased ("INnopack" and "INNOPACK" are the same).
// Usage: node scripts/innopack/import-parts-roster.js <rows.json> [--dry-run]
require('dotenv').config();
const fs = require('fs');
const pool = require('../../config/db');
const { TEXT_LIMITS } = require('../../controllers/innopack/parts.validation');

const COLS = ['sr_no', 'section', 'sourcing', 'part_type', 'part_name', 'description', 'units', 'qty',
  'material_grade', 'design_status', 'rm_dimensions', 'drg_no', 'bop_supplier', 'part_maturity'];

function clean(row, index) {
  const out = {};
  for (const c of COLS) {
    let v = row[c] === undefined ? null : row[c];
    if (typeof v === 'string') v = v.trim() || null;
    out[c] = v;
  }
  if (out.sourcing) out.sourcing = out.sourcing.toUpperCase();
  const problems = [];
  if (!Number.isInteger(out.sr_no)) problems.push('sr_no is not a whole number');
  if (!out.drg_no || !/^A\d+$/.test(out.drg_no)) problems.push(`bad drg_no ${out.drg_no}`);
  if (out.qty !== null && (typeof out.qty !== 'number' || out.qty < 0)) problems.push(`bad qty ${out.qty}`);
  for (const [f, max] of Object.entries(TEXT_LIMITS)) {
    if (out[f] !== null && typeof out[f] !== 'string') out[f] = String(out[f]);
    if (out[f] && out[f].length > max) problems.push(`${f} longer than ${max}`);
  }
  if (problems.length) throw new Error(`Row ${index + 1} (${out.drg_no}): ${problems.join('; ')}`);
  return out;
}

async function run() {
  const [file, flag] = process.argv.slice(2);
  if (!file) throw new Error('Usage: node scripts/innopack/import-parts-roster.js <rows.json> [--dry-run]');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')).map(clean);
  const drgs = rows.map((r) => r.drg_no);
  if (new Set(drgs).size !== drgs.length) throw new Error('The file has duplicate drawing numbers');

  const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT drg_no FROM innopack_parts WHERE drg_no = ANY($1::text[])', [drgs]);
    const skip = new Set(existing.map((r) => r.drg_no));
    let inserted = 0;
    for (const r of rows) {
      if (skip.has(r.drg_no)) continue;
      await client.query(
        `INSERT INTO innopack_parts (${COLS.join(', ')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')})`,
        COLS.map((c) => r[c])
      );
      inserted++;
    }
    if (flag === '--dry-run') {
      await client.query('ROLLBACK');
      console.log(`[dry run, ${db}] would insert ${inserted}, skip ${skip.size} already present`);
    } else {
      await client.query('COMMIT');
      console.log(`[${db}] inserted ${inserted}, skipped ${skip.size} already present`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
