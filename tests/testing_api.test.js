// Motor-test API end to end against the STAGING database (erp_staging) - never production.
// Creates its own product/variant/profile/criteria/operator, exercises the routes, then removes
// everything it created (staging only: triggers are bypassed for cleanup).
//   npx jest tests/testing_api.test.js
process.env.DB_NAME = 'erp_staging'; // must be set before config/db is loaded

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const pool = require('../config/db');
const testingRoutes = require('../routes/testing');
const { payloadHash, runDigest } = require('../services/testing/digest');

jest.setTimeout(60000);

const FIX = path.join(__dirname, '..', 'docs', 'motor-test', 'contract', 'fixtures');
const fixtureBody = (f) => JSON.parse(JSON.stringify(require(path.join(FIX, f)).request.body));
const uuid4 = () => crypto.randomUUID();
const OPERATOR_USER = 843; // testing@compageauto.com (exists in staging)
const NO_ROLE_USER = 1;    // admin, given no testing role

const app = express(); // same parser order as server.js
app.use('/api/testing', express.json({ limit: '5mb' }));
app.use(express.json({ limit: '40mb' }));
app.use('/api/testing', testingRoutes);
app.use('/api/testing', testingRoutes.errorHandler);

const token = (userId) => jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '10m' });
const T = { op: token(OPERATOR_USER), none: token(NO_ROLE_USER) };
const ids = { tests: [] };
const post = (b, key = b.test_id, tk = T.op) => request(app).post('/api/testing/results').set('Authorization', `Bearer ${tk}`).set('Idempotency-Key', key).send(b);

let base; // a valid body bound to this run's variant/profile/criteria/operator
function newRun(mutate) {
  const b = JSON.parse(JSON.stringify(base));
  b.test_id = uuid4();
  ids.tests.push(b.test_id);
  if (mutate) mutate(b);
  return b;
}

beforeAll(async () => {
  const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
  if (db !== 'erp_staging') throw new Error(`refusing to run against ${db}`);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica'); // no inventory sync triggers for the throwaway product
    const tag = crypto.randomBytes(3).toString('hex');
    ids.product = (await c.query(`INSERT INTO inventory (product_name, product_code) VALUES ($1, $2) RETURNING product_id`, [`JEST-MOTOR-${tag}`, `JSTMO${tag}`])).rows[0].product_id; // product_code must be exactly 11 characters
    await c.query('SET LOCAL session_replication_role = origin');
    ids.variant = (await c.query(`INSERT INTO mt_motor_variant (product_id, code, created_by) VALUES ($1, $2, 1) RETURNING variant_id`, [ids.product, `JEST-${tag}`])).rows[0].variant_id;
    const profileDef = { variant_id: ids.variant, version: 1, max_rpm: 3000, step_rpm: 10, duration_s: 120, sample_hz: 10 };
    const criteriaDef = { schema: 1, variant_id: ids.variant, version: 1, rules: [] };
    ids.profileSha = payloadHash(profileDef);
    ids.criteriaSha = payloadHash(criteriaDef);
    ids.profile = (await c.query(`INSERT INTO mt_profile_version (variant_id, version, max_rpm, step_rpm, duration_s, sample_hz, created_by)
      VALUES ($1,1,3000,10,120,10,1) RETURNING profile_id`, [ids.variant])).rows[0].profile_id;
    ids.criteria = (await c.query(`INSERT INTO mt_criteria_version (variant_id, version, definition, created_by) VALUES ($1,1,$2,1) RETURNING criteria_version_id`,
      [ids.variant, criteriaDef])).rows[0].criteria_version_id;
    for (const [t, col, id, sha] of [['mt_profile_version', 'profile_id', ids.profile, ids.profileSha], ['mt_criteria_version', 'criteria_version_id', ids.criteria, ids.criteriaSha]]) {
      await c.query(`UPDATE ${t} SET status='IN_REVIEW', submitted_at=now() WHERE ${col}=$1`, [id]);
      await c.query(`UPDATE ${t} SET status='PUBLISHED', sha256=$2, approved_by=$3, published_at=now() WHERE ${col}=$1`, [id, sha, OPERATOR_USER]);
    }
    ids.operator = (await c.query(`INSERT INTO mt_operator (name, created_by) VALUES ($1, 1) RETURNING operator_ref`, [`Jest Operator ${tag}`])).rows[0].operator_ref;
    await c.query(`INSERT INTO mt_user_role (user_id, testing_role, granted_by) VALUES ($1,'operator',1), ($1,'viewer',1) ON CONFLICT DO NOTHING`, [OPERATOR_USER]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }

  base = fixtureBody('10-result-valid-completed.json');
  Object.assign(base, {
    motor_serial: `JEST-SN-${crypto.randomBytes(3).toString('hex')}`, variant_id: ids.variant, profile_id: ids.profile, profile_sha256: ids.profileSha,
    criteria_version_id: ids.criteria, criteria_sha256: ids.criteriaSha, operator_id: OPERATOR_USER, operator_ref: ids.operator, operator_name: 'Jest Operator',
  });
});

afterAll(async () => {
  const c = await pool.connect();
  try {
    const { rows: [{ db }] } = await c.query('SELECT current_database() AS db');
    if (db !== 'erp_staging') throw new Error('cleanup refused outside staging');
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica'); // bypass immutability triggers - staging test data only
    await c.query(`DELETE FROM mt_audit_event WHERE entity_id = ANY($1::text[])`, [ids.tests]);
    for (const t of ['mt_upload_receipt', 'mt_test_event', 'mt_test_sample', 'mt_correction', 'mt_test_run']) await c.query(`DELETE FROM ${t} WHERE test_id = ANY($1::uuid[])`, [ids.tests]);
    await c.query('DELETE FROM mt_criteria_version WHERE variant_id = $1', [ids.variant]);
    await c.query('DELETE FROM mt_profile_version WHERE variant_id = $1', [ids.variant]);
    await c.query('DELETE FROM mt_motor_variant WHERE variant_id = $1', [ids.variant]);
    await c.query('DELETE FROM mt_operator WHERE operator_ref = $1', [ids.operator]);
    await c.query(`DELETE FROM mt_user_role WHERE user_id = $1`, [OPERATOR_USER]);
    await c.query('DELETE FROM inventory WHERE product_id = $1', [ids.product]);
    await c.query('COMMIT');
  } finally { c.release(); await pool.end(); }
});

const countRows = async (testId) => (await pool.query(`SELECT (SELECT count(*) FROM mt_test_run WHERE test_id=$1)::int AS runs,
  (SELECT count(*) FROM mt_test_sample WHERE test_id=$1)::int AS samples, (SELECT count(*) FROM mt_upload_receipt WHERE test_id=$1)::int AS receipts`, [testId])).rows[0];

describe('auth and roles (ERP-T01)', () => {
  it('no token -> 401 AUTH_NO_TOKEN', async () => {
    const r = await request(app).get('/api/testing/operators');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('AUTH_NO_TOKEN');
  });
  it('logged in without a testing role -> 403 TESTING_ROLE_REQUIRED (not a re-login code)', async () => {
    const r = await post(newRun(), undefined, T.none);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('TESTING_ROLE_REQUIRED');
  });
  it('/me reports testing roles and token expiry', async () => {
    const r = await request(app).get('/api/testing/me').set('Authorization', `Bearer ${T.op}`);
    expect(r.status).toBe(200);
    expect(r.body.testing_roles).toEqual(['operator', 'viewer']);
    expect(Date.parse(r.body.token_expires_at)).toBeGreaterThan(Date.now());
  });
});

describe('configuration reads', () => {
  it('variant detail returns the published profile and criteria with their hashes', async () => {
    const r = await request(app).get(`/api/testing/variants/${ids.variant}`).set('Authorization', `Bearer ${T.op}`);
    expect(r.status).toBe(200);
    expect(r.body.profile.sha256).toBe(ids.profileSha);
    expect(r.body.criteria.sha256).toBe(ids.criteriaSha);
  });
  it('operator pick-list contains the active operator', async () => {
    const r = await request(app).get('/api/testing/operators').set('Authorization', `Bearer ${T.op}`);
    expect(r.body.items.map((o) => o.operator_ref)).toContain(ids.operator);
  });
});

describe('POST /results', () => {
  let first, firstReceipt;
  it('valid completed run -> 201 with a full receipt (ERP-T03)', async () => {
    first = newRun();
    const r = await post(first);
    expect(r.status).toBe(201);
    firstReceipt = r.body;
    expect(r.body).toMatchObject({ test_id: first.test_id, stored_sample_count: 13, payload_hash: payloadHash(first), samples_digest: first.run_digest, run_digest_match: true });
    expect(await countRows(first.test_id)).toEqual({ runs: 1, samples: 13, receipts: 1 });
  });
  it('identical retry x5 -> 200 with the original receipt, still one run (ERP-T04)', async () => {
    for (let k = 0; k < 5; k++) {
      const r = await post(first);
      expect(r.status).toBe(200);
      expect(r.body).toEqual(firstReceipt);
    }
    expect(await countRows(first.test_id)).toEqual({ runs: 1, samples: 13, receipts: 1 });
  });
  it('two concurrent identical uploads -> one 201 and one 200, one run (ERP-T04)', async () => {
    const b = newRun();
    const statuses = (await Promise.all([post(b), post(b)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 201]);
    expect(await countRows(b.test_id)).toEqual({ runs: 1, samples: 13, receipts: 1 });
  });
  it('same test_id, different payload -> 409, original unchanged, conflict audited (ERP-T05)', async () => {
    const changed = JSON.parse(JSON.stringify(first));
    changed.samples[5].current_a = 2.5;
    changed.run_digest = runDigest(changed.samples);
    const r = await post(changed);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'PAYLOAD_CONFLICT', existing_payload_hash: firstReceipt.payload_hash });
    const { rows: [rc] } = await pool.query('SELECT payload_hash FROM mt_upload_receipt WHERE test_id=$1', [first.test_id]);
    expect(rc.payload_hash).toBe(firstReceipt.payload_hash);
    const { rows: [a] } = await pool.query(`SELECT count(*)::int AS n FROM mt_audit_event WHERE action='UPLOAD_CONFLICT' AND entity_id=$1`, [first.test_id]);
    expect(a.n).toBe(1);
  });
  it('zero-sample FAULT -> 201 and visible in serial lookup (ERP-T06)', async () => {
    const z = fixtureBody('13-result-zero-sample-fault.json');
    const b = newRun((x) => Object.assign(x, { ...z, test_id: x.test_id, motor_serial: base.motor_serial, variant_id: base.variant_id, profile_id: base.profile_id,
      profile_sha256: base.profile_sha256, criteria_version_id: base.criteria_version_id, criteria_sha256: base.criteria_sha256,
      operator_id: base.operator_id, operator_ref: base.operator_ref, operator_name: base.operator_name }));
    const r = await post(b);
    expect(r.status).toBe(201);
    expect(r.body.stored_sample_count).toBe(0);
    const list = await request(app).get(`/api/testing/results?serial=${base.motor_serial}`).set('Authorization', `Bearer ${T.op}`);
    expect(list.body.runs.find((x) => x.test_id === b.test_id)).toMatchObject({ final_state: 'FAULT', outcome: 'INCOMPLETE', stored_sample_count: 0 });
  });
  it.each([
    ['PASS with ABORTED', (b) => { b.final_state = 'ABORTED'; b.stop_reason = 'OPERATOR_STOP'; }, 422, 'INCONSISTENT_RUN'],
    ['PASS with a missing sample', (b) => { b.samples.splice(6, 1); }, 422, 'INCONSISTENT_RUN'],
    ['validity bit 1 but null (V9)', (b) => { b.samples[0].current_a = null; }, 422, 'INCONSISTENT_RUN'],
    ['validity bit 0 but a number (V4)', (b) => { b.samples[0].bemf_v = 12.5; }, 422, 'INCONSISTENT_RUN'],
    ['reserved status bit (V8)', (b) => { b.samples[0].status_flags = 0x0107; }, 400, 'VALIDATION_ERROR'],
    ['wrong unit/type', (b) => { b.samples[3].t_ms = 'three hundred'; }, 400, 'VALIDATION_ERROR'],
    ['unknown operator', (b) => { b.operator_ref = uuid4(); }, 400, 'UNKNOWN_REFERENCE'],
    ['criteria hash mismatch', (b) => { b.criteria_sha256 = 'sha256:' + '0'.repeat(64); }, 400, 'UNKNOWN_REFERENCE'],
  ])('%s -> rejected, nothing stored (ERP-T07)', async (name, mutate, status, code) => {
    const b = newRun(mutate);
    const r = await post(b);
    expect(r.status).toBe(status);
    expect(r.body.code).toBe(code);
    expect(await countRows(b.test_id)).toEqual({ runs: 0, samples: 0, receipts: 0 });
  });
  it('Idempotency-Key different from test_id -> 400', async () => {
    const b = newRun();
    const r = await post(b, uuid4());
    expect(r.status).toBe(400);
    expect(r.body.fields[0].path).toBe('header:Idempotency-Key');
  });
  it('body above 5 MB -> 413 PAYLOAD_TOO_LARGE before any processing', async () => {
    const b = newRun((x) => { x.outcome_reasons = [{ detail: 'x'.repeat(6 * 1024 * 1024) }]; });
    const r = await post(b);
    expect(r.status).toBe(413);
    expect(r.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
  it('malformed JSON -> 400 VALIDATION_ERROR in the contract format', async () => {
    const r = await request(app).post('/api/testing/results').set('Authorization', `Bearer ${T.op}`).set('Content-Type', 'application/json').send('{"test_id":');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('lookup', () => {
  it('run detail returns the stored readings exactly as uploaded, with the versions used', async () => {
    const b = newRun();
    expect((await post(b)).status).toBe(201);
    const r = await request(app).get(`/api/testing/results/${b.test_id}`).set('Authorization', `Bearer ${T.op}`);
    expect(r.status).toBe(200);
    expect(r.body.samples).toEqual(b.samples);
    expect(runDigest(r.body.samples)).toBe(b.run_digest);
    expect(r.body.criteria.sha256).toBe(ids.criteriaSha);
    expect(r.body.uploaded_by).toBe(OPERATOR_USER);
  });
});
