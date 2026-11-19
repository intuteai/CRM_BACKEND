// Contract v0.4 uploads end to end against the STAGING database (erp_staging) - never production.
// Signs with the published TEST key A (docs/motor-test/contract/vectors/receipt-vectors.json) and checks every
// signed receipt with the reference VCU decision (docs/motor-test/contract/tools/receipt.js).
// Creates its own product/variant/profile/criteria/operator and removes everything afterwards (staging only).
//   npx jest --runInBand tests/testing_v04_api.test.js
process.env.DB_NAME = 'erp_staging'; // must be set before config/db is loaded
const crypto = require('crypto');
const TEST_KEY_A_SEED = crypto.createHash('sha256').update('motor-test receipt TEST key A').digest();
process.env.RECEIPT_SIGNING_SEED = TEST_KEY_A_SEED.toString('base64url');
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
const reference = require('../docs/motor-test/contract/tools/receipt');

jest.setTimeout(60000);

const FIX = path.join(__dirname, '..', 'docs', 'motor-test', 'contract', 'fixtures');
const fixtureBody = (f) => JSON.parse(JSON.stringify(require(path.join(FIX, f)).request.body));
const OPERATOR_USER = 843;
const app = express();
app.use('/api/testing', express.json({ limit: '5mb' }));
app.use('/api/testing', testingRoutes);
app.use('/api/testing', testingRoutes.errorHandler);
const tk = jwt.sign({ user_id: OPERATOR_USER }, process.env.JWT_SECRET, { expiresIn: '10m' });
const post = (b) => request(app).post('/api/testing/results').set('Authorization', `Bearer ${tk}`).set('Idempotency-Key', b.test_id).send(b);
const get = (p) => request(app).get(p).set('Authorization', `Bearer ${tk}`);

const ids = { tests: [] };
const keyA = signer.loadKey();
const KEYRING = [{ key_id: keyA.keyId, public_key: Buffer.from(keyA.publicRaw).toString('base64url') }];
const D_EMPTY = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
let v03base; let v04base;

function v04(mutate) {
  const b = JSON.parse(JSON.stringify(v04base));
  b.test_id = crypto.randomUUID();
  ids.tests.push(b.test_id);
  if (mutate) mutate(b);
  return b;
}
const manifestOf = (b) => ({ test_id: b.test_id, vcu_id: b.vcu.vcu_id, origin_boot_id: b.vcu.origin_boot_id, started: b.started,
  recording_complete: b.recording_complete, final_state: b.final_state, stop_reason: b.stop_reason, sample_count: b.sample_count,
  held_count: b.held_count, run_digest: b.run_digest });
const decide = (receipt, b) => reference.decide(receipt.signed_receipt, KEYRING, manifestOf(b));

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
    ids.product = (await c.query('INSERT INTO inventory (product_name, product_code) VALUES ($1, $2) RETURNING product_id', [`JEST-V04-${tag}`, `JSTV4${tag}`])).rows[0].product_id;
    await c.query('SET LOCAL session_replication_role = origin');
    ids.variant = (await c.query('INSERT INTO mt_motor_variant (product_id, code, created_by) VALUES ($1, $2, 1) RETURNING variant_id', [ids.product, `JEST4-${tag}`])).rows[0].variant_id;
    const profileDef = { variant_id: ids.variant, version: 1, max_rpm: 3000, step_rpm: 10, duration_s: 120, sample_hz: 10 };
    const criteriaDef = { schema: 1, variant_id: ids.variant, version: 1, rules: [] };
    ids.profileSha = payloadHash(profileDef);
    ids.criteriaSha = payloadHash(criteriaDef);
    ids.profile = (await c.query(`INSERT INTO mt_profile_version (variant_id, version, max_rpm, step_rpm, duration_s, sample_hz, created_by)
      VALUES ($1,1,3000,10,120,10,1) RETURNING profile_id`, [ids.variant])).rows[0].profile_id;
    ids.criteria = (await c.query('INSERT INTO mt_criteria_version (variant_id, version, definition, created_by) VALUES ($1,1,$2,1) RETURNING criteria_version_id',
      [ids.variant, criteriaDef])).rows[0].criteria_version_id;
    for (const [t, col, id, sha] of [['mt_profile_version', 'profile_id', ids.profile, ids.profileSha], ['mt_criteria_version', 'criteria_version_id', ids.criteria, ids.criteriaSha]]) {
      await c.query(`UPDATE ${t} SET status='IN_REVIEW', submitted_at=now() WHERE ${col}=$1`, [id]);
      await c.query(`UPDATE ${t} SET status='PUBLISHED', sha256=$2, approved_by=$3, published_at=now() WHERE ${col}=$1`, [id, sha, OPERATOR_USER]);
    }
    ids.operator = (await c.query('INSERT INTO mt_operator (name, created_by) VALUES ($1, 1) RETURNING operator_ref', [`Jest V04 Operator ${tag}`])).rows[0].operator_ref;
    ids.savedRoles = (await c.query('SELECT * FROM mt_user_role WHERE user_id = $1', [OPERATOR_USER])).rows;
    await c.query("INSERT INTO mt_user_role (user_id, testing_role, granted_by) VALUES ($1,'operator',1), ($1,'viewer',1) ON CONFLICT DO NOTHING", [OPERATOR_USER]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }

  v03base = fixtureBody('10-result-valid-completed.json');
  Object.assign(v03base, { motor_serial: `JEST-V04-${crypto.randomBytes(3).toString('hex')}`, variant_id: ids.variant, profile_id: ids.profile,
    profile_sha256: ids.profileSha, criteria_version_id: ids.criteria, criteria_sha256: ids.criteriaSha, operator_id: OPERATOR_USER,
    operator_ref: ids.operator, operator_name: 'Jest V04 Operator' });
  v04base = JSON.parse(JSON.stringify(v03base));
  Object.assign(v04base, {
    contract_version: '0.4', run_kind: 'synthetic', started: true, start_uptime_ms: 1000, started_at_source: 'HMI', ended_at_source: 'HMI',
    hmi_auto_time: true, held_count: v04base.sample_count, recording_complete: true, config_hash: null,
    vcu: { vcu_id: 'esp32c3-001122334455', fw_version: '0.2.8', origin_boot_id: '1122334455667788' },
  });
});

afterAll(async () => {
  const c = await pool.connect();
  try {
    const { rows: [{ db }] } = await c.query('SELECT current_database() AS db');
    if (db !== 'erp_staging') throw new Error('cleanup refused outside staging');
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query('DELETE FROM mt_audit_event WHERE entity_id = ANY($1::text[])', [ids.tests]);
    for (const t of ['mt_upload_receipt', 'mt_test_event', 'mt_test_sample', 'mt_correction', 'mt_test_run']) await c.query(`DELETE FROM ${t} WHERE test_id = ANY($1::uuid[])`, [ids.tests]);
    if (!keyExisted) await c.query('DELETE FROM mt_receipt_key WHERE key_id = $1', [keyA.keyId]); // the TEST key never stays in the registry
    for (const t of ['mt_criteria_version', 'mt_profile_version', 'mt_motor_variant']) await c.query(`DELETE FROM ${t} WHERE variant_id = $1`, [ids.variant]);
    await c.query('DELETE FROM mt_operator WHERE operator_ref = $1', [ids.operator]);
    await c.query('DELETE FROM mt_user_role WHERE user_id = $1', [OPERATOR_USER]);
    await c.query('INSERT INTO mt_user_role SELECT * FROM jsonb_populate_recordset(NULL::mt_user_role, $1)', [JSON.stringify(ids.savedRoles || [])]);
    await c.query('DELETE FROM inventory WHERE product_id = $1', [ids.product]);
    await c.query('COMMIT');
  } finally { c.release(); await pool.end(); }
});

describe('v0.4 uploads with a signed receipt', () => {
  let first; let firstBody;
  it('complete COMPLETED/PASS run -> 201 with a signed receipt the VCU would release', async () => {
    firstBody = v04();
    first = await post(firstBody);
    expect(first.status).toBe(201);
    expect(first.body.signed_receipt).toMatchObject({ alg: 'Ed25519', key_id: keyA.keyId });
    expect(decide(first.body, firstBody)).toEqual({ release: true, reason: 'RELEASE' });
    const msg = reference.decodeMessage(Buffer.from(first.body.signed_receipt.message, 'base64url')).msg;
    expect(msg).toMatchObject({ test_id: firstBody.test_id, receipt_id: first.body.receipt_id, stored_at: first.body.stored_at,
      sample_count: 13, held_count: 13, stored_sample_count: 13, final_state: 'COMPLETED', outcome: 'PASS', flags: 0x0f,
      payload_hash: first.body.payload_hash, samples_digest: first.body.samples_digest, vcu_id: 'esp32c3-001122334455', origin_boot_id: '1122334455667788' });
  });
  it('identical retry -> 200 with the byte-identical receipt and signature', async () => {
    const r = await post(firstBody);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(first.body);
  });
  it('run detail returns the v0.4 fields and the signed receipt', async () => {
    const r = await get(`/api/testing/results/${firstBody.test_id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ contract_version: '0.4', run_kind: 'synthetic', started: true, start_uptime_ms: 1000, held_count: 13,
      recording_complete: true, started_at_source: 'HMI', origin_boot_id: '1122334455667788', vcu: { origin_boot_id: '1122334455667788' } });
    expect(r.body.receipt.signed_receipt).toEqual(first.body.signed_receipt);
  });
  it('CANCEL before START -> 201, zero counts, signed and releasable, never a verdict', async () => {
    const b = v04((x) => Object.assign(x, { started: false, start_uptime_ms: null, started_at: null, started_at_source: null, ended_at: null, ended_at_source: null,
      sample_count: 0, held_count: 0, samples: [], events: [], run_digest: D_EMPTY, final_state: 'ABORTED', stop_reason: 'CONFIG_CANCELLED', outcome: 'INCOMPLETE', outcome_reasons: [] }));
    const r = await post(b);
    expect(r.status).toBe(201);
    expect(decide(r.body, b)).toEqual({ release: true, reason: 'RELEASE' });
  });
  it('known loss (held 3 of 5, recording_complete=false, FAULT/FAULT SAMPLE_LOSS) -> 201; b2 clear; releasable once all held are stored', async () => {
    const b = v04((x) => {
      x.samples = x.samples.slice(0, 3);
      Object.assign(x, { sample_count: 5, held_count: 3, recording_complete: false, run_digest: runDigest(x.samples), final_state: 'FAULT', stop_reason: 'FAULT', fault_code: 'SAMPLE_LOSS', outcome: 'INCOMPLETE' });
    });
    const r = await post(b);
    expect(r.status).toBe(201);
    const msg = reference.decodeMessage(Buffer.from(r.body.signed_receipt.message, 'base64url')).msg;
    expect(msg.flags & 0x04).toBe(0);
    expect(decide(r.body, b)).toEqual({ release: true, reason: 'RELEASE' });
  });
  it('shortfall: VCU holds 3, tablet uploaded 2 -> stored, but the receipt does not release (SHORTFALL)', async () => {
    const b = v04((x) => {
      const held = x.samples.slice(0, 3);
      Object.assign(x, { samples: held.slice(0, 2), sample_count: 5, held_count: 3, recording_complete: false, run_digest: runDigest(held),
        final_state: 'FAULT', stop_reason: 'FAULT', fault_code: 'SAMPLE_LOSS', outcome: 'INCOMPLETE' });
    });
    const r = await post(b);
    expect(r.status).toBe(201);
    expect(decide(r.body, b)).toEqual({ release: false, reason: 'SHORTFALL' });
  });
  it('FAULT / POWER_LOSS / INCOMPLETE -> 201', async () => {
    const b = v04((x) => Object.assign(x, { final_state: 'FAULT', stop_reason: 'POWER_LOSS', fault_code: 'POWER_LOSS', outcome: 'INCOMPLETE' }));
    expect((await post(b)).status).toBe(201);
  });
  it('lookup by serial shows the v0.4 fields', async () => {
    const r = await get(`/api/testing/results?serial=${encodeURIComponent(v04base.motor_serial)}`);
    expect(r.status).toBe(200);
    expect(r.body.runs.find((x) => x.test_id === firstBody.test_id)).toMatchObject({ contract_version: '0.4', run_kind: 'synthetic', held_count: 13, recording_complete: true });
  });
});

describe('v0.4 rejections (nothing stored)', () => {
  const rejected = async (b, status, code, rule) => {
    const r = await post(b);
    expect(r.status).toBe(status);
    expect(r.body.code).toBe(code);
    if (rule) expect(r.body.violations.map((v) => v.rule)).toContain(rule);
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int n FROM mt_test_run WHERE test_id = $1', [b.test_id]);
    expect(n).toBe(0);
    return r;
  };
  it('COMPLETED + HB_LOSS -> 422 LIFECYCLE_STOP_REASON', () => rejected(v04((x) => { x.stop_reason = 'HB_LOSS'; x.outcome = 'INCOMPLETE'; }), 422, 'INCONSISTENT_RUN', 'LIFECYCLE_STOP_REASON'));
  it('ABORTED + POWER_LOSS -> 422 LIFECYCLE_STOP_REASON', () => rejected(v04((x) => Object.assign(x, { final_state: 'ABORTED', stop_reason: 'POWER_LOSS', outcome: 'INCOMPLETE' })), 422, 'INCONSISTENT_RUN', 'LIFECYCLE_STOP_REASON'));
  it('PASS with recording_complete=false -> 422 RECORDING_COMPLETE_REQUIRED', () => rejected(v04((x) => { x.recording_complete = false; }), 422, 'INCONSISTENT_RUN', 'RECORDING_COMPLETE_REQUIRED'));
  it('recording_complete=true with unequal counts -> 422 RECORDING_COMPLETE_COUNTS', () => rejected(v04((x) => {
    x.samples = x.samples.slice(0, 3);
    Object.assign(x, { sample_count: 5, held_count: 3, run_digest: runDigest(x.samples), final_state: 'FAULT', stop_reason: 'FAULT', fault_code: 'SAMPLE_LOSS', outcome: 'INCOMPLETE' });
  }), 422, 'INCONSISTENT_RUN', 'RECORDING_COMPLETE_COUNTS'));
  it('sample beyond held_count -> 422 SEQ_OUT_OF_RANGE', () => rejected(v04((x) => { x.held_count = 12; x.recording_complete = false; x.outcome = 'INCOMPLETE'; }), 422, 'INCONSISTENT_RUN', 'SEQ_OUT_OF_RANGE'));
  it('CONFIG_CANCELLED on a started run -> 422 CANCEL_SHAPE', () => rejected(v04((x) => Object.assign(x, { final_state: 'ABORTED', stop_reason: 'CONFIG_CANCELLED', outcome: 'INCOMPLETE' })), 422, 'INCONSISTENT_RUN', 'CANCEL_SHAPE'));
  it('started_at without its source -> 422 TIME_SOURCE', () => rejected(v04((x) => { x.started_at_source = null; }), 422, 'INCONSISTENT_RUN', 'TIME_SOURCE'));
  it('vcu.boot_id in a v0.4 body -> 400', async () => {
    const r = await rejected(v04((x) => { x.vcu.boot_id = x.vcu.origin_boot_id; delete x.vcu.origin_boot_id; }), 400, 'VALIDATION_ERROR');
    expect(r.body.fields.map((f) => f.path)).toContain('vcu.boot_id');
  });
  it('vcu_id longer than 32 characters -> 400', () => rejected(v04((x) => { x.vcu.vcu_id = 'v'.repeat(33); }), 400, 'VALIDATION_ERROR'));
  it('v0.3 body carrying a v0.4 field -> 400 asking for contract_version', async () => {
    const b = JSON.parse(JSON.stringify(v03base)); b.test_id = crypto.randomUUID(); ids.tests.push(b.test_id); b.held_count = 13;
    const r = await rejected(b, 400, 'VALIDATION_ERROR');
    expect(r.body.fields.find((f) => f.path === 'held_count').msg).toMatch(/contract_version/);
  });
  it('run_kind not allowed on this server -> 422 RUN_KIND_NOT_ALLOWED (production accepts only bench)', async () => {
    process.env.TESTING_ALLOWED_RUN_KINDS = 'bench';
    try { await rejected(v04(), 422, 'RUN_KIND_NOT_ALLOWED'); } finally { delete process.env.TESTING_ALLOWED_RUN_KINDS; }
  });
});

describe('compatibility and key handling', () => {
  it('v0.3 upload still works and its receipt has no signed_receipt', async () => {
    const b = JSON.parse(JSON.stringify(v03base)); b.test_id = crypto.randomUUID(); ids.tests.push(b.test_id);
    const r = await post(b);
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty('signed_receipt');
  });
  it('without a signing key a v0.4 receipt carries signed_receipt: null', async () => {
    const saved = process.env.RECEIPT_SIGNING_SEED;
    delete process.env.RECEIPT_SIGNING_SEED; signer.resetKeyCache();
    try {
      const r = await post(v04());
      expect(r.status).toBe(201);
      expect(r.body.signed_receipt).toBeNull();
    } finally { process.env.RECEIPT_SIGNING_SEED = saved; signer.resetKeyCache(); }
  });
  it('the signing key registered itself (public key only) in mt_receipt_key', async () => {
    const { rows: [k] } = await pool.query('SELECT public_key, retired_at, revoked_at FROM mt_receipt_key WHERE key_id = $1', [keyA.keyId]);
    expect(Buffer.from(k.public_key).equals(keyA.publicRaw)).toBe(true);
    expect(k.retired_at).toBeNull();
  });
});
