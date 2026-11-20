// routes/core/stock.js wired into a real express app. Auth middleware and the
// Stock model are mocked, so this checks routing, permissions and the HTTP
// answers end to end without a database.
const mockAuth = { allow: true, permissionCalls: [] };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.user = { user_id: 11, role_id: 1 }; next(); },
  checkPermission: (module, action) => (req, res, next) => {
    mockAuth.permissionCalls.push(`${req.method} ${req.path} ${module}.${action}`);
    if (!mockAuth.allow) return res.status(403).json({ error: 'Permission denied' });
    return next();
  },
}));
jest.mock('../middleware/roles', () => ({
  ROLES: { ADMIN: 1, SALES: 2, PRODUCTION: 3, STORE: 4, DISPATCH: 5 },
  requireRoles: () => (req, res, next) => (mockAuth.allow ? next() : res.status(403).json({ error: 'Forbidden' })),
}));
jest.mock('../models/core/stock', () => {
  class StockError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  return {
    StockError,
    getAll: jest.fn(async () => ({ data: [], total: 0 })),
    getById: jest.fn(async () => null),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(async () => ({ productId: 7 })),
    adjustStock: jest.fn(),
    acceptReturn: jest.fn(),
    getAdjustments: jest.fn(async () => ({ available: false, data: [] })),
    setImageUrl: jest.fn(),
  };
});
jest.mock('../config/db', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/googleDrive', () => ({ uploadBufferToDrive: jest.fn() }));

const express = require('express');
const request = require('supertest');
const Stock = require('../models/core/stock');
const { uploadBufferToDrive } = require('../services/googleDrive');
const router = require('../routes/core/stock');

const emitted = [];
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.io = { emit: (...a) => emitted.push(a) }; next(); });
app.use('/api/stock', router);

const item = { productId: 7, stockQuantity: 5, returnableQty: 1, qtyRequired: 0, location: null, imageUrl: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.allow = true;
  mockAuth.permissionCalls = [];
  emitted.length = 0;
});

describe('permissions', () => {
  it.each([
    ['get', '/api/stock', 'Stock.can_read'],
    ['get', '/api/stock/7/adjustments', 'Stock.can_read'],
    ['post', '/api/stock', 'Stock.can_write'],
    ['put', '/api/stock/7', 'Stock.can_write'],
    ['post', '/api/stock/7/adjust', 'Stock.can_write'],
    ['post', '/api/stock/7/accept-return', 'Stock.can_write'],
    ['post', '/api/stock/7/photo', 'Stock.can_write'],
    ['delete', '/api/stock/7', 'Stock.can_delete'],
  ])('%s %s needs %s and is refused without it', async (method, url, perm) => {
    mockAuth.allow = false;
    const res = await request(app)[method](url).send({});
    expect(res.status).toBe(403);
    expect(mockAuth.permissionCalls[0]).toMatch(new RegExp(`${perm.replace('.', '\\.')}$`));
  });
});

describe('happy paths', () => {
  it('GET / clamps paging', async () => {
    const res = await request(app).get('/api/stock?limit=20000&offset=-4');
    expect(res.status).toBe(200);
    expect(Stock.getAll).toHaveBeenCalledWith({ limit: 10000, offset: 0 });
  });

  it('POST / creates', async () => {
    Stock.create.mockResolvedValue({ item, partNumberWarning: null });
    const res = await request(app).post('/api/stock').send({ productName: 'W', productCode: '0007L5BR123', price: 0 });
    expect(res.status).toBe(201);
    expect(emitted[0][0]).toBe('stockUpdate');
    expect(emitted[0][1].source).toBe('raw_materials');
  });

  it('POST / rejects string numbers (as before) with details', async () => {
    const res = await request(app).post('/api/stock').send({ productName: 'W', productCode: '0007L5BR123', price: '5' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_INPUT', error: 'Price must be a number' });
  });

  it('PUT /:id updates', async () => {
    Stock.update.mockResolvedValue(item);
    const res = await request(app).put('/api/stock/7').send({ productName: 'W', productCode: '0007L5BR123', price: 1, returnableQty: 1 });
    expect(res.status).toBe(200);
    expect(Stock.update.mock.calls[0][1].returnableQty).toBe(1);
  });

  it('POST /:id/accept-return exists now', async () => {
    Stock.acceptReturn.mockResolvedValue(item);
    const res = await request(app).post('/api/stock/7/accept-return').send({ quantity: 1 });
    expect(res.status).toBe(200);
    expect(Stock.acceptReturn).toHaveBeenCalledWith({ productId: 7, quantity: 1, userId: 11 });
  });

  it('POST /:id/adjust', async () => {
    Stock.adjustStock.mockResolvedValue(item);
    const res = await request(app).post('/api/stock/7/adjust').send({ quantity: -1, reason: 'Scrap' });
    expect(res.status).toBe(200);
  });

  it('GET /:id/adjustments before the migration', async () => {
    const res = await request(app).get('/api/stock/7/adjustments');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, data: [] });
  });

  it('DELETE /:id → 204', async () => {
    const res = await request(app).delete('/api/stock/7');
    expect(res.status).toBe(204);
  });

  it('DELETE in use → 409', async () => {
    Stock.delete.mockRejectedValueOnce(Object.assign(new Error('fk'), { code: '23503' }));
    const res = await request(app).delete('/api/stock/7');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IN_USE');
  });
});

describe('invalid product ids answer 400 on every :productId route', () => {
  it.each([
    ['put', '/api/stock/abc'],
    ['delete', '/api/stock/0'],
    ['post', '/api/stock/-3/adjust'],
    ['post', '/api/stock/1.5/accept-return'],
    ['get', '/api/stock/x/adjustments'],
    ['post', '/api/stock/abc/photo'],
  ])('%s %s', async (method, url) => {
    const res = await request(app)[method](url).send({ productName: 'W', productCode: '0007L5BR123', price: 1, quantity: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });
});

describe('photo upload', () => {
  it('404 for a missing product, Drive never called', async () => {
    const res = await request(app).post('/api/stock/7/photo').attach('photo', Buffer.from('png'), { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(404);
    expect(uploadBufferToDrive).not.toHaveBeenCalled();
  });

  it('a file over 8 MB is a 400, not a 500', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1);
    const res = await request(app).post('/api/stock/7/photo').attach('photo', big, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/);
  });
});
