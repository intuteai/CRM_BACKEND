// `?photos=summary` (backend-performance-v1.0.8.md section 4). A save or a poll
// used to return the whole report, every photo's Base64 included -- 20-40 MB the
// phone had just uploaded. With ?photos=summary, `photos` comes back as
// [{ id, label, image_count }] and no image data; the counts are computed in the
// database so the photos are never read back into Node at all. Without the
// parameter every response is exactly what it was, because app 1.0.8 and older
// depend on it. Real database, throwaway rows deleted afterwards.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const pool = require('../config/db');

const IMG = (n) => `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=#${n}`;

describe('PDI reports ?photos=summary', () => {
  let adminToken, adminUserId;
  const created = [];
  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  beforeAll(async () => {
    const admin = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, 'x', 1) RETURNING user_id`,
      ['PDI Photos Summary Test Admin', `pdi-photos-summary-test-${Date.now()}@example.com`]
    );
    adminUserId = admin.rows[0].user_id;
    adminToken = jwt.sign({ user_id: adminUserId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (created.length) await pool.query('DELETE FROM pre_dispatch_inspection_reports WHERE report_id = ANY($1::int[])', [created]);
    await pool.query('DELETE FROM users WHERE user_id = $1', [adminUserId]);
    await pool.end();
  });

  async function newReport(photos, data = { pdi_no: 'PDI-SUMMARY-1' }) {
    const res = await request(app).post('/api/pdi/reports').set(auth()).send({ data, photos });
    expect(res.statusCode).toBe(201);
    created.push(res.body.report_id);
    return res.body.report_id;
  }
  const threeAndOne = () => [
    { id: 'photo-overall-motor', label: 'Overall Motor', images: [IMG(1), IMG(2), IMG(3)] },
    { id: 'photo-name-plate', label: 'Name Plate', images: [IMG(4)] },
  ];

  it('GET without the parameter still returns the full photos, unchanged', async () => {
    const id = await newReport(threeAndOne());
    const res = await request(app).get(`/api/pdi/reports/${id}`).set(auth());
    expect(res.statusCode).toBe(200);
    expect(res.body.photos).toEqual(threeAndOne());
  });

  it('GET ?photos=summary returns id, label and image_count only -- no image data anywhere', async () => {
    const id = await newReport(threeAndOne());
    const res = await request(app).get(`/api/pdi/reports/${id}?photos=summary`).set(auth());
    expect(res.statusCode).toBe(200);
    expect(res.body.photos).toEqual([
      { id: 'photo-overall-motor', label: 'Overall Motor', image_count: 3 },
      { id: 'photo-name-plate', label: 'Name Plate', image_count: 1 },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/data:image/);
    // everything else in the report is still there
    expect(res.body.data.pdi_no).toBe('PDI-SUMMARY-1');
    expect(res.body.report_id).toBe(id);
  });

  it('PATCH ?photos=summary saves the photos in full but answers with counts', async () => {
    const id = await newReport([]);
    const res = await request(app).patch(`/api/pdi/reports/${id}?photos=summary`).set(auth()).send({ photos: threeAndOne() });
    expect(res.statusCode).toBe(200);
    expect(res.body.photos).toEqual([
      { id: 'photo-overall-motor', label: 'Overall Motor', image_count: 3 },
      { id: 'photo-name-plate', label: 'Name Plate', image_count: 1 },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/data:image/);
    // ...and the photos really were stored, images and all.
    const stored = await request(app).get(`/api/pdi/reports/${id}`).set(auth());
    expect(stored.body.photos).toEqual(threeAndOne());
  });

  it('PATCH ?photos=summary with no photos in the body still reports the stored photos\' counts', async () => {
    const id = await newReport(threeAndOne());
    const res = await request(app).patch(`/api/pdi/reports/${id}?photos=summary`).set(auth()).send({ data: { pdi_no: 'PDI-SUMMARY-2' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.pdi_no).toBe('PDI-SUMMARY-2');
    expect(res.body.photos.map((p) => p.image_count)).toEqual([3, 1]);
  });

  it('PATCH without the parameter returns the full photos, unchanged', async () => {
    const id = await newReport([]);
    const res = await request(app).patch(`/api/pdi/reports/${id}`).set(auth()).send({ photos: threeAndOne() });
    expect(res.statusCode).toBe(200);
    expect(res.body.photos).toEqual(threeAndOne());
  });

  it('any other value of the parameter behaves as if it were absent', async () => {
    const id = await newReport(threeAndOne());
    for (const v of ['full', 'true', '', 'SUMMARY']) {
      const res = await request(app).get(`/api/pdi/reports/${id}?photos=${v}`).set(auth());
      expect(res.body.photos).toEqual(threeAndOne());
    }
  });

  it('handles no photos, an entry with no images, and an entry with no label', async () => {
    const empty = await newReport([]);
    const r1 = await request(app).get(`/api/pdi/reports/${empty}?photos=summary`).set(auth());
    expect(r1.body.photos).toEqual([]);

    const odd = await newReport([{ id: 'a', label: 'No images' }, { id: 'b', images: [IMG(1), IMG(2)] }, { id: 'c', label: 'Empty', images: [] }]);
    const r2 = await request(app).get(`/api/pdi/reports/${odd}?photos=summary`).set(auth());
    expect(r2.body.photos).toEqual([
      { id: 'a', label: 'No images', image_count: 0 },
      { id: 'b', label: '', image_count: 2 },
      { id: 'c', label: 'Empty', image_count: 0 },
    ]);
  });

  it('summarises a fixed-slots photo map (slot -> one image, a list, or nothing)', async () => {
    const id = await newReport({ front: IMG(1), back: [IMG(2), IMG(3)], empty: null });
    const res = await request(app).get(`/api/pdi/reports/${id}?photos=summary`).set(auth());
    expect(res.body.photos).toEqual(expect.arrayContaining([
      { id: 'front', label: 'front', image_count: 1 },
      { id: 'back', label: 'back', image_count: 2 },
      { id: 'empty', label: 'empty', image_count: 0 },
    ]));
    expect(res.body.photos).toHaveLength(3);
  });

  it('a finalized report is still locked and a missing one is still 404, with the parameter', async () => {
    const id = await newReport(threeAndOne());
    await pool.query(`UPDATE pre_dispatch_inspection_reports SET status = 'Completed' WHERE report_id = $1`, [id]);
    const locked = await request(app).patch(`/api/pdi/reports/${id}?photos=summary`).set(auth()).send({ data: { pdi_no: 'X' } });
    expect(locked.statusCode).toBe(409);
    expect(locked.body.code).toBe('REPORT_LOCKED');

    const missing = await request(app).get('/api/pdi/reports/2147483000?photos=summary').set(auth());
    expect(missing.statusCode).toBe(404);
  });
});
