const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const pool = require('../config/db');

describe('IPT Kit Assembly API', () => {
  let adminToken, adminUserId, productionToken, productionUserId;
  const createdKitIds = [];

  beforeAll(async () => {
    const admin = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, 'x', 1) RETURNING user_id`,
      ['IPT Test Admin', `ipt-test-admin-${Date.now()}@example.com`]
    );
    adminUserId = admin.rows[0].user_id;
    adminToken = jwt.sign({ user_id: adminUserId }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const production = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, 'x', 5) RETURNING user_id`,
      ['IPT Test Production', `ipt-test-production-${Date.now()}@example.com`]
    );
    productionUserId = production.rows[0].user_id;
    productionToken = jwt.sign({ user_id: productionUserId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (createdKitIds.length) {
      await pool.query('DELETE FROM ipt_kits WHERE kit_id = ANY($1::int[])', [createdKitIds]);
    }
    await pool.query('DELETE FROM users WHERE user_id = ANY($1::int[])', [[adminUserId, productionUserId]]);
    await pool.end();
  });

  it('creates a kit with an auto-generated kit_serial and normalized component serials', async () => {
    const res = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: ' m9001 ',
        controller_serial: 'c9001',
        gearbox_serial: 'g9001',
        harness_serial: 'h9001',
        cluster_serial: 'cl9001',
        vcu_serial: 'vcl9001',
        dcdc_serial: 'd9001',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.kit_serial).toMatch(/^IPT\d+$/);
    expect(res.body.motor_serial).toBe('M9001');
    createdKitIds.push(res.body.kit_id);
  });

  it('rejects a component serial that is already used in another kit, with a field-specific error', async () => {
    const first = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${productionToken}`)
      .send({
        motor_serial: 'M9002', controller_serial: 'C9002', gearbox_serial: 'G9002',
        harness_serial: 'H9002', cluster_serial: 'CL9002', vcu_serial: 'VCL9002', dcdc_serial: 'D9002',
      });
    expect(first.statusCode).toBe(201);
    createdKitIds.push(first.body.kit_id);

    const dup = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${productionToken}`)
      .send({
        motor_serial: 'M9003', controller_serial: 'C9002', gearbox_serial: 'G9003',
        harness_serial: 'H9003', cluster_serial: 'CL9003', vcu_serial: 'VCL9003', dcdc_serial: 'D9003',
      });
    expect(dup.statusCode).toBe(400);
    expect(dup.body.field).toBe('controller_serial');
    expect(dup.body.error).toMatch(/C9002/);
  });
});
