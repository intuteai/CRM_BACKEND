// Motor-test governance API end to end against the STAGING database (erp_staging) - never production.
// Two people: HEAD (user 843 with testing_head/operator/viewer) authors; ADMIN (ERP admin user 1 = testing_admin) approves.
//   npx jest tests/testing_admin_api.test.js
process.env.DB_NAME = 'erp_staging';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const pool = require('../config/db');
const testingRoutes = require('../routes/testing');
const { payloadHash } = require('../services/testing/digest');

jest.setTimeout(90000);

const HEAD = 843;
const ADMIN = 1;
const app = express();
app.use(express.json({ limit: '40mb' }));
app.use('/api/testing', testingRoutes);
app.use('/api/testing', testingRoutes.errorHandler);
const tok = (u, role) => jwt.sign({ user_id: u, role_id: role }, process.env.JWT_SECRET, { expiresIn: '10m' });
const T = { head: tok(HEAD, 9), admin: tok(ADMIN, 1) };
const api = (method, url, who, body) => {
  const r = request(app)[method](`/api/testing${url}`).set('Authorization', `Bearer ${T[who]}`);
  return body === undefined ? r : r.send(body);
};
const started = new Date();
const ids = { entities: [], tests: [] };
let productId; let variant; const tag = crypto.randomBytes(3).toString('hex');

beforeAll(async () => {
  const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
  if (db !== 'erp_staging') throw new Error(`refusing to run against ${db}`);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    productId = (await c.query(`INSERT INTO inventory (product_name, product_code) VALUES ($1, $2) RETURNING product_id`, [`JEST-ADM-${tag}`, `JSTAD${tag}`])).rows[0].product_id;
    await c.query('COMMIT');
  } finally { c.release(); }
  await pool.query(`INSERT INTO mt_user_role (user_id, testing_role, granted_by) VALUES ($1,'testing_head',1),($1,'operator',1),($1,'viewer',1) ON CONFLICT DO NOTHING`, [HEAD]);
});

afterAll(async () => {
  const c = await pool.connect();
  try {
    const { rows: [{ db }] } = await c.query('SELECT current_database() AS db');
    if (db !== 'erp_staging') throw new Error('cleanup refused outside staging');
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(`DELETE FROM mt_audit_event WHERE entity_id = ANY($1::text[]) OR (entity = 'mt_user_role' AND at >= $2)`, [[...ids.entities, ...ids.tests].map(String), started]);
    for (const t of ['mt_correction', 'mt_upload_receipt', 'mt_test_event', 'mt_test_sample', 'mt_test_run']) await c.query(`DELETE FROM ${t} WHERE test_id = ANY($1::uuid[])`, [ids.tests]);
    if (variant) {
      await c.query('DELETE FROM mt_criteria_version WHERE variant_id = $1', [variant.variant_id]);
      await c.query('DELETE FROM mt_profile_version WHERE variant_id = $1', [variant.variant_id]);
      await c.query('DELETE FROM mt_motor_variant WHERE variant_id = $1', [variant.variant_id]);
    }
    await c.query(`DELETE FROM mt_operator WHERE name LIKE $1`, [`Jest Adm ${tag}%`]);
    await c.query('DELETE FROM mt_user_role WHERE user_id = $1', [HEAD]);
    await c.query('DELETE FROM inventory WHERE product_id = $1', [productId]);
    await c.query('COMMIT');
  } finally { c.release(); await pool.end(); }
});

describe('variants', () => {
  it('ERP admin creates a variant linked to a product; /me shows implicit testing_admin', async () => {
    const me = await api('get', '/me', 'admin');
    expect(me.body.testing_roles).toContain('testing_admin');
    const r = await api('post', '/admin/variants', 'admin', { product_id: productId, code: `JEST-${tag}`, max_rpm_limit: 3200, rated_voltage_v: 48 });
    expect(r.status).toBe(201);
    variant = r.body;
    ids.entities.push(variant.variant_id);
    expect(variant).toMatchObject({ product_id: productId, code: `JEST-${tag}`, max_rpm_limit: 3200, rated_voltage_v: 48, active: true, published_profile_version: null });
  });
  it('rejects a second variant for the same product (409 DUPLICATE) and bad input (400)', async () => {
    expect((await api('post', '/admin/variants', 'admin', { product_id: productId, code: `JEST2-${tag}` })).body.code).toBe('DUPLICATE');
    const bad = await api('post', '/admin/variants', 'admin', { product_id: productId, code: '', serial_pattern: '([' });
    expect(bad.status).toBe(400);
    expect(bad.body.fields.map((f) => f.path)).toEqual(expect.arrayContaining(['code', 'serial_pattern']));
  });
  it('operators cannot edit variants (403 TESTING_ROLE_REQUIRED for a user without editor role)', async () => {
    await pool.query(`DELETE FROM mt_user_role WHERE user_id = $1 AND testing_role = 'testing_head'`, [HEAD]);
    const r = await api('patch', `/admin/variants/${variant.variant_id}`, 'head', { max_rpm_limit: 1 });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('TESTING_ROLE_REQUIRED');
    await pool.query(`INSERT INTO mt_user_role (user_id, testing_role, granted_by) VALUES ($1,'testing_head',1)`, [HEAD]);
  });
});

describe('profile lifecycle (ERP-T02)', () => {
  let v1; let v2;
  it('author creates and edits a draft; max_rpm above the variant limit is refused', async () => {
    expect((await api('post', `/admin/variants/${variant.variant_id}/profiles`, 'head', { max_rpm: 9000, step_rpm: 10, duration_s: 120, sample_hz: 10 })).status).toBe(400);
    const r = await api('post', `/admin/variants/${variant.variant_id}/profiles`, 'head', { max_rpm: 3000, step_rpm: 10, duration_s: 120, sample_hz: 10 });
    expect(r.status).toBe(201);
    v1 = r.body; ids.entities.push(v1.profile_id);
    expect(v1).toMatchObject({ version: 1, status: 'DRAFT', sha256: null, created_by: HEAD });
    expect((await api('patch', `/admin/profiles/${v1.profile_id}`, 'head', { sample_hz: 20 })).body.sample_hz).toBe(20);
  });
  it('author cannot approve own version (409 SECOND_PERSON_REQUIRED); a second person publishes with the hash frozen', async () => {
    expect((await api('post', `/admin/profiles/${v1.profile_id}/submit`, 'head')).body.status).toBe('IN_REVIEW');
    const own = await api('post', `/admin/profiles/${v1.profile_id}/approve`, 'head');
    expect(own.status).toBe(409);
    expect(own.body.code).toBe('SECOND_PERSON_REQUIRED');
    const ok = await api('post', `/admin/profiles/${v1.profile_id}/approve`, 'admin');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'PUBLISHED', approved_by: ADMIN });
    expect(ok.body.sha256).toBe(payloadHash({ variant_id: variant.variant_id, version: 1, max_rpm: 3000, step_rpm: 10, duration_s: 120, sample_hz: 20 }));
  });
  it('published versions are frozen: edit and delete are refused (409 LIFECYCLE_CONFLICT)', async () => {
    expect((await api('patch', `/admin/profiles/${v1.profile_id}`, 'head', { sample_hz: 10 })).body.code).toBe('LIFECYCLE_CONFLICT');
    expect((await api('delete', `/admin/profiles/${v1.profile_id}`, 'head')).body.code).toBe('LIFECYCLE_CONFLICT');
  });
  it('publishing v2 supersedes v1; return-to-draft works; withdraw needs a reason', async () => {
    v2 = (await api('post', `/admin/variants/${variant.variant_id}/profiles`, 'head', { max_rpm: 3100, step_rpm: 10, duration_s: 120, sample_hz: 10 })).body;
    ids.entities.push(v2.profile_id);
    expect(v2.version).toBe(2);
    await api('post', `/admin/profiles/${v2.profile_id}/submit`, 'head');
    expect((await api('post', `/admin/profiles/${v2.profile_id}/return`, 'admin', { note: 'check step' })).body.status).toBe('DRAFT');
    await api('post', `/admin/profiles/${v2.profile_id}/submit`, 'head');
    expect((await api('post', `/admin/profiles/${v2.profile_id}/approve`, 'admin')).body.status).toBe('PUBLISHED');
    const list = (await api('get', `/admin/variants/${variant.variant_id}/profiles`, 'head')).body.items;
    expect(list.map((x) => [x.version, x.status])).toEqual([[2, 'PUBLISHED'], [1, 'SUPERSEDED']]);
    expect((await api('post', `/admin/profiles/${v2.profile_id}/withdraw`, 'admin', {})).status).toBe(400);
  });
  it('someone who edited or submitted the draft cannot approve it, even if they are not the author', async () => {
    const v3 = (await api('post', `/admin/variants/${variant.variant_id}/profiles`, 'head', { max_rpm: 3000, step_rpm: 10, duration_s: 120, sample_hz: 10 })).body;
    ids.entities.push(v3.profile_id);
    await api('patch', `/admin/profiles/${v3.profile_id}`, 'admin', { step_rpm: 20 }); // admin edits head's draft
    await api('post', `/admin/profiles/${v3.profile_id}/submit`, 'head');
    const r = await api('post', `/admin/profiles/${v3.profile_id}/approve`, 'admin');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SECOND_PERSON_REQUIRED');
    await api('post', `/admin/profiles/${v3.profile_id}/return`, 'admin');
    await api('delete', `/admin/profiles/${v3.profile_id}`, 'head');
  });
});

describe('criteria and HMI view', () => {
  it('validates rules, publishes, and the HMI sees the published profile + criteria', async () => {
    const bad = await api('post', `/admin/variants/${variant.variant_id}/criteria`, 'head', { definition: { rules: [{ id: 'X', type: 'weird', signal: 'temp' }] } });
    expect(bad.status).toBe(400);
    const def = { schema: 1, units: { current: 'A' }, rules: [{ id: 'I_MAX', type: 'max', signal: 'current_a', limit: null }] };
    const c1 = (await api('post', `/admin/variants/${variant.variant_id}/criteria`, 'head', { definition: def, source_document: 'TEST SHEET (jest)' })).body;
    ids.entities.push(c1.criteria_version_id);
    expect(c1.definition).toEqual({ ...def, variant_id: variant.variant_id, version: 1 });
    await api('post', `/admin/criteria/${c1.criteria_version_id}/submit`, 'head');
    const pub = (await api('post', `/admin/criteria/${c1.criteria_version_id}/approve`, 'admin')).body;
    expect(pub.sha256).toBe(payloadHash(c1.definition));
    const hmi = await api('get', `/variants/${variant.variant_id}`, 'head');
    expect(hmi.status).toBe(200);
    expect(hmi.body.criteria.sha256).toBe(pub.sha256);
    expect(hmi.body.profile.version).toBe(2);
  });
});

describe('operators, roles, corrections, export, audit', () => {
  let op; let run;
  it('editors manage the operator pick-list', async () => {
    op = (await api('post', '/admin/operators', 'head', { name: `Jest Adm ${tag} A` })).body;
    ids.entities.push(op.operator_ref);
    expect(op.active).toBe(true);
    const off = await api('patch', `/admin/operators/${op.operator_ref}`, 'head', { active: false });
    expect(off.body).toMatchObject({ active: false });
    expect(off.body.deactivated_at).not.toBeNull();
    await api('patch', `/admin/operators/${op.operator_ref}`, 'head', { active: true });
  });
  it('only testing_admin manages roles; changes are audited', async () => {
    expect((await api('get', '/admin/users?q=Testing', 'head')).status).toBe(403);
    const users = (await api('get', '/admin/users?q=testing@compageauto', 'admin')).body.items;
    expect(users[0]).toMatchObject({ user_id: HEAD });
    const r = await api('put', `/admin/users/${HEAD}/testing-roles`, 'admin', { roles: ['operator', 'testing_head', 'viewer'] });
    expect(r.body.testing_roles).toEqual(['operator', 'testing_head', 'viewer']);
    expect((await api('put', `/admin/users/${HEAD}/testing-roles`, 'admin', { roles: ['nope'] })).status).toBe(400);
  });
  it('corrections: operator adds, the same person cannot decide, a second person approves; corrected serial is findable', async () => {
    const base = JSON.parse(JSON.stringify(require(path.join(__dirname, '..', 'docs', 'motor-test', 'contract', 'fixtures', '10-result-valid-completed.json')).request.body));
    const hmi = (await api('get', `/variants/${variant.variant_id}`, 'head')).body;
    run = { ...base, test_id: crypto.randomUUID(), motor_serial: `JEST-ADM-${tag}`, variant_id: variant.variant_id, profile_id: hmi.profile.profile_id,
      profile_sha256: hmi.profile.sha256, criteria_version_id: hmi.criteria.criteria_version_id, criteria_sha256: hmi.criteria.sha256,
      operator_id: HEAD, operator_ref: op.operator_ref, operator_name: op.name };
    ids.tests.push(run.test_id);
    const up = await request(app).post('/api/testing/results').set('Authorization', `Bearer ${T.head}`).set('Idempotency-Key', run.test_id).send(run);
    expect(up.status).toBe(201);
    const k = await api('post', `/results/${run.test_id}/corrections`, 'head', { corrected_fields: { motor_serial: `JEST-FIX-${tag}` }, reason: 'serial typo', operator_ref: op.operator_ref });
    expect(k.status).toBe(201);
    expect(k.body).toMatchObject({ status: 'PENDING', added_by: HEAD, added_operator_name: op.name });
    expect((await api('post', `/results/${run.test_id}/corrections`, 'head', { corrected_fields: { outcome: 'FAIL' }, reason: 'x' })).status).toBe(400);
    expect((await api('post', `/corrections/${k.body.correction_id}/decide`, 'head', { decision: 'APPROVED' })).body.code).toBe('SECOND_PERSON_REQUIRED');
    const d = await api('post', `/corrections/${k.body.correction_id}/decide`, 'admin', { decision: 'APPROVED', note: 'checked label' });
    expect(d.body).toMatchObject({ status: 'APPROVED', decided_by: ADMIN });
    expect((await api('post', `/corrections/${k.body.correction_id}/decide`, 'admin', { decision: 'REJECTED' })).body.code).toBe('LIFECYCLE_CONFLICT');
    const found = await api('get', `/results?serial=JEST-FIX-${tag}`, 'head');
    expect(found.body.runs.map((x) => x.test_id)).toContain(run.test_id);
    const stillOriginal = (await api('get', `/results/${run.test_id}`, 'head')).body;
    expect(stillOriginal.motor_serial).toBe(`JEST-ADM-${tag}`); // original record unchanged
  });
  it('CSV export returns every reading and is audited', async () => {
    const r = await api('get', `/results/${run.test_id}/export.csv`, 'head');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    const lines = r.text.trim().split('\n');
    expect(lines[0]).toBe('sample_seq,t_ms,rpm_cmd,rpm_actual,current_a,voltage_v,bemf_v,status_flags');
    expect(lines).toHaveLength(14);
    const audit = (await api('get', `/admin/audit?entity=mt_test_run&entity_id=${run.test_id}`, 'admin')).body.items.map((x) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['RESULT_STORED', 'CORRECTION_ADDED', 'CORRECTION_DECIDED', 'CSV_EXPORTED']));
  });
});
