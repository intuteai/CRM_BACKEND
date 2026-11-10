// Governance data access for the motor-test module (docs/motor-test/admin-api.md).
// Every change writes an mt_audit_event in the same transaction (ISO/IEC 27001 change logging).
'use strict';
const pool = require('../../config/db');
const { payloadHash } = require('../../services/testing/digest');

const iso = (d) => (d ? new Date(d).toISOString() : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));

class AdminError extends Error {
  constructor(status, code, msg, extra = {}) { super(msg); Object.assign(this, { status, code, extra }); }
}

async function audit(db, actorUserId, action, entity, entityId, detail = {}, operatorRef = null) {
  await db.query(`INSERT INTO mt_audit_event (actor_user_id, actor_operator_ref, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
    [actorUserId, operatorRef, action, entity, entityId == null ? null : String(entityId), detail]);
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ products and variants

async function listProducts() {
  const { rows } = await pool.query(`SELECT i.product_id, btrim(i.product_name) AS product_name, i.product_code, i.part_number, v.variant_id
    FROM inventory i LEFT JOIN mt_motor_variant v ON v.product_id = i.product_id ORDER BY i.product_id`);
  return rows;
}

const VARIANT_SELECT = `
  SELECT v.variant_id, v.product_id, btrim(i.product_name) AS product_name, i.product_code, v.code, v.max_rpm_limit,
         v.rated_voltage_v, v.rated_power_w, v.rated_current_a, v.controller_model, v.serial_pattern, v.active, v.created_by, v.created_at,
         (SELECT version FROM mt_profile_version p WHERE p.variant_id = v.variant_id AND p.status = 'PUBLISHED') AS published_profile_version,
         (SELECT version FROM mt_criteria_version c WHERE c.variant_id = v.variant_id AND c.status = 'PUBLISHED') AS published_criteria_version
  FROM mt_motor_variant v JOIN inventory i ON i.product_id = v.product_id`;
const variantJson = (r) => r && ({ ...r, rated_voltage_v: num(r.rated_voltage_v), rated_power_w: num(r.rated_power_w), rated_current_a: num(r.rated_current_a), created_at: iso(r.created_at) });

async function listVariants(includeInactive) {
  const { rows } = await pool.query(`${VARIANT_SELECT} ${includeInactive ? '' : 'WHERE v.active'} ORDER BY v.code`);
  return rows.map(variantJson);
}
async function getVariant(id, db = pool) {
  const { rows: [r] } = await db.query(`${VARIANT_SELECT} WHERE v.variant_id = $1`, [id]);
  return variantJson(r) || null;
}

const VARIANT_FIELDS = ['code', 'max_rpm_limit', 'rated_voltage_v', 'rated_power_w', 'rated_current_a', 'controller_model', 'serial_pattern'];

async function createVariant(f, userId) {
  return tx(async (db) => {
    const { rowCount } = await db.query('SELECT 1 FROM inventory WHERE product_id = $1', [f.product_id]);
    if (!rowCount) throw new AdminError(400, 'VALIDATION_ERROR', 'Unknown product', { fields: [{ path: 'product_id', msg: 'not found in inventory' }] });
    const { rows: [r] } = await db.query(`INSERT INTO mt_motor_variant (product_id, ${VARIANT_FIELDS.join(', ')}, created_by)
      VALUES ($1, ${VARIANT_FIELDS.map((_, i) => `$${i + 2}`).join(', ')}, $${VARIANT_FIELDS.length + 2}) RETURNING variant_id`,
    [f.product_id, ...VARIANT_FIELDS.map((k) => f[k] ?? null), userId]);
    await audit(db, userId, 'VARIANT_CREATED', 'mt_motor_variant', r.variant_id, f);
    return getVariant(r.variant_id, db);
  });
}

async function updateVariant(id, f, userId) {
  return tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM mt_motor_variant WHERE variant_id = $1 FOR UPDATE', [id]);
    if (!before) throw new AdminError(404, 'NOT_FOUND', 'Variant not found');
    const keys = [...VARIANT_FIELDS, 'active'].filter((k) => k in f);
    if (keys.length) {
      await db.query(`UPDATE mt_motor_variant SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE variant_id = $1`, [id, ...keys.map((k) => f[k])]);
      await audit(db, userId, 'VARIANT_UPDATED', 'mt_motor_variant', id, { before: Object.fromEntries(keys.map((k) => [k, before[k]])), after: Object.fromEntries(keys.map((k) => [k, f[k]])) });
    }
    return getVariant(id, db);
  });
}

// ------------------------------------------------------------------ versions (profiles / criteria)

const KINDS = {
  profiles: { table: 'mt_profile_version', id: 'profile_id', fields: ['max_rpm', 'step_rpm', 'duration_s', 'sample_hz'], entity: 'mt_profile_version', label: 'PROFILE' },
  criteria: { table: 'mt_criteria_version', id: 'criteria_version_id', fields: ['definition', 'source_document'], entity: 'mt_criteria_version', label: 'CRITERIA' },
};

const versionJson = (r) => r && ({
  ...r, created_at: iso(r.created_at), submitted_at: iso(r.submitted_at), published_at: iso(r.published_at), retired_at: iso(r.retired_at),
});
const VERSION_SELECT = (k) => `SELECT x.*, cu.name AS created_by_name, au.name AS approved_by_name
  FROM ${KINDS[k].table} x LEFT JOIN users cu ON cu.user_id = x.created_by LEFT JOIN users au ON au.user_id = x.approved_by`;

async function listVersions(kind, variantId) {
  const { rows } = await pool.query(`${VERSION_SELECT(kind)} WHERE x.variant_id = $1 ORDER BY x.version DESC`, [variantId]);
  return rows.map(versionJson);
}
async function getVersion(kind, id, db = pool) {
  const { rows: [r] } = await db.query(`${VERSION_SELECT(kind)} WHERE x.${KINDS[kind].id} = $1`, [id]);
  return versionJson(r) || null;
}

async function lockVersion(db, kind, id) {
  const { rows: [r] } = await db.query(`SELECT * FROM ${KINDS[kind].table} WHERE ${KINDS[kind].id} = $1 FOR UPDATE`, [id]);
  if (!r) throw new AdminError(404, 'NOT_FOUND', 'Version not found');
  return r;
}
const needStatus = (r, ...statuses) => {
  if (!statuses.includes(r.status)) throw new AdminError(409, 'LIFECYCLE_CONFLICT', `Not allowed while the version is ${r.status} (needs ${statuses.join(' or ')})`, { status: r.status });
};

async function checkProfileLimit(db, variantId, maxRpm) {
  const { rows: [v] } = await db.query('SELECT max_rpm_limit FROM mt_motor_variant WHERE variant_id = $1', [variantId]);
  if (v && v.max_rpm_limit && maxRpm > v.max_rpm_limit) {
    throw new AdminError(400, 'VALIDATION_ERROR', 'max_rpm is above the variant limit', { fields: [{ path: 'max_rpm', msg: `must be <= ${v.max_rpm_limit} (variant max_rpm_limit)` }] });
  }
}

async function createVersion(kind, variantId, f, userId) {
  const K = KINDS[kind];
  return tx(async (db) => {
    const { rows: [v] } = await db.query('SELECT variant_id FROM mt_motor_variant WHERE variant_id = $1 FOR UPDATE', [variantId]);
    if (!v) throw new AdminError(404, 'NOT_FOUND', 'Variant not found');
    const { rows: [{ next }] } = await db.query(`SELECT coalesce(max(version), 0) + 1 AS next FROM ${K.table} WHERE variant_id = $1`, [variantId]);
    let values;
    if (kind === 'profiles') {
      await checkProfileLimit(db, variantId, f.max_rpm);
      values = K.fields.map((k) => f[k]);
    } else {
      values = [{ ...f.definition, variant_id: variantId, version: next }, f.source_document ?? null];
    }
    const { rows: [r] } = await db.query(`INSERT INTO ${K.table} (variant_id, version, ${K.fields.join(', ')}, created_by, last_modified_by)
      VALUES ($1, $2, ${K.fields.map((_, i) => `$${i + 3}`).join(', ')}, $${K.fields.length + 3}, $${K.fields.length + 3}) RETURNING ${K.id} AS id`, [variantId, next, ...values, userId]);
    await audit(db, userId, `${K.label}_DRAFT_CREATED`, K.entity, r.id, { variant_id: variantId, version: next });
    return getVersion(kind, r.id, db);
  });
}

async function updateDraft(kind, id, f, userId) {
  const K = KINDS[kind];
  return tx(async (db) => {
    const r = await lockVersion(db, kind, id);
    needStatus(r, 'DRAFT');
    const keys = K.fields.filter((k) => k in f);
    if (keys.length) {
      if (kind === 'profiles') await checkProfileLimit(db, r.variant_id, f.max_rpm ?? r.max_rpm);
      const vals = keys.map((k) => (k === 'definition' ? { ...f.definition, variant_id: r.variant_id, version: r.version } : f[k]));
      await db.query(`UPDATE ${K.table} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, last_modified_by = $${keys.length + 2} WHERE ${K.id} = $1`, [id, ...vals, userId]);
      await audit(db, userId, `${K.label}_DRAFT_UPDATED`, K.entity, id, { fields: keys });
    }
    return getVersion(kind, id, db);
  });
}

async function deleteDraft(kind, id, userId) {
  const K = KINDS[kind];
  return tx(async (db) => {
    const r = await lockVersion(db, kind, id);
    needStatus(r, 'DRAFT');
    await db.query(`DELETE FROM ${K.table} WHERE ${K.id} = $1`, [id]);
    await audit(db, userId, `${K.label}_DRAFT_DELETED`, K.entity, id, { variant_id: r.variant_id, version: r.version });
  });
}

const sha256Of = (kind, r) => (kind === 'profiles'
  ? payloadHash({ variant_id: r.variant_id, version: r.version, max_rpm: r.max_rpm, step_rpm: r.step_rpm, duration_s: r.duration_s, sample_hz: r.sample_hz })
  : payloadHash(r.definition));

async function transition(kind, id, action, userId, { note, reason } = {}) {
  const K = KINDS[kind];
  return tx(async (db) => {
    let r = await lockVersion(db, kind, id);
    if (action === 'submit') {
      needStatus(r, 'DRAFT');
      await db.query(`UPDATE ${K.table} SET status = 'IN_REVIEW', submitted_at = now(), submitted_by = $2 WHERE ${K.id} = $1`, [id, userId]);
      await audit(db, userId, `${K.label}_SUBMITTED`, K.entity, id, { version: r.version });
    } else if (action === 'return') {
      needStatus(r, 'IN_REVIEW');
      await db.query(`UPDATE ${K.table} SET status = 'DRAFT', submitted_at = NULL, submitted_by = NULL WHERE ${K.id} = $1`, [id]);
      await audit(db, userId, `${K.label}_RETURNED`, K.entity, id, { version: r.version, note: note || null });
    } else if (action === 'approve') {
      await db.query('SELECT 1 FROM mt_motor_variant WHERE variant_id = $1 FOR UPDATE', [r.variant_id]); // one publish at a time per variant
      r = await lockVersion(db, kind, id);
      needStatus(r, 'IN_REVIEW');
      if ([r.created_by, r.last_modified_by, r.submitted_by].includes(userId)) {
        throw new AdminError(409, 'SECOND_PERSON_REQUIRED', 'A version must be approved by someone who did not create, edit or submit it');
      }
      const sha = sha256Of(kind, r);
      const { rows: prev } = await db.query(`UPDATE ${K.table} SET status = 'SUPERSEDED', retired_at = now(), retired_reason = $2
        WHERE variant_id = $1 AND status = 'PUBLISHED' RETURNING ${K.id} AS id, version`, [r.variant_id, `Superseded by version ${r.version}`]);
      await db.query(`UPDATE ${K.table} SET status = 'PUBLISHED', sha256 = $2, approved_by = $3, published_at = now() WHERE ${K.id} = $1`, [id, sha, userId]);
      await audit(db, userId, `${K.label}_PUBLISHED`, K.entity, id, { version: r.version, sha256: sha, superseded: prev.map((p) => p.version) });
    } else if (action === 'withdraw') {
      needStatus(r, 'PUBLISHED');
      await db.query(`UPDATE ${K.table} SET status = 'WITHDRAWN', retired_at = now(), retired_reason = $2 WHERE ${K.id} = $1`, [id, reason]);
      await audit(db, userId, `${K.label}_WITHDRAWN`, K.entity, id, { version: r.version, reason });
    } else {
      throw new AdminError(404, 'NOT_FOUND', 'Unknown action');
    }
    return getVersion(kind, id, db);
  });
}

// ------------------------------------------------------------------ operators pick-list

const operatorJson = (r) => ({ ...r, created_at: iso(r.created_at), deactivated_at: iso(r.deactivated_at) });
async function listOperatorsAdmin(includeInactive) {
  const { rows } = await pool.query(`SELECT operator_ref, name, user_id, active, created_at, deactivated_at FROM mt_operator
    ${includeInactive ? '' : 'WHERE active'} ORDER BY active DESC, lower(name)`);
  return rows.map(operatorJson);
}
async function createOperator(f, userId) {
  return tx(async (db) => {
    const { rows: [r] } = await db.query(`INSERT INTO mt_operator (name, user_id, created_by) VALUES ($1, $2, $3)
      RETURNING operator_ref, name, user_id, active, created_at, deactivated_at`, [f.name.trim(), f.user_id ?? null, userId]);
    await audit(db, userId, 'OPERATOR_CREATED', 'mt_operator', r.operator_ref, { name: r.name });
    return operatorJson(r);
  });
}
async function updateOperator(ref, f, userId) {
  return tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM mt_operator WHERE operator_ref = $1 FOR UPDATE', [ref]);
    if (!b) throw new AdminError(404, 'NOT_FOUND', 'Operator not found');
    const name = 'name' in f ? f.name.trim() : b.name;
    const userIdNew = 'user_id' in f ? f.user_id : b.user_id;
    const active = 'active' in f ? f.active : b.active;
    const deactivatedAt = active ? null : (b.active ? new Date() : b.deactivated_at);
    const { rows: [r] } = await db.query(`UPDATE mt_operator SET name = $2, user_id = $3, active = $4, deactivated_at = $5 WHERE operator_ref = $1
      RETURNING operator_ref, name, user_id, active, created_at, deactivated_at`, [ref, name, userIdNew, active, deactivatedAt]);
    await audit(db, userId, 'OPERATOR_UPDATED', 'mt_operator', ref, { before: { name: b.name, user_id: b.user_id, active: b.active }, after: { name, user_id: userIdNew, active } });
    return operatorJson(r);
  });
}

// ------------------------------------------------------------------ users and testing roles

const NON_STAFF_ROLE_IDS = [2, 11, 12]; // customers and Intute AI roles: not Compage testing staff

async function listUsers(q, limit) {
  const params = [NON_STAFF_ROLE_IDS, limit];
  let filter = '';
  if (q) { params.push(`%${q}%`); filter = 'AND (u.name ILIKE $3 OR u.email ILIKE $3)'; }
  const { rows } = await pool.query(`
    SELECT u.user_id, u.name, u.email, r.role_name AS erp_role,
           coalesce(array_agg(m.testing_role ORDER BY m.testing_role) FILTER (WHERE m.testing_role IS NOT NULL), '{}') AS testing_roles
    FROM users u LEFT JOIN roles r ON r.role_id = u.role_id LEFT JOIN mt_user_role m ON m.user_id = u.user_id
    WHERE NOT (u.role_id = ANY($1::int[])) ${filter}
    GROUP BY u.user_id, u.name, u.email, r.role_name ORDER BY u.name LIMIT $2`, params);
  return rows;
}

async function setUserRoles(targetId, roles, actor) {
  return tx(async (db) => {
    const { rows: [u] } = await db.query('SELECT user_id, role_id FROM users WHERE user_id = $1', [targetId]);
    if (!u || NON_STAFF_ROLE_IDS.includes(u.role_id)) throw new AdminError(404, 'NOT_FOUND', 'User not found or not Compage staff');
    const { rows } = await db.query('SELECT testing_role FROM mt_user_role WHERE user_id = $1 FOR UPDATE', [targetId]);
    const current = rows.map((r) => r.testing_role);
    if (targetId === actor.user_id && current.includes('testing_admin') && !roles.includes('testing_admin')) {
      throw new AdminError(409, 'LIFECYCLE_CONFLICT', 'You cannot remove your own testing_admin role');
    }
    const revoke = current.filter((r) => !roles.includes(r));
    const grant = roles.filter((r) => !current.includes(r));
    if (revoke.length) await db.query('DELETE FROM mt_user_role WHERE user_id = $1 AND testing_role = ANY($2::text[])', [targetId, revoke]);
    for (const role of grant) await db.query('INSERT INTO mt_user_role (user_id, testing_role, granted_by) VALUES ($1, $2, $3)', [targetId, role, actor.user_id]);
    for (const role of grant) await audit(db, actor.user_id, 'ROLE_GRANTED', 'mt_user_role', targetId, { role });
    for (const role of revoke) await audit(db, actor.user_id, 'ROLE_REVOKED', 'mt_user_role', targetId, { role });
    return { user_id: targetId, testing_roles: [...roles].sort() };
  });
}

// ------------------------------------------------------------------ corrections

const CORRECTION_SELECT = `SELECT k.*, au.name AS added_by_name, o.name AS added_operator_name, du.name AS decided_by_name
  FROM mt_correction k LEFT JOIN users au ON au.user_id = k.added_by LEFT JOIN users du ON du.user_id = k.decided_by
  LEFT JOIN mt_operator o ON o.operator_ref = k.added_operator_ref`;
const correctionJson = (r) => r && ({ ...r, added_at: iso(r.added_at), decided_at: iso(r.decided_at) });

async function listCorrections({ testId, status }) {
  const where = []; const params = [];
  if (testId) { params.push(testId); where.push(`k.test_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`k.status = $${params.length}`); }
  const { rows } = await pool.query(`${CORRECTION_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY k.added_at DESC LIMIT 500`, params);
  return rows.map(correctionJson);
}

async function addCorrection(testId, f, userId) {
  return tx(async (db) => {
    const { rowCount } = await db.query('SELECT 1 FROM mt_test_run WHERE test_id = $1', [testId]);
    if (!rowCount) throw new AdminError(404, 'NOT_FOUND', 'Test run not found');
    for (const [path, ref] of [['corrected_fields.operator_ref', f.corrected_fields.operator_ref], ['operator_ref', f.operator_ref]]) {
      if (ref) {
        const { rowCount: ok } = await db.query('SELECT 1 FROM mt_operator WHERE operator_ref = $1', [ref]);
        if (!ok) throw new AdminError(400, 'UNKNOWN_REFERENCE', 'Unknown operator', { fields: [{ path, msg: 'not in the operator pick-list' }] });
      }
    }
    const { rows: [r] } = await db.query(`INSERT INTO mt_correction (test_id, corrected_fields, reason, added_by, added_operator_ref)
      VALUES ($1, $2, $3, $4, $5) RETURNING correction_id`, [testId, f.corrected_fields, f.reason.trim(), userId, f.operator_ref ?? null]);
    await audit(db, userId, 'CORRECTION_ADDED', 'mt_test_run', testId, { correction_id: r.correction_id, corrected_fields: f.corrected_fields, reason: f.reason }, f.operator_ref ?? null);
    const { rows: [out] } = await db.query(`${CORRECTION_SELECT} WHERE k.correction_id = $1`, [r.correction_id]);
    return correctionJson(out);
  });
}

async function decideCorrection(id, decision, note, userId) {
  return tx(async (db) => {
    const { rows: [k] } = await db.query('SELECT * FROM mt_correction WHERE correction_id = $1 FOR UPDATE', [id]);
    if (!k) throw new AdminError(404, 'NOT_FOUND', 'Correction not found');
    if (k.status !== 'PENDING') throw new AdminError(409, 'LIFECYCLE_CONFLICT', `Correction is already ${k.status}`);
    if (k.added_by === userId) throw new AdminError(409, 'SECOND_PERSON_REQUIRED', 'A correction must be decided by someone other than who added it');
    await db.query(`UPDATE mt_correction SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE correction_id = $1`, [id, decision, userId, note ?? null]);
    await audit(db, userId, 'CORRECTION_DECIDED', 'mt_test_run', k.test_id, { correction_id: id, decision, note: note ?? null });
    const { rows: [out] } = await db.query(`${CORRECTION_SELECT} WHERE k.correction_id = $1`, [id]);
    return correctionJson(out);
  });
}

// ------------------------------------------------------------------ audit and export

async function listAudit({ entity, entityId, limit }) {
  const where = []; const params = [];
  if (entity) { params.push(entity); where.push(`a.entity = $${params.length}`); }
  if (entityId) { params.push(entityId); where.push(`a.entity_id = $${params.length}`); }
  params.push(limit);
  const { rows } = await pool.query(`SELECT a.event_id::float8 AS event_id, a.at, a.actor_user_id, u.name AS actor_name, a.actor_operator_ref, a.action, a.entity, a.entity_id, a.detail
    FROM mt_audit_event a LEFT JOIN users u ON u.user_id = a.actor_user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.event_id DESC LIMIT $${params.length}`, params);
  return rows.map((r) => ({ ...r, at: iso(r.at) }));
}

async function exportSamplesCsv(testId, userId) {
  const { rowCount } = await pool.query('SELECT 1 FROM mt_test_run WHERE test_id = $1', [testId]);
  if (!rowCount) return null;
  const { rows } = await pool.query(`SELECT sample_seq, t_ms, rpm_cmd, rpm_actual, current_a, voltage_v, bemf_v, status_flags
    FROM mt_test_sample WHERE test_id = $1 ORDER BY sample_seq`, [testId]);
  await audit(pool, userId, 'CSV_EXPORTED', 'mt_test_run', testId, { rows: rows.length });
  const head = 'sample_seq,t_ms,rpm_cmd,rpm_actual,current_a,voltage_v,bemf_v,status_flags';
  return [head, ...rows.map((r) => [r.sample_seq, r.t_ms, r.rpm_cmd, r.rpm_actual, r.current_a ?? '', r.voltage_v ?? '', r.bemf_v ?? '', r.status_flags].join(','))].join('\n') + '\n';
}

module.exports = {
  AdminError, KINDS, listProducts, listVariants, getVariant, createVariant, updateVariant,
  listVersions, getVersion, createVersion, updateDraft, deleteDraft, transition,
  listOperatorsAdmin, createOperator, updateOperator, listUsers, setUserRoles,
  listCorrections, addCorrection, decideCorrection, listAudit, exportSamplesCsv,
};
