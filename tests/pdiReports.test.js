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
});
