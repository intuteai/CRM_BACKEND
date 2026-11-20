// Input validation for the Innopack Parts Roster (/api/innopack/parts).
// Limits mirror the innopack_parts columns (scripts/migrations/2026-11-20-innopack-parts.js),
// so a bad value gets a 400 naming the field instead of a database error.
// Errors use the { path, msg } shape the Innopack screens read.

const TEXT_LIMITS = Object.freeze({
  section: 60,
  sourcing: 30,
  part_type: 30,
  part_name: 120,
  description: 300,
  units: 15,
  material_grade: 40,
  design_status: 20,
  rm_dimensions: 60,
  bop_supplier: 80,
  part_maturity: 30,
});

const QTY_MAX = 1000000;
const ALLOWED = new Set([...Object.keys(TEXT_LIMITS), 'qty']);
// The server assigns these; sending them is an error, not silently ignored.
const SERVER_OWNED = new Set(['id', 'sr_no', 'drg_no', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at']);

// Returns { values, errors }. Every editable field is written (missing -> null),
// so create and edit send the whole form. part_name is always required.
function validatePart(body) {
  const errors = [];
  const values = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { values, errors: [{ path: 'body', msg: 'must be a JSON object' }] };
  }

  for (const key of Object.keys(body)) {
    if (SERVER_OWNED.has(key)) errors.push({ path: key, msg: 'is assigned by the server and cannot be set' });
    else if (!ALLOWED.has(key)) errors.push({ path: key, msg: 'is not an allowed field' });
  }

  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    const v = body[field];
    if (v === undefined || v === null) { values[field] = null; continue; }
    if (typeof v !== 'string') { errors.push({ path: field, msg: 'must be text' }); continue; }
    const t = v.trim();
    if (t.length > max) { errors.push({ path: field, msg: `must be at most ${max} characters` }); continue; }
    values[field] = t === '' ? null : t;
  }
  if (!values.part_name && !errors.some((e) => e.path === 'part_name')) {
    errors.push({ path: 'part_name', msg: 'Part name is required' });
  }

  const q = body.qty;
  if (q === undefined || q === null || q === '') values.qty = null;
  else if (typeof q !== 'number' || !Number.isFinite(q)) errors.push({ path: 'qty', msg: 'must be a number' });
  else if (q < 0) errors.push({ path: 'qty', msg: 'cannot be negative' });
  else if (q > QTY_MAX) errors.push({ path: 'qty', msg: `must be at most ${QTY_MAX}` });
  else values.qty = Math.round(q * 1000) / 1000; // numeric(12,3)

  return { values, errors };
}

// Route :id must be a positive integer.
function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

module.exports = { TEXT_LIMITS, QTY_MAX, validatePart, parseId };
