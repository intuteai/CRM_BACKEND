// Innopack Parts Roster data access (table innopack_parts).
const pool = require('../../config/db');

const EDITABLE = ['section', 'sourcing', 'part_type', 'part_name', 'description', 'units', 'qty',
  'material_grade', 'design_status', 'rm_dimensions', 'bop_supplier', 'part_maturity'];

const SELECT = `
  SELECT p.id, p.sr_no, p.section, p.sourcing, p.part_type, p.part_name, p.description, p.units,
         p.qty, p.material_grade, p.design_status, p.rm_dimensions, p.drg_no, p.bop_supplier,
         p.part_maturity, p.created_at, p.updated_at, u.name AS updated_by_name
  FROM innopack_parts p
  LEFT JOIN users u ON u.user_id = COALESCE(p.updated_by, p.created_by)`;

// Drawing numbers look like A00001. Only server-assigned, never reused.
const DRG_PREFIX = 'A';
const DRG_DIGITS = 5;
const formatDrg = (n) => `${DRG_PREFIX}${String(n).padStart(DRG_DIGITS, '0')}`;
// Serializes numbering so two parts saved at the same moment never get the same number.
const NUMBERING_LOCK = 774201;

// pg returns numeric as a string.
function toPart(row) {
  if (!row) return null;
  return { ...row, qty: row.qty === null || row.qty === undefined ? null : Number(row.qty) };
}

async function nextNumbers(db) {
  const { rows: [r] } = await db.query(`
    SELECT COALESCE(MAX(substring(drg_no FROM 2)::int) FILTER (WHERE drg_no ~ '^A[0-9]+$'), 0) + 1 AS drg,
           COALESCE(MAX(sr_no), 0) + 1 AS sr
    FROM innopack_parts`);
  return { drg_no: formatDrg(r.drg), sr_no: r.sr };
}

async function list() {
  const { rows } = await pool.query(`${SELECT} WHERE p.deleted_at IS NULL ORDER BY p.sr_no, p.id`);
  return rows.map(toPart);
}

async function getById(id) {
  const { rows } = await pool.query(`${SELECT} WHERE p.id = $1 AND p.deleted_at IS NULL`, [id]);
  return toPart(rows[0]);
}

// Distinct values already used, for the form's suggestions.
async function options() {
  const cols = ['section', 'sourcing', 'part_type', 'units', 'material_grade', 'design_status', 'part_maturity', 'bop_supplier'];
  const selects = cols.map((c) => `ARRAY(SELECT DISTINCT ${c} FROM innopack_parts WHERE deleted_at IS NULL AND ${c} IS NOT NULL ORDER BY ${c}) AS ${c}`);
  const { rows: [r] } = await pool.query(`SELECT ${selects.join(', ')}`);
  const out = {};
  for (const c of cols) out[c] = r[c];
  for (const s of ['TBD', 'RELEASED']) if (!out.design_status.includes(s)) out.design_status.push(s);
  out.design_status.sort();
  out.next_drg_no = (await nextNumbers(pool)).drg_no;
  return out;
}

async function create(values, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [NUMBERING_LOCK]);
    const { drg_no, sr_no } = await nextNumbers(client);
    const cols = [...EDITABLE, 'drg_no', 'sr_no', 'created_by', 'updated_by'];
    const vals = [...EDITABLE.map((c) => values[c]), drg_no, sr_no, userId, userId];
    const { rows: [{ id }] } = await client.query(
      `INSERT INTO innopack_parts (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      vals
    );
    await client.query('COMMIT');
    return getById(id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// null when the part does not exist (or was deleted).
async function update(id, values, userId) {
  const sets = EDITABLE.map((c, i) => `${c} = $${i + 1}`);
  const { rowCount } = await pool.query(
    `UPDATE innopack_parts SET ${sets.join(', ')}, updated_by = $${EDITABLE.length + 1}, updated_at = now()
     WHERE id = $${EDITABLE.length + 2} AND deleted_at IS NULL`,
    [...EDITABLE.map((c) => values[c]), userId, id]
  );
  return rowCount ? getById(id) : null;
}

// Hides the part; its drawing number stays taken. false when not found.
async function remove(id, userId) {
  const { rowCount } = await pool.query(
    'UPDATE innopack_parts SET deleted_at = now(), updated_by = $1, updated_at = now() WHERE id = $2 AND deleted_at IS NULL',
    [userId, id]
  );
  return rowCount > 0;
}

module.exports = { EDITABLE, formatDrg, list, getById, options, create, update, remove };
