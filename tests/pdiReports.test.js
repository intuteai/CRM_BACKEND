const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const pool = require('../config/db');

describe('PDI Reports API', () => {
  let adminToken, adminUserId;
  const createdReportIds = [];

  beforeAll(async () => {
    const admin = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, 'x', 1) RETURNING user_id`,
      ['PDI Reports Test Admin', `pdi-reports-test-admin-${Date.now()}@example.com`]
    );
    adminUserId = admin.rows[0].user_id;
    adminToken = jwt.sign({ user_id: adminUserId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (createdReportIds.length) {
      await pool.query('DELETE FROM pre_dispatch_inspection_reports WHERE report_id = ANY($1::int[])', [createdReportIds]);
    }
    await pool.query('DELETE FROM users WHERE user_id = $1', [adminUserId]);
    await pool.end();
  });

  it('creates a near-empty draft report and returns a report_id', async () => {
    const res = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'ABC Industries', pdi_no: 'PDI-TEST-001' } });

    expect(res.statusCode).toBe(201);
    expect(res.body.report_id).toEqual(expect.any(Number));
    expect(res.body.status).toBe('Pending');
    expect(res.body.template_id).toBe('general');
    expect(res.body.data.customer_name).toBe('ABC Industries');
    expect(res.body.photos).toEqual([]);
    createdReportIds.push(res.body.report_id);
  });

  it('creates a report against a non-default template when template_id is given', async () => {
    const res = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ template_id: 'autonxt', data: { customer_name: 'Autonxt', pdi_no: 'PDI-TEST-AUTONXT-1' } });

    expect(res.statusCode).toBe(201);
    expect(res.body.template_id).toBe('autonxt');
    createdReportIds.push(res.body.report_id);
  });

  it('rejects creating a report with an unknown template_id', async () => {
    const res = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ template_id: 'does-not-exist', data: { customer_name: 'X', pdi_no: 'Y' } });

    expect(res.statusCode).toBe(400);
  });

  it('fetches a report by id, resuming its full saved state', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'Kesari Auto', pdi_no: 'PDI-TEST-003' } });
    createdReportIds.push(created.body.report_id);

    const fetched = await request(app)
      .get(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(fetched.statusCode).toBe(200);
    expect(fetched.body.report_id).toBe(created.body.report_id);
    expect(fetched.body.data.customer_name).toBe('Kesari Auto');
  });

  it('returns 404 for a report id that does not exist', async () => {
    const res = await request(app)
      .get('/api/pdi/reports/999999999')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(404);
  });

  it('saves progress on a draft via PATCH without requiring every field', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'Voltrix Motors', pdi_no: 'PDI-TEST-002' } });
    createdReportIds.push(created.body.report_id);

    const patched = await request(app)
      .patch(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'In Progress', data: { ...created.body.data, product_id: '125-M' } });

    expect(patched.statusCode).toBe(200);
    expect(patched.body.status).toBe('In Progress');
    expect(patched.body.data.product_id).toBe('125-M');
    expect(patched.body.data.customer_name).toBe('Voltrix Motors');
  });

  it('lists reports filtered by status', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'R.K. Traders', pdi_no: 'PDI-TEST-LIST-1' } });
    createdReportIds.push(created.body.report_id);
    await request(app)
      .patch(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'Failed' });

    const list = await request(app)
      .get('/api/pdi/reports?status=Failed&limit=50')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(list.statusCode).toBe(200);
    expect(list.body.data.some((r) => r.report_id === created.body.report_id)).toBe(true);
    expect(list.body.data.every((r) => r.status === 'Failed')).toBe(true);
    const listedReport = list.body.data.find((r) => r.report_id === created.body.report_id);
    expect(listedReport.pdi_no).toBe('PDI-TEST-LIST-1');
    expect(listedReport.customer_name).toBe('R.K. Traders');
  });

  it('finalizes a report: generates a real PDF and marks it Completed', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'Finalize Test Co.', pdi_no: 'PDI-TEST-FINAL-1' } });
    createdReportIds.push(created.body.report_id);

    const finalized = await request(app)
      .post(`/api/pdi/reports/${created.body.report_id}/finalize`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(finalized.statusCode).toBe(200);
    expect(finalized.headers['content-type']).toBe('application/pdf');
    expect(finalized.body.slice(0, 5).toString('ascii')).toBe('%PDF-');

    const fetched = await request(app)
      .get(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(fetched.body.status).toBe('Completed');
  });

  it('embeds saved photos in the finalized PDF (regression: photos live in their own column, not data)', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'Photo Test Co.', pdi_no: 'PDI-TEST-PHOTO-1' } });
    createdReportIds.push(created.body.report_id);

    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await request(app)
      .patch(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ photos: [{ label: 'Overall Motor', image: tinyPng }] });

    const withoutPhotos = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'No Photo Co.', pdi_no: 'PDI-TEST-PHOTO-2' } });
    createdReportIds.push(withoutPhotos.body.report_id);

    const [finalized, finalizedBare] = await Promise.all([
      request(app).post(`/api/pdi/reports/${created.body.report_id}/finalize`).set('Authorization', `Bearer ${adminToken}`),
      request(app).post(`/api/pdi/reports/${withoutPhotos.body.report_id}/finalize`).set('Authorization', `Bearer ${adminToken}`),
    ]);

    expect(finalized.statusCode).toBe(200);
    // A PDF with an embedded raster image is meaningfully larger than one
    // whose photo section only drew the empty "PHOTOS:" header box.
    expect(finalized.body.length).toBeGreaterThan(finalizedBare.body.length + 500);
  });

  it('rejects finalizing a report with no pdi_no', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'No PDI No Co.' } });
    createdReportIds.push(created.body.report_id);

    const finalized = await request(app)
      .post(`/api/pdi/reports/${created.body.report_id}/finalize`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(finalized.statusCode).toBe(400);
  });

  it('regenerates a PDF on demand for an unfinished draft', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'Draft PDF Co.', pdi_no: 'PDI-TEST-PDF-1' } });
    createdReportIds.push(created.body.report_id);

    const pdf = await request(app)
      .get(`/api/pdi/reports/${created.body.report_id}/pdf`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('deletes a report', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'Delete Test Co.', pdi_no: 'PDI-TEST-DEL-1' } });

    const del = await request(app)
      .delete(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.statusCode).toBe(200);

    const fetched = await request(app)
      .get(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(fetched.statusCode).toBe(404);
  });

  it('lists the registered templates', async () => {
    const res = await request(app)
      .get('/api/pdi/templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([
      { id: 'general', name: 'General', version: 1 },
      { id: 'autonxt', name: 'AutoNXT Motor PDI', version: 1 },
    ]);
  });

  it('the legacy /api/pdi generate/CRUD endpoints are gone', async () => {
    const generate = await request(app)
      .post('/api/pdi/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pdi_no: 'PDI-LEGACY-CHECK' });
    expect(generate.statusCode).toBe(404);

    const list = await request(app)
      .get('/api/pdi')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.statusCode).toBe(404);
  });
});
