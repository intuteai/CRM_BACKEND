// Database access for the motor-test API (tables mt_*; see scripts/migrations/motor-test/001_mt_schema.sql).
// Readings are always read per test through the primary key, never all at once (small RDS instance).
'use strict';
const pool = require('../../config/db');

const iso = (d) => (d ? new Date(d).toISOString() : null);

// ------------------------------------------------------------------ configuration reads

async function listOperators() {
  const { rows } = await pool.query(`SELECT operator_ref, name, active FROM mt_operator WHERE active ORDER BY lower(name)`);
  return rows;
}

async function listVariants({ q, page, pageSize }) {
  const params = [];
  let where = 'WHERE v.active';
  if (q) { params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); where += ` AND (v.code ILIKE $1 OR i.product_name ILIKE $1)`; } // % and _ are literal
  const total = (await pool.query(`SELECT count(*)::int AS n FROM mt_motor_variant v JOIN inventory i ON i.product_id = v.product_id ${where}`, params)).rows[0].n;
  params.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(`
    SELECT v.variant_id, v.code, btrim(i.product_name) AS name, v.product_id, v.active,
           EXISTS (SELECT 1 FROM mt_profile_version p WHERE p.variant_id = v.variant_id AND p.status = 'PUBLISHED')
       AND EXISTS (SELECT 1 FROM mt_criteria_version c WHERE c.variant_id = v.variant_id AND c.status = 'PUBLISHED') AS has_published_config
    FROM mt_motor_variant v JOIN inventory i ON i.product_id = v.product_id
    ${where} ORDER BY v.code LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows, page, page_size: pageSize, total };
}

const profileJson = (p) => p && ({
  profile_id: p.profile_id, variant_id: p.variant_id, version: p.version, max_rpm: p.max_rpm, step_rpm: p.step_rpm,
  duration_s: p.duration_s, sample_hz: p.sample_hz, sha256: p.sha256, status: p.status, published_at: iso(p.published_at),
});
const criteriaJson = (c) => c && ({
  criteria_version_id: c.criteria_version_id, variant_id: c.variant_id, version: c.version, sha256: c.sha256,
  status: c.status, published_at: iso(c.published_at), definition: c.definition,
});

async function getVariantDetail(variantId) {
  const { rows: [v] } = await pool.query(`
    SELECT v.variant_id, v.code, btrim(i.product_name) AS name, v.product_id, v.active, v.serial_pattern, v.max_rpm_limit
    FROM mt_motor_variant v JOIN inventory i ON i.product_id = v.product_id WHERE v.variant_id = $1`, [variantId]);
  if (!v) return null;
  const { rows: [p] } = await pool.query(`SELECT * FROM mt_profile_version WHERE variant_id = $1 AND status = 'PUBLISHED'`, [variantId]);
  const { rows: [c] } = await pool.query(`SELECT * FROM mt_criteria_version WHERE variant_id = $1 AND status = 'PUBLISHED'`, [variantId]);
  return { ...v, profile: profileJson(p) || null, criteria: criteriaJson(c) || null };
}

// Any version that was ever published (PUBLISHED, SUPERSEDED, WITHDRAWN).
async function getCriteriaSnapshot(id) {
  const { rows: [c] } = await pool.query(`SELECT * FROM mt_criteria_version WHERE criteria_version_id = $1 AND status IN ('PUBLISHED','SUPERSEDED','WITHDRAWN')`, [id]);
  return criteriaJson(c) || null;
}

// ------------------------------------------------------------------ result upload

const receiptJson = (r) => ({
  receipt_id: r.receipt_id, test_id: r.test_id, stored_sample_count: r.stored_sample_count, payload_hash: r.payload_hash,
  samples_digest: r.samples_digest, run_digest_match: r.run_digest_match, stored_at: iso(r.first_received_at),
});

async function checkReferences(client, b) {
  const fields = [];
  const bad = (path, msg) => fields.push({ path, msg });
  const { rowCount: variantOk } = await client.query('SELECT 1 FROM mt_motor_variant WHERE variant_id = $1', [b.variant_id]);
  if (!variantOk) bad('variant_id', 'unknown variant');
  for (const [table, idCol, idField, hashField, label] of [
    ['mt_profile_version', 'profile_id', 'profile_id', 'profile_sha256', 'profile'],
    ['mt_criteria_version', 'criteria_version_id', 'criteria_version_id', 'criteria_sha256', 'criteria version'],
  ]) {
    const { rows: [r] } = await client.query(`SELECT variant_id, sha256, status FROM ${table} WHERE ${idCol} = $1`, [b[idField]]);
    if (!r || !['PUBLISHED', 'SUPERSEDED', 'WITHDRAWN'].includes(r.status)) bad(idField, `unknown or never-published ${label}`);
    else {
      if (r.variant_id !== b.variant_id) bad(idField, `${label} belongs to another variant`);
      if (r.sha256 !== b[hashField]) bad(hashField, `does not match ${label} ${b[idField]}`);
    }
  }
  const { rows: [op] } = await client.query('SELECT active, deactivated_at FROM mt_operator WHERE operator_ref = $1', [b.operator_ref]);
  const activeThen = op && (op.active || (b.started_at && op.deactivated_at && new Date(op.deactivated_at) > new Date(b.started_at)));
  if (!activeThen) bad('operator_ref', 'is not an active operator in the pick-list');
  const { rowCount: userOk } = await client.query('SELECT 1 FROM users WHERE user_id = $1', [b.operator_id]);
  if (!userOk) bad('operator_id', 'unknown ERP user');
  return fields;
}

// Atomic, idempotent store. Returns {status, body}.
//   200 identical retry (original receipt) | 201 stored | 409 conflict | 400 unknown reference | 422 inconsistent
async function storeRun({ body: b, payloadHash, samplesDigest, violations, uploadedBy }) {
  const client = await pool.connect();
  let failed;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '10s'`);
    // Serialise concurrent uploads of the same test_id (works before any row exists).
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7319))', [b.test_id]);

    const { rows: [existing] } = await client.query(`
      SELECT r.receipt_id, r.test_id, r.payload_hash, r.first_received_at, t.stored_sample_count, t.samples_digest, t.run_digest_match
      FROM mt_upload_receipt r JOIN mt_test_run t ON t.test_id = r.test_id WHERE r.test_id = $1`, [b.test_id]);
    if (existing) {
      if (existing.payload_hash === payloadHash) {
        await client.query('UPDATE mt_upload_receipt SET attempts = attempts + 1, last_attempt_at = now() WHERE test_id = $1', [b.test_id]);
        await client.query('COMMIT');
        return { status: 200, body: receiptJson(existing) };
      }
      await client.query(`INSERT INTO mt_audit_event (actor_user_id, actor_operator_ref, action, entity, entity_id, detail)
        VALUES ($1, NULL, 'UPLOAD_CONFLICT', 'mt_test_run', $2, $3)`,
        [uploadedBy, b.test_id, { existing_payload_hash: existing.payload_hash, received_payload_hash: payloadHash }]);
      await client.query('COMMIT');
      return { status: 409, body: { error: 'A different result was already stored for this test_id', code: 'PAYLOAD_CONFLICT', test_id: b.test_id, existing_payload_hash: existing.payload_hash, received_payload_hash: payloadHash } };
    }

    const unknown = await checkReferences(client, b);
    if (unknown.length) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'Unknown reference or hash mismatch', code: 'UNKNOWN_REFERENCE', fields: unknown } };
    }
    if (violations.length) {
      await client.query('ROLLBACK');
      return { status: 422, body: { error: 'The run is internally inconsistent', code: 'INCONSISTENT_RUN', violations } };
    }

    await client.query(`INSERT INTO mt_test_run (test_id, motor_serial, variant_id, profile_id, criteria_version_id, operator_id, operator_ref,
        operator_name, uploaded_by, vcu_id, vcu_fw_version, vcu_boot_id, hmi_version, started_at, ended_at, final_state, stop_reason, fault_code,
        outcome, outcome_reasons, sample_count, stored_sample_count, run_digest, samples_digest, run_digest_match)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [b.test_id, b.motor_serial, b.variant_id, b.profile_id, b.criteria_version_id, b.operator_id, b.operator_ref, b.operator_name.trim(),
        uploadedBy, b.vcu.vcu_id, b.vcu.fw_version, b.vcu.boot_id, b.hmi_version, b.started_at, b.ended_at, b.final_state, b.stop_reason,
        b.fault_code, b.outcome, JSON.stringify(b.outcome_reasons), b.sample_count, b.samples.length, b.run_digest, samplesDigest,
        samplesDigest === b.run_digest]);

    if (b.samples.length) {
      const col = (k, f = (x) => x) => b.samples.map((s) => f(s[k]));
      // Insert exactly the float32 value that was hashed (round once, in JS), -0.0 as +0.0.
      const z = (x) => (x === null ? null : (Object.is(Math.fround(x), -0) ? 0 : Math.fround(x)));
      await client.query(`INSERT INTO mt_test_sample (test_id, sample_seq, t_ms, rpm_cmd, rpm_actual, current_a, voltage_v, bemf_v, status_flags)
        SELECT $1, * FROM unnest($2::bigint[], $3::bigint[], $4::int[], $5::int[], $6::real[], $7::real[], $8::real[], $9::smallint[])`,
        [b.test_id, col('sample_seq'), col('t_ms'), col('rpm_cmd'), col('rpm_actual'), col('current_a', z), col('voltage_v', z), col('bemf_v', z), col('status_flags')]);
    }
    if (b.events.length) {
      await client.query(`INSERT INTO mt_test_event (test_id, event_seq, t_ms, type, code, detail)
        SELECT $1, * FROM unnest($2::int[], $3::bigint[], $4::text[], $5::text[], $6::text[])`,
        [b.test_id, b.events.map((_, i) => i), b.events.map((e) => e.t_ms), b.events.map((e) => e.type), b.events.map((e) => e.code), b.events.map((e) => e.detail ?? null)]);
    }
    const { rows: [rc] } = await client.query(`INSERT INTO mt_upload_receipt (test_id, payload_hash) VALUES ($1, $2)
      RETURNING receipt_id, test_id, payload_hash, first_received_at`, [b.test_id, payloadHash]);
    await client.query(`INSERT INTO mt_audit_event (actor_user_id, actor_operator_ref, action, entity, entity_id, detail)
      VALUES ($1, $2, 'RESULT_STORED', 'mt_test_run', $3, $4)`,
      [uploadedBy, b.operator_ref, b.test_id, { outcome: b.outcome, final_state: b.final_state, stored_sample_count: b.samples.length }]);
    await client.query('COMMIT');
    return { status: 201, body: receiptJson({ ...rc, stored_sample_count: b.samples.length, samples_digest: samplesDigest, run_digest_match: samplesDigest === b.run_digest }) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    failed = e;
    throw e;
  } finally {
    client.release(failed); // a broken connection is discarded, not returned to the pool
  }
}

// ------------------------------------------------------------------ lookup

async function listRunsBySerial(serial) {
  const { rows } = await pool.query(`
    SELECT t.test_id, t.started_at, t.ended_at, t.final_state, t.outcome, t.operator_id, t.operator_ref, t.operator_name, t.uploaded_by,
           v.code AS variant_code, p.version AS profile_version, c.version AS criteria_version, t.sample_count, t.stored_sample_count, t.received_at
    FROM mt_test_run t
    JOIN mt_motor_variant v ON v.variant_id = t.variant_id
    JOIN mt_profile_version p ON p.profile_id = t.profile_id
    JOIN mt_criteria_version c ON c.criteria_version_id = t.criteria_version_id
    WHERE t.motor_serial = $1
       OR EXISTS (SELECT 1 FROM mt_correction k WHERE k.test_id = t.test_id AND k.status = 'APPROVED' AND k.corrected_fields->>'motor_serial' = $1)
    ORDER BY t.started_at DESC NULLS LAST, t.received_at DESC LIMIT 500`, [serial]);
  return rows.map((r) => ({ ...r, started_at: iso(r.started_at), ended_at: iso(r.ended_at), received_at: iso(r.received_at) }));
}

async function getRun(testId, { offset, limit }) {
  const { rows: [t] } = await pool.query(`SELECT t.*, v.code AS variant_code FROM mt_test_run t
    JOIN mt_motor_variant v ON v.variant_id = t.variant_id WHERE t.test_id = $1`, [testId]);
  if (!t) return null;
  // Sequential on purpose: the pool is small and shared with the whole ERP.
  // `real` comes back as PostgreSQL's shortest exact text (PG >= 12), so readings rebuild the same digest.
  const samples = await pool.query(`SELECT sample_seq::float8 AS sample_seq, t_ms::float8 AS t_ms, rpm_cmd, rpm_actual, current_a, voltage_v, bemf_v, status_flags
                FROM mt_test_sample WHERE test_id = $1 ORDER BY sample_seq OFFSET $2 LIMIT $3`, [testId, offset, limit]);
  const events = await pool.query('SELECT t_ms::float8 AS t_ms, type, code, detail FROM mt_test_event WHERE test_id = $1 ORDER BY event_seq', [testId]);
  const receipt = await pool.query('SELECT receipt_id, test_id, payload_hash, first_received_at FROM mt_upload_receipt WHERE test_id = $1', [testId]);
  const profile = await pool.query('SELECT * FROM mt_profile_version WHERE profile_id = $1', [t.profile_id]);
  const criteria = await pool.query('SELECT * FROM mt_criteria_version WHERE criteria_version_id = $1', [t.criteria_version_id]);
  return {
    test_id: t.test_id, motor_serial: t.motor_serial, variant_id: t.variant_id, variant_code: t.variant_code, profile_id: t.profile_id, criteria_version_id: t.criteria_version_id,
    operator_id: t.operator_id, operator_ref: t.operator_ref, operator_name: t.operator_name, uploaded_by: t.uploaded_by,
    vcu: { vcu_id: t.vcu_id, fw_version: t.vcu_fw_version, boot_id: t.vcu_boot_id }, hmi_version: t.hmi_version,
    started_at: iso(t.started_at), ended_at: iso(t.ended_at), final_state: t.final_state, stop_reason: t.stop_reason, fault_code: t.fault_code,
    outcome: t.outcome, outcome_reasons: t.outcome_reasons, sample_count: t.sample_count, run_digest: t.run_digest, received_at: iso(t.received_at),
    receipt: receipt.rows[0] && receiptJson({ ...receipt.rows[0], stored_sample_count: t.stored_sample_count, samples_digest: t.samples_digest, run_digest_match: t.run_digest_match }),
    profile: profileJson(profile.rows[0]), criteria: criteriaJson(criteria.rows[0]),
    events: events.rows,
    samples: samples.rows,
    samples_page: { offset, limit, returned: samples.rowCount, total: t.stored_sample_count },
  };
}

module.exports = { listOperators, listVariants, getVariantDetail, getCriteriaSnapshot, storeRun, listRunsBySerial, getRun };
