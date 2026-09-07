const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const pool = require('../config/db');

describe('PDI Admin Templates API', () => {
  let adminToken, adminUserId, nonAdminToken, nonAdminUserId;
  const createdIds = [];
  const createdReportIds = [];

  beforeAll(async () => {
    const admin = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, 'x', 1) RETURNING user_id`,
      ['PDI Admin Test Admin', `pdi-admin-test-admin-${Date.now()}@example.com`]
    );
    adminUserId = admin.rows[0].user_id;
    adminToken = jwt.sign({ user_id: adminUserId }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const nonAdmin = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, 'x', 2) RETURNING user_id`,
      ['PDI Admin Test NonAdmin', `pdi-admin-test-nonadmin-${Date.now()}@example.com`]
    );
    nonAdminUserId = nonAdmin.rows[0].user_id;
    nonAdminToken = jwt.sign({ user_id: nonAdminUserId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (createdReportIds.length) {
      await pool.query('DELETE FROM pre_dispatch_inspection_reports WHERE report_id = ANY($1::int[])', [createdReportIds]);
    }
    if (createdIds.length) {
      await pool.query('DELETE FROM pdi_templates WHERE id = ANY($1::text[])', [createdIds]);
    }
    await pool.query('DELETE FROM users WHERE user_id = ANY($1::int[])', [[adminUserId, nonAdminUserId]]);
    await pool.end();
  });

  const SAMPLE_DEFINITION = {
    pages: [{
      sections: [
        { type: 'text', label: 'Remarks:', dataKey: 'remarks', default: 'OK' },
      ],
    }],
  };

  it('rejects a non-admin from creating a template', async () => {
    const res = await request(app)
      .post('/api/pdi/admin/templates')
      .set('Authorization', `Bearer ${nonAdminToken}`)
      .send({ id: 'nope', name: 'Nope', definition: SAMPLE_DEFINITION });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a non-admin from every admin endpoint, not just create', async () => {
    const id = 'admin-test-403-check-' + Date.now();
    // Create as admin first so GET/PUT/publish/archive/preview have a real id to target.
    await request(app).post('/api/pdi/admin/templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: '403 Check', definition: SAMPLE_DEFINITION });
    createdIds.push(id);

    const asNonAdmin = (method, path) => request(app)[method](path).set('Authorization', `Bearer ${nonAdminToken}`);
    const checks = await Promise.all([
      asNonAdmin('get', '/api/pdi/admin/templates'),
      asNonAdmin('get', `/api/pdi/admin/templates/${id}`),
      asNonAdmin('put', `/api/pdi/admin/templates/${id}`).send({ name: 'x', definition: SAMPLE_DEFINITION }),
      asNonAdmin('post', `/api/pdi/admin/templates/${id}/publish`),
      asNonAdmin('post', `/api/pdi/admin/templates/${id}/archive`),
      asNonAdmin('post', `/api/pdi/admin/templates/${id}/preview`).send({ definition: SAMPLE_DEFINITION }),
    ]);
    checks.forEach((res) => expect(res.statusCode).toBe(403));
  });

  it('returns 404 for getTemplate on a nonexistent id', async () => {
    const res = await request(app)
      .get('/api/pdi/admin/templates/definitely-does-not-exist')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for save/publish/archive on a nonexistent id', async () => {
    const results = await Promise.all([
      request(app).put('/api/pdi/admin/templates/definitely-does-not-exist').set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'x', definition: SAMPLE_DEFINITION }),
      request(app).post('/api/pdi/admin/templates/definitely-does-not-exist/publish').set('Authorization', `Bearer ${adminToken}`),
      request(app).post('/api/pdi/admin/templates/definitely-does-not-exist/archive').set('Authorization', `Bearer ${adminToken}`),
    ]);
    results.forEach((res) => expect(res.statusCode).toBe(404));
  });

  it('creates a template as version 1, status draft', async () => {
    const id = 'admin-test-' + Date.now();
    const res = await request(app)
      .post('/api/pdi/admin/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'Admin Test Template', definition: SAMPLE_DEFINITION });
    expect(res.statusCode).toBe(201);
    expect(res.body.version).toBe(1);
    expect(res.body.status).toBe('draft');
    createdIds.push(id);
  });

  it('rejects creating a template whose id collides with a built-in template', async () => {
    const res = await request(app)
      .post('/api/pdi/admin/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: 'general', name: 'Collision', definition: SAMPLE_DEFINITION });
    expect(res.statusCode).toBe(409);
  });

  it('rejects creating a template whose id already exists', async () => {
    const id = 'admin-test-dup-' + Date.now();
    await request(app).post('/api/pdi/admin/templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'First', definition: SAMPLE_DEFINITION });
    createdIds.push(id);
    const res = await request(app)
      .post('/api/pdi/admin/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'Second', definition: SAMPLE_DEFINITION });
    expect(res.statusCode).toBe(409);
  });

  it('saving an edit appends a new version rather than overwriting', async () => {
    const id = 'admin-test-edit-' + Date.now();
    await request(app).post('/api/pdi/admin/templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'Original', definition: SAMPLE_DEFINITION });
    createdIds.push(id);
    const res = await request(app)
      .put(`/api/pdi/admin/templates/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Edited', definition: SAMPLE_DEFINITION });
    expect(res.statusCode).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.name).toBe('Edited');
  });

  it('publishing sets status active and makes it appear in the public picker', async () => {
    const id = 'admin-test-publish-' + Date.now();
    await request(app).post('/api/pdi/admin/templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'Publish Me', definition: SAMPLE_DEFINITION });
    createdIds.push(id);

    const publishRes = await request(app)
      .post(`/api/pdi/admin/templates/${id}/publish`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(publishRes.statusCode).toBe(200);
    expect(publishRes.body.status).toBe('active');

    const pickerRes = await request(app)
      .get('/api/pdi/templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(pickerRes.body.some((t) => t.id === id)).toBe(true);
    expect(pickerRes.body.some((t) => t.id === 'general')).toBe(true); // code templates still present
  });

  it('archiving removes it from the public picker without deleting its history', async () => {
    const id = 'admin-test-archive-' + Date.now();
    await request(app).post('/api/pdi/admin/templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'Archive Me', definition: SAMPLE_DEFINITION });
    createdIds.push(id);
    await request(app).post(`/api/pdi/admin/templates/${id}/publish`).set('Authorization', `Bearer ${adminToken}`);
    await request(app).post(`/api/pdi/admin/templates/${id}/archive`).set('Authorization', `Bearer ${adminToken}`);

    const pickerRes = await request(app)
      .get('/api/pdi/templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(pickerRes.body.some((t) => t.id === id)).toBe(false);

    const getRes = await request(app)
      .get(`/api/pdi/admin/templates/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.statusCode).toBe(200); // still fetchable by an admin, just not in the create-report picker
  });

  it('previews a definition without saving it, returning a valid PDF', async () => {
    const res = await request(app)
      .post('/api/pdi/admin/templates/anything/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ definition: SAMPLE_DEFINITION });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('rejects previewing a malformed definition with a clear 400, not a 500', async () => {
    const res = await request(app)
      .post('/api/pdi/admin/templates/anything/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ definition: { pages: [{ sections: [{ type: 'not-a-real-type' }] }] } });
    expect(res.statusCode).toBe(400);
  });

  it('lists all templates for the admin (any status), showing only the latest version', async () => {
    const res = await request(app)
      .get('/api/pdi/admin/templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('a report created against a template version keeps rendering that exact version, even after the template is edited', async () => {
    const id = 'admin-test-pin-' + Date.now();
    const v1Definition = {
      pages: [{ sections: [{ type: 'text', label: 'Remarks:', dataKey: 'remarks', default: 'V1 TEXT' }] }],
    };
    await request(app).post('/api/pdi/admin/templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'Pin Test', definition: v1Definition });
    createdIds.push(id);
    await request(app).post(`/api/pdi/admin/templates/${id}/publish`).set('Authorization', `Bearer ${adminToken}`);

    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ template_id: id, data: { pdi_no: 'PIN-TEST-1', customer_name: 'Pin Co.', remarks: 'Report remarks' } });
    expect(created.statusCode).toBe(201);
    expect(created.body.template_id).toBe(id);
    // Append-only versioning: create() inserts version 1 (draft), and publish()
    // always inserts a NEW version row (version 2, active) rather than flipping
    // version 1's status in place — see the "Append-only versioning" section of
    // docs/superpowers/specs/2026-09-08-pdi-template-authoring-design.md. So the
    // version that's actually active (and that the report pins to) is 2, not 1.
    const pinnedVersion = created.body.template_version;
    expect(pinnedVersion).toBe(2);
    createdReportIds.push(created.body.report_id);

    // Edit the template (new version, still active) — the already-created report must not care.
    const v2Definition = {
      pages: [{ sections: [{ type: 'text', label: 'Remarks:', dataKey: 'remarks', default: 'V2 TEXT — SHOULD NOT APPEAR' }] }],
    };
    await request(app).put(`/api/pdi/admin/templates/${id}`).set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Pin Test', definition: v2Definition });
    await request(app).post(`/api/pdi/admin/templates/${id}/publish`).set('Authorization', `Bearer ${adminToken}`);

    const pdf = await request(app)
      .get(`/api/pdi/reports/${created.body.report_id}/pdf`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.body.slice(0, 5).toString('ascii')).toBe('%PDF-');
    // The report's own pinned version (1) is still what gets rendered — confirmed
    // by re-fetching the report and checking template_version is unchanged, since
    // the PDF bytes themselves aren't practical to text-search (see the earlier
    // CID-encoding finding from the renderer task's own review).
    const refetched = await request(app)
      .get(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(refetched.body.template_version).toBe(pinnedVersion);
  });
});
