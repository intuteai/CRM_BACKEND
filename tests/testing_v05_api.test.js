// Contract v0.5 uploads end to end against the STAGING database (erp_staging) - never production.
// Every case of docs/motor-test/contract/vectors/v05-event-vectors.json is uploaded through the real route; accepted cases
// get an MTRCPT2 receipt (signed with the published TEST key A) that the reference VCU decision checks.
//   npx jest --runInBand tests/testing_v05_api.test.js
process.env.DB_NAME = 'erp_staging';
const crypto = require('crypto');
process.env.RECEIPT_SIGNING_SEED = crypto.createHash('sha256').update('motor-test receipt TEST key A').digest().toString('base64url');
delete process.env.TESTING_ALLOWED_RUN_KINDS;

const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const pool = require('../config/db');
const testingRoutes = require('../routes/testing');
const { payloadHash, runDigest } = require('../services/testing/digest');
const signer = require('../services/testing/receiptSigner');
const refV1 = require('../docs/motor-test/contract/tools/receipt');
const refV2 = require('../docs/motor-test/contract/tools/receipt_v2');
const VECTORS = require('../docs/motor-test/contract/vectors/v05-event-vectors.json').cases;

jest.setTimeout(120000);
const OPERATOR_USER = 843;
const app = express();
app.use('/api/testing', express.json({ limit: '5mb' }));
app.use('/api/testing', testingRoutes);
app.use('/api/testing', testingRoutes.errorHandler);
const tk = jwt.sign({ user_id: OPERATOR_USER }, process.env.JWT_SECRET, { expiresIn: '10m' });
const post = (b) => request(app).post('/api/testing/results').set('Authorization', `Bearer ${tk}`).set('Idempotency-Key', b.test_id).send(b);
const get = (p) => request(app).get(p).set('Authorization', `Bearer ${tk}`);
const keyA = signer.loadKey();
const KEYRING = [{ key_id: keyA.keyId, public_key: Buffer.from(keyA.publicRaw).toString('base64url') }];
const ids = { tests: [] };
let base;

// Full v0.5 body for a vector: the vector's v0.5 fields + readings built from its run_context.
function bodyFor(c) {
  const r = c.run_context; const e = c.v05_fields;
  const samples = r.samples.map((s) => ({ sample_seq: s.sample_seq, t_ms: s.t_ms, rpm_cmd: s.rpm_cmd, rpm_actual: Math.max(0, s.rpm_cmd - 3),
    current_a: 1.5, voltage_v: 400, bemf_v: null, status_flags: s.status_flags }));
  const b = JSON.parse(JSON.stringify(base));
  b.test_id = crypto.randomUUID(); ids.tests.push(b.test_id);
  b.motor_serial = `JEST-V05-${c.id}`;
  Object.assign(b, { contract_version: '0.5', samples, run_digest: runDigest(samples), events: [], outcome_reasons: [],
    capture_end_ms: e.capture_end_ms, event_log: e.event_log, warnings: e.warnings, command_changes: e.command_changes, event_digest: e.event_digest });
  if (!r.started) {
    Object.assign(b, { started: false, start_uptime_ms: null, started_at: null, started_at_source: null, ended_at: null, ended_at_source: null,
      sample_count: 0, held_count: 0, recording_complete: true, final_state: 'ABORTED', stop_reason: 'CONFIG_CANCELLED', outcome: 'INCOMPLETE' });
  } else {
    const lost = r.held_count < 10; // E7: 10 declared, 5 held
    Object.assign(b, { started: true, start_uptime_ms: r.start_uptime_ms, sample_count: lost ? 10 : r.held_count, held_count: r.held_count,
      recording_complete: !lost, final_state: lost ? 'FAULT' : 'COMPLETED', stop_reason: lost ? 'FAULT' : 'RAMP_COMPLETE',
      fault_code: lost ? 'SAMPLE_LOSS' : null, outcome: 'INCOMPLETE' });
  }
  return b;
}
const manifestOf = (b) => ({ receipt_version: 2, test_id: b.test_id, vcu_id: b.vcu.vcu_id, origin_boot_id: b.vcu.origin_boot_id, started: b.started,
  recording_complete: b.recording_complete, final_state: b.final_state, stop_reason: b.stop_reason, sample_count: b.sample_count, held_count: b.held_count,
  run_digest: b.run_digest, event_digest: b.event_digest, warnings_count: b.warnings.length, command_changes_count: b.command_changes.length,
  event_log_complete: b.event_log.complete, capture_end_ms: b.capture_end_ms, start_uptime_ms: b.started ? b.start_uptime_ms : null });

let keyExisted;
beforeAll(async () => {
  const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
  if (db !== 'erp_staging') throw new Error(`refusing to run against ${db}`);
  keyExisted = (await pool.query('SELECT 1 FROM mt_receipt_key WHERE key_id = $1', [keyA.keyId])).rowCount > 0;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    const tag = crypto.randomBytes(3).toString('hex');
    ids.product = (await c.query('INSERT INTO inventory (product_name, product_code) VALUES ($1, $2) RETURNING product_id', [`JEST-V05-${tag}`, `JSTV5${tag}`])).rows[0].product_id;
    await c.query('SET LOCAL session_replication_role = origin');
    ids.variant = (await c.query('INSERT INTO mt_motor_variant (product_id, code, created_by) VALUES ($1, $2, 1) RETURNING variant_id', [ids.product, `JEST5-${tag}`])).rows[0].variant_id;
    const profileDef = { variant_id: ids.variant, version: 1, max_rpm: 3000, step_rpm: 10, duration_s: 120, sample_hz: 10 };
    const criteriaDef = { schema: 1, variant_id: ids.variant, version: 1, rules: [] };
    ids.profileSha = payloadHash(profileDef); ids.criteriaSha = payloadHash(criteriaDef);
    ids.profile = (await c.query(`INSERT INTO mt_profile_version (variant_id, version, max_rpm, step_rpm, duration_s, sample_hz, created_by)
      VALUES ($1,1,3000,10,120,10,1) RETURNING profile_id`, [ids.variant])).rows[0].profile_id;
    ids.criteria = (await c.query('INSERT INTO mt_criteria_version (variant_id, version, definition, created_by) VALUES ($1,1,$2,1) RETURNING criteria_version_id', [ids.variant, criteriaDef])).rows[0].criteria_version_id;
    for (const [t, col, id, sha] of [['mt_profile_version', 'profile_id', ids.profile, ids.profileSha], ['mt_criteria_version', 'criteria_version_id', ids.criteria, ids.criteriaSha]]) {
      await c.query(`UPDATE ${t} SET status='IN_REVIEW', submitted_at=now() WHERE ${col}=$1`, [id]);
      await c.query(`UPDATE ${t} SET status='PUBLISHED', sha256=$2, approved_by=$3, published_at=now() WHERE ${col}=$1`, [id, sha, OPERATOR_USER]);
    }
    ids.operator = (await c.query('INSERT INTO mt_operator (name, created_by) VALUES ($1, 1) RETURNING operator_ref', [`Jest V05 Operator ${tag}`])).rows[0].operator_ref;
    ids.savedRoles = (await c.query('SELECT * FROM mt_user_role WHERE user_id = $1', [OPERATOR_USER])).rows;
    await c.query("INSERT INTO mt_user_role (user_id, testing_role, granted_by) VALUES ($1,'operator',1) ON CONFLICT DO NOTHING", [OPERATOR_USER]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  base = {
    test_id: null, motor_serial: null, variant_id: ids.variant, profile_id: ids.profile, profile_sha256: ids.profileSha,
    criteria_version_id: ids.criteria, criteria_sha256: ids.criteriaSha, operator_id: OPERATOR_USER, operator_ref: ids.operator, operator_name: 'Jest V05 Operator',
    vcu: { vcu_id: 'esp32c3-001122334455', fw_version: '0.2.17', origin_boot_id: '1122334455667788' }, hmi_version: '1.0.0',
    started_at: '2026-11-21T10:00:00Z', ended_at: '2026-11-21T10:00:01Z', fault_code: null, run_kind: 'synthetic',
    started_at_source: 'HMI', ended_at_source: 'HMI', hmi_auto_time: true, config_hash: null,
  };
});

afterAll(async () => {
  const c = await pool.connect();
  try {
    const { rows: [{ db }] } = await c.query('SELECT current_database() AS db');
    if (db !== 'erp_staging') throw new Error('cleanup refused outside staging');
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query('DELETE FROM mt_audit_event WHERE entity_id = ANY($1::text[])', [ids.tests]);
    for (const t of ['mt_upload_receipt', 'mt_test_event', 'mt_test_sample', 'mt_test_warning_event', 'mt_test_command_change', 'mt_correction', 'mt_test_run']) {
      await c.query(`DELETE FROM ${t} WHERE test_id = ANY($1::uuid[])`, [ids.tests]);
    }
    if (!keyExisted) await c.query('DELETE FROM mt_receipt_key WHERE key_id = $1', [keyA.keyId]);
    for (const t of ['mt_criteria_version', 'mt_profile_version', 'mt_motor_variant']) await c.query(`DELETE FROM ${t} WHERE variant_id = $1`, [ids.variant]);
    await c.query('DELETE FROM mt_operator WHERE operator_ref = $1', [ids.operator]);
    await c.query('DELETE FROM mt_user_role WHERE user_id = $1', [OPERATOR_USER]);
    await c.query('INSERT INTO mt_user_role SELECT * FROM jsonb_populate_recordset(NULL::mt_user_role, $1)', [JSON.stringify(ids.savedRoles || [])]);
    await c.query('DELETE FROM inventory WHERE product_id = $1', [ids.product]);
    await c.query('COMMIT');
  } finally { c.release(); await pool.end(); }
});

describe('every v0.5 vector through the real upload route', () => {
  it.each(VECTORS.map((c) => [c.id, c]))('%s', async (_id, c) => {
    const b = bodyFor(c);
    const r = await post(b);
    if (c.expected.result === 'rejected') {
      expect(r.status).toBe(c.expected.status);
      if (c.expected.status === 422) expect(r.body.violations.map((v) => v.rule)).toContain(c.expected.rule);
      else expect(r.body.fields.find((f) => f.path === 'events').msg).toMatch(new RegExp(`^${c.expected.rule}:`));
      expect((await pool.query('SELECT count(*)::int n FROM mt_test_run WHERE test_id = $1', [b.test_id])).rows[0].n).toBe(0);
      return;
    }
    expect(r.status).toBe(201);
    expect(r.body.signed_receipt.key_id).toBe(keyA.keyId);
    const msg = Buffer.from(r.body.signed_receipt.message, 'base64url');
    expect(msg.subarray(0, 8).toString('latin1')).toBe('MTRCPT2\0');
    const decision = refV2.decideV2(r.body.signed_receipt, KEYRING, manifestOf(b));
    expect(decision.reason).toBe(c.expected.flags.event_digest_match ? 'RELEASE' : 'EVENT_DIGEST_MISMATCH');
    const detail = (await get(`/api/testing/results/${b.test_id}`)).body;
    expect(detail).toMatchObject({ contract_version: '0.5', receipt_version: 2, capture_end_ms: b.capture_end_ms, event_digest: b.event_digest,
      events_stored_digest: c.expected.recomputed_event_digest, event_digest_match: c.expected.flags.event_digest_match,
      b6_coverage_ok: c.expected.flags.b6_coverage_ok, unproven: c.expected.flags.unproven });
    expect(detail.warnings).toEqual(b.warnings.map(({ seq, t_ms, phase, kind, source, limit_id, code, status_t_ms, reason, restored_state, detail: d }) =>
      ({ seq, t_ms, phase, kind, source, limit_id, code, status_t_ms, reason, restored_state, detail: d })));
    expect(detail.command_changes).toEqual(b.command_changes);
  });
});

describe('v0.5 receipt behaviour', () => {
  const e1 = VECTORS.find((c) => c.id === 'E1');
  it('identical retry -> 200 with the byte-identical MTRCPT2 receipt', async () => {
    const b = bodyFor(e1);
    const first = await post(b);
    const again = await post(b);
    expect(first.status).toBe(201); expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
  });
  it('version pin: an MTRCPT2 receipt is never accepted by the v1 decider, and a v0.5 manifest rejects v1', async () => {
    const b = bodyFor(e1);
    const r = await post(b);
    expect(refV1.decide(r.body.signed_receipt, KEYRING, { ...manifestOf(b), receipt_version: 2 }).release).toBe(false);
    expect(refV2.decideV2(r.body.signed_receipt, KEYRING, { ...manifestOf(b), receipt_version: 1 }).reason).toBe('RECEIPT_VERSION_MISMATCH');
  });
  it('a v0.4 upload still gets MTRCPT1 and receipt_version 1', async () => {
    const b = bodyFor(e1);
    for (const k of ['capture_end_ms', 'event_log', 'warnings', 'command_changes', 'event_digest']) delete b[k];
    b.contract_version = '0.4';
    const r = await post(b);
    expect(r.status).toBe(201);
    expect(Buffer.from(r.body.signed_receipt.message, 'base64url').subarray(0, 8).toString('latin1')).toBe('MTRCPT1\0');
    expect((await get(`/api/testing/results/${b.test_id}`)).body.receipt_version).toBe(1);
  });
  it('a v0.5 field without contract_version 0.5 -> 400 naming the version', async () => {
    const b = bodyFor(e1); b.contract_version = '0.4';
    const r = await post(b);
    expect(r.status).toBe(400);
    expect(r.body.fields.find((f) => f.path === 'warnings').msg).toMatch(/0\.5/);
  });
  it('serial lookup shows event-log completeness and unproven count', async () => {
    const g1 = VECTORS.find((c) => c.id === 'G1');
    const b = bodyFor(g1);
    expect((await post(b)).status).toBe(201);
    const row = (await get(`/api/testing/results?serial=${encodeURIComponent(b.motor_serial)}`)).body.runs.find((x) => x.test_id === b.test_id);
    expect(row).toMatchObject({ contract_version: '0.5', event_log_complete: false, unproven_count: 1 });
  });
});
