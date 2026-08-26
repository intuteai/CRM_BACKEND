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

  it('lists kits and finds a kit by searching any component serial (reverse lookup)', async () => {
    const created = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: 'M9010', controller_serial: 'C9010', gearbox_serial: 'G9010',
        harness_serial: 'H9010', cluster_serial: 'CL9010', vcu_serial: 'VCL9010', dcdc_serial: 'D9010',
      });
    createdKitIds.push(created.body.kit_id);

    const list = await request(app)
      .get('/api/ipt-kits?limit=50')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.statusCode).toBe(200);
    expect(list.body.data.some((k) => k.kit_id === created.body.kit_id)).toBe(true);

    const search = await request(app)
      .get('/api/ipt-kits?search=G9010')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(search.statusCode).toBe(200);
    expect(search.body.data).toHaveLength(1);
    expect(search.body.data[0].kit_id).toBe(created.body.kit_id);
  });

  it('gets a single kit by id', async () => {
    const created = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: 'M9011', controller_serial: 'C9011', gearbox_serial: 'G9011',
        harness_serial: 'H9011', cluster_serial: 'CL9011', vcu_serial: 'VCL9011', dcdc_serial: 'D9011',
      });
    createdKitIds.push(created.body.kit_id);

    const res = await request(app)
      .get(`/api/ipt-kits/${created.body.kit_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.kit_serial).toBe(created.body.kit_serial);
  });

  it('paginates across multiple pages using the returned cursor without gaps or overlap', async () => {
    // Shared "CLPG901" token in cluster_serial lets us isolate exactly these 3 kits via search,
    // so pagination assertions are deterministic regardless of what other tests created.
    const specs = [
      { motor_serial: 'M9012', controller_serial: 'C9012', gearbox_serial: 'G9012', harness_serial: 'H9012', cluster_serial: 'CLPG9012', vcu_serial: 'VCLPG9012', dcdc_serial: 'D9012' },
      { motor_serial: 'M9013', controller_serial: 'C9013', gearbox_serial: 'G9013', harness_serial: 'H9013', cluster_serial: 'CLPG9013', vcu_serial: 'VCLPG9013', dcdc_serial: 'D9013' },
      { motor_serial: 'M9014', controller_serial: 'C9014', gearbox_serial: 'G9014', harness_serial: 'H9014', cluster_serial: 'CLPG9014', vcu_serial: 'VCLPG9014', dcdc_serial: 'D9014' },
    ];

    const createdIds = [];
    for (const spec of specs) {
      const created = await request(app)
        .post('/api/ipt-kits')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(spec);
      createdKitIds.push(created.body.kit_id);
      createdIds.push(created.body.kit_id);
      expect(created.statusCode).toBe(201);
    }

    const seenIds = [];
    let cursor = null;
    let pages = 0;

    for (let i = 0; i < 3; i += 1) {
      const qs = cursor
        ? `search=CLPG901&limit=1&cursor=${encodeURIComponent(cursor)}`
        : 'search=CLPG901&limit=1';
      const page = await request(app)
        .get(`/api/ipt-kits?${qs}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(page.statusCode).toBe(200);
      expect(page.body.data).toHaveLength(1);

      const pageId = page.body.data[0].kit_id;
      expect(seenIds).not.toContain(pageId);
      seenIds.push(pageId);

      cursor = page.body.cursor;
      pages += 1;
      if (!cursor) break;
    }

    expect(pages).toBe(3);
    expect(cursor).toBeNull();
    expect(seenIds.sort()).toEqual([...createdIds].sort());
  });

  it('updates a kit\'s component serials', async () => {
    const created = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: 'M9020', controller_serial: 'C9020', gearbox_serial: 'G9020',
        harness_serial: 'H9020', cluster_serial: 'CL9020', vcu_serial: 'VCL9020', dcdc_serial: 'D9020',
      });
    createdKitIds.push(created.body.kit_id);

    const updated = await request(app)
      .put(`/api/ipt-kits/${created.body.kit_id}`)
      .set('Authorization', `Bearer ${productionToken}`)
      .send({
        motor_serial: 'M9021', controller_serial: 'C9020', gearbox_serial: 'G9020',
        harness_serial: 'H9020', cluster_serial: 'CL9020', vcu_serial: 'VCL9020', dcdc_serial: 'D9020',
      });
    expect(updated.statusCode).toBe(200);
    expect(updated.body.motor_serial).toBe('M9021');
    expect(updated.body.kit_serial).toBe(created.body.kit_serial);
  });

  it('deletes a kit and frees its component serials for reuse', async () => {
    const created = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: 'M9030', controller_serial: 'C9030', gearbox_serial: 'G9030',
        harness_serial: 'H9030', cluster_serial: 'CL9030', vcu_serial: 'VCL9030', dcdc_serial: 'D9030',
      });

    const del = await request(app)
      .delete(`/api/ipt-kits/${created.body.kit_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.statusCode).toBe(200);

    const reused = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: 'M9030', controller_serial: 'C9031', gearbox_serial: 'G9031',
        harness_serial: 'H9031', cluster_serial: 'CL9031', vcu_serial: 'VCL9031', dcdc_serial: 'D9031',
      });
    expect(reused.statusCode).toBe(201);
    createdKitIds.push(reused.body.kit_id);
  });
});
