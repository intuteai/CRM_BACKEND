// Innopack Parts Roster API: validation, controller behaviour and the route
// guard (Innopack design only). Model and database are mocked.
const mockParts = { list: jest.fn(), options: jest.fn(), create: jest.fn(), update: jest.fn(), remove: jest.fn() };
jest.mock('../models/innopack/parts', () => mockParts);
const mockQuery = jest.fn();
jest.mock('../config/db', () => ({ query: (...a) => mockQuery(...a) }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { validatePart, parseId } = require('../controllers/innopack/parts.validation');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const app = express();
app.use(express.json());
const emitted = [];
app.use((req, res, next) => { req.io = { emit: (e, p) => emitted.push({ e, p }) }; next(); });
app.use('/api/innopack', require('../routes/innopack'));

// authenticateToken looks the user up; answer with the role we want.
function as(roleId, userId = 50) {
  mockQuery.mockImplementation((sql) => {
    if (/FROM users u/.test(sql)) return Promise.resolve({ rows: [{ user_id: userId, name: 'X', role_id: roleId, role_name: 'r' }] });
    return Promise.resolve({ rows: [] });
  });
  return `Bearer ${jwt.sign({ user_id: userId }, process.env.JWT_SECRET)}`;
}

beforeEach(() => { jest.clearAllMocks(); emitted.length = 0; });

describe('validatePart', () => {
  it('trims text, turns blanks into null and rounds qty to 3 decimals', () => {
    const { values, errors } = validatePart({ part_name: '  CAM PLATE ', section: ' ', qty: 2.12345, design_status: 'TBD' });
    expect(errors).toEqual([]);
    expect(values).toMatchObject({ part_name: 'CAM PLATE', section: null, qty: 2.123, design_status: 'TBD', description: null });
  });

  it('requires a part name', () => {
    expect(validatePart({ section: 'FEEDER' }).errors).toEqual([{ path: 'part_name', msg: 'Part name is required' }]);
    expect(validatePart({ part_name: '   ' }).errors[0].path).toBe('part_name');
  });

  it('refuses server-owned and unknown fields', () => {
    const { errors } = validatePart({ part_name: 'A', drg_no: 'A00001', sr_no: 3, colour: 'red' });
    expect(errors.map((e) => e.path).sort()).toEqual(['colour', 'drg_no', 'sr_no']);
  });

  it('checks lengths and qty', () => {
    const { errors } = validatePart({ part_name: 'x'.repeat(121), qty: -1, units: 5 });
    expect(errors.map((e) => e.path).sort()).toEqual(['part_name', 'qty', 'units']);
    expect(validatePart({ part_name: 'A', qty: '2' }).errors[0]).toEqual({ path: 'qty', msg: 'must be a number' });
    expect(validatePart({ part_name: 'A', qty: 1000001 }).errors[0].path).toBe('qty');
  });

  it('parseId accepts positive integers only', () => {
    expect(parseId('12')).toBe(12);
    for (const bad of ['0', '-1', '1.5', 'abc', '99999999999']) expect(parseId(bad)).toBeNull();
  });
});

describe('route guard: Innopack design only', () => {
  it.each([[1, 'Compage admin'], [4, 'Compage design'], [11, 'Intute AI employee'], [12, 'Intute AI HR'], [2, 'customer']])(
    'role %i (%s) gets 403 and the model is never called', async (roleId) => {
      const res = await request(app).get('/api/innopack/parts').set('Authorization', as(roleId));
      expect(res.status).toBe(403);
      expect(mockParts.list).not.toHaveBeenCalled();
    }
  );

  it('no login gets 401', async () => {
    const res = await request(app).get('/api/innopack/parts');
    expect(res.status).toBe(401);
  });
});

describe('parts API as Innopack design', () => {
  it('lists parts', async () => {
    mockParts.list.mockResolvedValue([{ id: 1, drg_no: 'A00001' }]);
    const res = await request(app).get('/api/innopack/parts').set('Authorization', as(16));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [{ id: 1, drg_no: 'A00001' }] });
  });

  it('creates a part with the caller as author and tells Innopack screens', async () => {
    mockParts.create.mockResolvedValue({ id: 9, drg_no: 'A00360', part_name: 'NEW' });
    const res = await request(app).post('/api/innopack/parts').set('Authorization', as(16, 847)).send({ part_name: 'NEW', qty: 2 });
    expect(res.status).toBe(201);
    expect(mockParts.create).toHaveBeenCalledWith(expect.objectContaining({ part_name: 'NEW', qty: 2 }), 847);
    expect(emitted).toEqual([{ e: 'innopack_parts:changed', p: { action: 'created', id: 9 } }]);
  });

  it('answers 400 with field errors and writes nothing', async () => {
    const res = await request(app).post('/api/innopack/parts').set('Authorization', as(16)).send({ drg_no: 'A1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.fields.map((f) => f.path).sort()).toEqual(['drg_no', 'part_name']);
    expect(mockParts.create).not.toHaveBeenCalled();
  });

  it('update and delete answer 404 for a missing part', async () => {
    mockParts.update.mockResolvedValue(null);
    mockParts.remove.mockResolvedValue(false);
    const auth = as(16);
    expect((await request(app).put('/api/innopack/parts/5').set('Authorization', auth).send({ part_name: 'A' })).status).toBe(404);
    expect((await request(app).delete('/api/innopack/parts/5').set('Authorization', auth)).status).toBe(404);
    expect((await request(app).delete('/api/innopack/parts/abc').set('Authorization', auth)).status).toBe(404);
    expect(emitted).toEqual([]);
  });

  it('updates and deletes', async () => {
    mockParts.update.mockResolvedValue({ id: 5, part_name: 'B' });
    mockParts.remove.mockResolvedValue(true);
    const auth = as(16);
    const put = await request(app).put('/api/innopack/parts/5').set('Authorization', auth).send({ part_name: 'B' });
    expect(put.body).toEqual({ id: 5, part_name: 'B' });
    const del = await request(app).delete('/api/innopack/parts/5').set('Authorization', auth);
    expect(del.body).toEqual({ id: 5 });
    expect(emitted.map((x) => x.p.action)).toEqual(['updated', 'deleted']);
  });

  it('a database failure is a 500 with a plain message', async () => {
    mockParts.list.mockRejectedValue(new Error('boom'));
    const res = await request(app).get('/api/innopack/parts').set('Authorization', as(16));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong. Please try again.', code: 'SERVER_ERROR' });
  });
});
