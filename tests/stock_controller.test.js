// controllers/core/stock.controller.js with the Stock model, db, logger and
// Google Drive mocked. No real database or Drive call.
jest.mock('../models/core/stock', () => {
  class StockError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  return {
    StockError,
    getAll: jest.fn(),
    getById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    adjustStock: jest.fn(),
    acceptReturn: jest.fn(),
    getAdjustments: jest.fn(),
    setImageUrl: jest.fn(),
  };
});
jest.mock('../config/db', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/googleDrive', () => ({
  uploadBufferToDrive: jest.fn(async () => ({ directUrl: 'https://drive/x', id: 'f1' })),
}));

const Stock = require('../models/core/stock');
const pool = require('../config/db');
const { uploadBufferToDrive } = require('../services/googleDrive');
const controller = require('../controllers/core/stock.controller');

const { StockError } = Stock;

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    sent: false,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send() { this.sent = true; return this; },
  };
}

const item = (over = {}) => ({
  productId: 7, product_id: 7, stockQuantity: 10, returnableQty: 2, qtyRequired: 3,
  location: 'Rack A', imageUrl: null, productCode: '0007L5BR123', ...over,
});

const makeReq = (over = {}) => ({
  params: {}, query: {}, body: {}, user: { user_id: 11 }, io: { emit: jest.fn() }, ...over,
});

const validBody = (over = {}) => ({ productName: 'Wire', productCode: '0007l5br123', price: 5, ...over });
const pgErr = (code, constraint) => Object.assign(new Error('pg'), { code, constraint });

beforeEach(() => jest.clearAllMocks());

describe('getAll', () => {
  it('clamps paging and returns the model result', async () => {
    Stock.getAll.mockResolvedValue({ data: [], total: 0 });
    const res = makeRes();
    await controller.getAll(makeReq({ query: { limit: '99999', offset: 'x' } }), res);
    expect(Stock.getAll).toHaveBeenCalledWith({ limit: 10000, offset: 0 });
    expect(res.body).toEqual({ data: [], total: 0 });
  });
  it('500 with SERVER_ERROR on failure', async () => {
    Stock.getAll.mockRejectedValue(new Error('down'));
    const res = makeRes();
    await controller.getAll(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe('SERVER_ERROR');
  });
});

describe('create', () => {
  it('400 INVALID_INPUT with details for a bad body, model not called', async () => {
    const res = makeRes();
    await controller.create(makeReq({ body: { productName: '', productCode: '1', price: -1 } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('Product name is required');
    expect(res.body.details.map((d) => d.field)).toEqual(['productName', 'productCode', 'price']);
    expect(Stock.create).not.toHaveBeenCalled();
  });

  it('passes sanitized fields (incl. returnableQty) and the user to the model', async () => {
    Stock.create.mockResolvedValue({ item: item(), partNumberWarning: null });
    const req = makeReq({ body: validBody({ returnableQty: 3, part_number_auto: true }) });
    const res = makeRes();
    await controller.create(req, res);
    expect(Stock.create).toHaveBeenCalledWith(
      expect.objectContaining({ productCode: '0007L5BR123', returnableQty: 3, partNumberAuto: true }),
      { userId: 11 }
    );
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toHaveProperty('partNumberWarning');
  });

  it('emits a full raw_materials stockUpdate', async () => {
    Stock.create.mockResolvedValue({ item: item(), partNumberWarning: null });
    const req = makeReq({ body: validBody() });
    await controller.create(req, makeRes());
    expect(req.io.emit).toHaveBeenCalledWith('stockUpdate', {
      source: 'raw_materials', product_id: 7, stock_quantity: 10, returnable_qty: 2, qty_required: 3, location: 'Rack A', image_url: null,
      lead_date: null,
    });
  });

  it('passes a valid lead date to the model and puts it in the stockUpdate payload', async () => {
    Stock.create.mockResolvedValue({ item: item({ leadDate: '2026-12-24' }), partNumberWarning: null });
    const req = makeReq({ body: validBody({ leadDate: '2026-12-24' }) });
    const res = makeRes();
    await controller.create(req, res);
    expect(Stock.create).toHaveBeenCalledWith(expect.objectContaining({ leadDate: '2026-12-24' }), { userId: 11 });
    expect(res.statusCode).toBe(201);
    expect(req.io.emit).toHaveBeenCalledWith('stockUpdate', expect.objectContaining({ lead_date: '2026-12-24' }));
  });

  it('400 INVALID_INPUT naming leadDate for an impossible date, model not called', async () => {
    const res = makeRes();
    await controller.create(makeReq({ body: validBody({ leadDate: '2026-02-30' }) }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_INPUT', error: 'Lead date must be a valid date (YYYY-MM-DD)' });
    expect(res.body.details).toEqual([{ field: 'leadDate', message: 'Lead date must be a valid date (YYYY-MM-DD)' }]);
    expect(Stock.create).not.toHaveBeenCalled();
  });

  it('returns partNumberWarning when the model sets one', async () => {
    Stock.create.mockResolvedValue({ item: item(), partNumberWarning: 'kept 0007' });
    const res = makeRes();
    await controller.create(makeReq({ body: validBody() }), res);
    expect(res.body.partNumberWarning).toBe('kept 0007');
  });

  it('works without req.io', async () => {
    Stock.create.mockResolvedValue({ item: item(), partNumberWarning: null });
    const res = makeRes();
    await controller.create(makeReq({ body: validBody(), io: undefined }), res);
    expect(res.statusCode).toBe(201);
  });

  it.each([
    [new StockError('PART_NUMBER_TAKEN', 'Part Number 0007 is already used by X (#1)'), 400, 'PART_NUMBER_TAKEN', 'Part Number 0007 is already used by X (#1)'],
    [pgErr('23505', 'raw_materials_part_number_unique'), 400, 'PART_NUMBER_TAKEN', 'Part Number is already in use'],
    [pgErr('23505', 'raw_materials_product_code_key'), 400, 'DUPLICATE_CODE', 'Product code must be unique'],
    [pgErr('23505', 'something_else'), 400, 'DUPLICATE_CODE', 'This value is already in use'],
    [pgErr('22003'), 400, 'INVALID_INPUT', 'A number is too large (value too large)'],
    [pgErr('23514'), 400, 'INVALID_INPUT', undefined],
    [new Error('db down'), 500, 'SERVER_ERROR', 'Internal Server Error'],
  ])('maps %p', async (err, status, code, message) => {
    Stock.create.mockRejectedValue(err);
    const res = makeRes();
    await controller.create(makeReq({ body: validBody() }), res);
    expect(res.statusCode).toBe(status);
    expect(res.body.code).toBe(code);
    if (message) expect(res.body.error).toBe(message);
  });
});

describe('update', () => {
  it('400 for a bad product id', async () => {
    const res = makeRes();
    await controller.update(makeReq({ params: { productId: 'abc' }, body: validBody() }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(Stock.update).not.toHaveBeenCalled();
  });

  it('passes stockChangeReason and leaves out unsent fields', async () => {
    Stock.update.mockResolvedValue(item());
    const req = makeReq({ params: { productId: '7' }, body: validBody({ stockQuantity: 4, stockChangeReason: 'Recount' }) });
    const res = makeRes();
    await controller.update(req, res);
    const [id, fields, opts] = Stock.update.mock.calls[0];
    expect(id).toBe(7);
    expect(fields).toMatchObject({ stockQuantity: 4, stockChangeReason: 'Recount' });
    expect(fields).not.toHaveProperty('location');
    expect(fields).not.toHaveProperty('returnableQty');
    expect(fields).not.toHaveProperty('leadDate'); // omitted → model keeps the stored lead date
    expect(opts).toEqual({ userId: 11 });
    expect(res.body).toEqual(item());
    expect(req.io.emit).toHaveBeenCalledWith('stockUpdate', expect.objectContaining({ source: 'raw_materials', product_id: 7 }));
  });

  it.each([
    [null, null],
    ['', null],
    ['2027-03-01', '2027-03-01'],
  ])('update leadDate %p is passed to the model as %p', async (sent, expected) => {
    Stock.update.mockResolvedValue(item({ leadDate: expected }));
    const req = makeReq({ params: { productId: '7' }, body: validBody({ leadDate: sent }) });
    await controller.update(req, makeRes());
    expect(Stock.update.mock.calls[0][1].leadDate).toBe(expected);
    expect(req.io.emit).toHaveBeenCalledWith('stockUpdate', expect.objectContaining({ lead_date: expected }));
  });

  it('404 NOT_FOUND', async () => {
    Stock.update.mockRejectedValue(new StockError('NOT_FOUND', 'Stock item not found'));
    const res = makeRes();
    await controller.update(makeReq({ params: { productId: '7' }, body: validBody() }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Stock item not found', code: 'NOT_FOUND' });
  });
});

describe('delete', () => {
  it('204 and emits a deleted event with source', async () => {
    Stock.delete.mockResolvedValue({ productId: 7 });
    const req = makeReq({ params: { productId: '7' } });
    const res = makeRes();
    await controller.delete(req, res);
    expect(res.statusCode).toBe(204);
    expect(res.sent).toBe(true);
    expect(req.io.emit).toHaveBeenCalledWith('stockUpdate', { source: 'raw_materials', product_id: 7, status: 'deleted' });
  });
  it('409 IN_USE when referenced by BOM/work orders', async () => {
    Stock.delete.mockRejectedValue(pgErr('23503'));
    const req = makeReq({ params: { productId: '7' } });
    const res = makeRes();
    await controller.delete(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('IN_USE');
    expect(res.body.error).toMatch(/BOM, work order or process/);
    expect(req.io.emit).not.toHaveBeenCalled();
  });
  it('404 when missing, 400 for id 0', async () => {
    Stock.delete.mockRejectedValue(new StockError('NOT_FOUND', 'Stock item not found'));
    let res = makeRes();
    await controller.delete(makeReq({ params: { productId: '7' } }), res);
    expect(res.statusCode).toBe(404);
    res = makeRes();
    await controller.delete(makeReq({ params: { productId: '0' } }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('adjust', () => {
  it('validates the body', async () => {
    const res = makeRes();
    await controller.adjust(makeReq({ params: { productId: '7' }, body: { quantity: 0 } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.details[0].field).toBe('quantity');
    expect(Stock.adjustStock).not.toHaveBeenCalled();
  });
  it('calls the model and emits', async () => {
    Stock.adjustStock.mockResolvedValue(item({ stockQuantity: 12 }));
    const req = makeReq({ params: { productId: '7' }, body: { quantity: 2, reason: 'GRN' } });
    const res = makeRes();
    await controller.adjust(req, res);
    expect(Stock.adjustStock).toHaveBeenCalledWith({ productId: 7, quantity: 2, reason: 'GRN', userId: 11 });
    expect(res.body.stockQuantity).toBe(12);
    expect(req.io.emit).toHaveBeenCalledWith('stockUpdate', expect.objectContaining({ stock_quantity: 12, source: 'raw_materials' }));
  });
  it('400 INSUFFICIENT_STOCK', async () => {
    Stock.adjustStock.mockRejectedValue(new StockError('INSUFFICIENT_STOCK', 'Cannot remove 5: only 1 in stock'));
    const res = makeRes();
    await controller.adjust(makeReq({ params: { productId: '7' }, body: { quantity: -5 } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Cannot remove 5: only 1 in stock', code: 'INSUFFICIENT_STOCK' });
  });
});

describe('acceptReturn', () => {
  it('validates the quantity', async () => {
    const res = makeRes();
    await controller.acceptReturn(makeReq({ params: { productId: '7' }, body: { quantity: -1 } }), res);
    expect(res.statusCode).toBe(400);
    expect(Stock.acceptReturn).not.toHaveBeenCalled();
  });
  it('returns the updated item and emits', async () => {
    Stock.acceptReturn.mockResolvedValue(item({ stockQuantity: 12, returnableQty: 0 }));
    const req = makeReq({ params: { productId: '7' }, body: { quantity: 2 } });
    const res = makeRes();
    await controller.acceptReturn(req, res);
    expect(Stock.acceptReturn).toHaveBeenCalledWith({ productId: 7, quantity: 2, userId: 11 });
    expect(res.body).toMatchObject({ stockQuantity: 12, returnableQty: 0 });
    expect(req.io.emit).toHaveBeenCalledWith('stockUpdate', expect.objectContaining({ returnable_qty: 0 }));
  });
  it('400 RETURN_EXCEEDS_RETURNABLE', async () => {
    Stock.acceptReturn.mockRejectedValue(new StockError('RETURN_EXCEEDS_RETURNABLE', 'Cannot accept more than the returnable quantity (2)'));
    const res = makeRes();
    await controller.acceptReturn(makeReq({ params: { productId: '7' }, body: { quantity: 3 } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('RETURN_EXCEEDS_RETURNABLE');
  });
});

describe('getAdjustments', () => {
  it.each([[undefined, 20], ['5', 5], ['500', 100], ['-1', 20], ['x', 20]])('limit %p → %p', async (limit, expected) => {
    Stock.getAdjustments.mockResolvedValue({ available: true, data: [] });
    const res = makeRes();
    await controller.getAdjustments(makeReq({ params: { productId: '7' }, query: { limit } }), res);
    expect(Stock.getAdjustments).toHaveBeenCalledWith(7, expected);
    expect(res.body).toEqual({ available: true, data: [] });
  });
  it('400 for a bad id', async () => {
    const res = makeRes();
    await controller.getAdjustments(makeReq({ params: { productId: '1.5' } }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('uploadPhoto', () => {
  const file = { buffer: Buffer.from('x'), mimetype: 'image/png' };

  it('404 before any Drive upload when the product does not exist', async () => {
    Stock.getById.mockResolvedValue(null);
    const res = makeRes();
    await controller.uploadPhoto(makeReq({ params: { productId: '7' }, file }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(uploadBufferToDrive).not.toHaveBeenCalled();
  });

  it('400 with no file or a bad type, no Drive call', async () => {
    let res = makeRes();
    await controller.uploadPhoto(makeReq({ params: { productId: '7' } }), res);
    expect(res.statusCode).toBe(400);
    res = makeRes();
    await controller.uploadPhoto(makeReq({ params: { productId: '7' }, file: { ...file, mimetype: 'application/pdf' } }), res);
    expect(res.statusCode).toBe(400);
    expect(uploadBufferToDrive).not.toHaveBeenCalled();
  });

  it('uploads, saves the url and emits', async () => {
    Stock.getById.mockResolvedValue(item());
    Stock.setImageUrl.mockResolvedValue(item({ imageUrl: 'https://drive/x' }));
    const req = makeReq({ params: { productId: '7' }, file });
    const res = makeRes();
    await controller.uploadPhoto(req, res);
    expect(uploadBufferToDrive).toHaveBeenCalledWith(file.buffer, 'image/png', expect.stringMatching(/^raw_7_\d+\.png$/));
    expect(Stock.setImageUrl).toHaveBeenCalledWith(7, 'https://drive/x');
    expect(res.body).toMatchObject({ success: true, imageUrl: 'https://drive/x', fileId: 'f1' });
    expect(req.io.emit).toHaveBeenCalledWith('stockUpdate', expect.objectContaining({ image_url: 'https://drive/x' }));
  });

  it('500 when Drive fails', async () => {
    Stock.getById.mockResolvedValue(item());
    uploadBufferToDrive.mockRejectedValueOnce(new Error('quota'));
    const res = makeRes();
    await controller.uploadPhoto(makeReq({ params: { productId: '7' }, file }), res);
    expect(res.statusCode).toBe(500);
  });
});

describe('checkPartNumber', () => {
  it('rejects a non 4-digit part number', async () => {
    const res = makeRes();
    await controller.checkPartNumber(makeReq({ query: { part_number: '12' } }), res);
    expect(res.statusCode).toBe(400);
  });
  it('reports a conflict', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ product_id: 3, product_name: 'Bolt' }] });
    const res = makeRes();
    await controller.checkPartNumber(makeReq({ query: { part_number: '0003', exclude_id: '7' } }), res);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('product_id != $2'), ['0003', 7]);
    expect(res.body).toEqual({ available: false, conflictProductId: 3, conflictProductName: 'Bolt' });
  });
});
