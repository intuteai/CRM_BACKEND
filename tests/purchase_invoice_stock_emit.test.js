// Purchase invoices change raw-material stock through a DB trigger; the
// controller now tells the raw-material pages. Model, db, redis and logger mocked.
jest.mock('../models/invoicing/purchaseInvoice', () => ({ create: jest.fn(), update: jest.fn(), delete: jest.fn(), getAll: jest.fn() }));
jest.mock('../config/redis', () => ({ del: jest.fn(async () => {}), get: jest.fn(async () => null), setEx: jest.fn(async () => {}) }));
jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const PurchaseInvoice = require('../models/invoicing/purchaseInvoice');
const pool = require('../config/db');
const controller = require('../controllers/invoicing/purchaseInvoices.controller');

const res = () => ({ status() { return this; }, json() { return this; }, send() { return this; } });
const stockRow = (id, qty) => ({ rows: [{ product_id: id, stock_quantity: String(qty), returnable_qty: '0.00', qty_required: 2, location: null, image_url: null }] });

beforeEach(() => jest.clearAllMocks());

it('create emits a raw_materials stockUpdate with numbers', async () => {
  PurchaseInvoice.create.mockResolvedValue({ invoiceId: 1, productId: 7 });
  pool.query.mockResolvedValueOnce(stockRow(7, 15));
  const emit = jest.fn();
  await controller.create({ body: { productId: 7, quantity: 5 }, io: { emit } }, res());
  expect(emit).toHaveBeenCalledWith('stockUpdate', {
    source: 'raw_materials', product_id: 7, stock_quantity: 15, returnable_qty: 0, qty_required: 2, location: null, image_url: null,
  });
  expect(emit).toHaveBeenCalledWith('invoiceUpdate', expect.anything());
});

it('update to another material emits for both the old and the new one', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ product_id: 3 }] }) // before
    .mockResolvedValueOnce(stockRow(3, 1))
    .mockResolvedValueOnce(stockRow(7, 9));
  PurchaseInvoice.update.mockResolvedValue({ invoiceId: 1, productId: 7 });
  const emit = jest.fn();
  await controller.update({ params: { invoiceId: '1' }, body: { productId: 7 }, io: { emit } }, res());
  const ids = emit.mock.calls.filter((c) => c[0] === 'stockUpdate').map((c) => c[1].product_id);
  expect(ids).toEqual([3, 7]);
});

it('delete emits for the deleted invoice product; a lookup failure is only a warning', async () => {
  PurchaseInvoice.delete.mockResolvedValue({ invoiceId: 1, productId: 7 });
  pool.query.mockRejectedValueOnce(new Error('db blip'));
  const emit = jest.fn();
  await controller.delete({ params: { invoiceId: '1' }, io: { emit } }, res());
  expect(emit).toHaveBeenCalledWith('invoiceUpdate', { invoiceId: 1, status: 'Deleted' });
  expect(emit.mock.calls.some((c) => c[0] === 'stockUpdate')).toBe(false);
});

it('null product ids are skipped', async () => {
  const emit = jest.fn();
  await controller.emitRawStock({ io: { emit } }, [null, undefined, 'x']);
  expect(pool.query).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
});
