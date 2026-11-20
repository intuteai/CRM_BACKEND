// models/core/stock.js against a fake pool/client. No real database is touched:
// config/db is mocked and every query is answered by the `handler` below.
const mockState = { handler: null, clientLog: [], poolLog: [], released: 0, connects: 0 };

jest.mock('../config/db', () => {
  const run = async (log, sql, params) => {
    log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    const out = await mockState.handler(String(sql).replace(/\s+/g, ' ').trim(), params);
    return out || { rows: [] };
  };
  return {
    query: (sql, params) => run(mockState.poolLog, sql, params),
    connect: async () => {
      mockState.connects += 1;
      return {
        query: (sql, params) => run(mockState.clientLog, sql, params),
        release: () => { mockState.released += 1; },
      };
    },
  };
});
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../utils/logger');
const Stock = require('../models/core/stock');

const { StockError } = Stock;

const row = (over = {}) => ({
  product_id: 7,
  stock_quantity: '10.00',
  price: '5.50',
  created_at: '2026-01-01T00:00:00Z',
  product_name: 'Wire',
  description: 'desc',
  product_code: '0007L5BR123',
  qty_required: 3,
  location: 'Rack A',
  image_url: 'http://img',
  returnable_qty: '4.00',
  ...over,
});

const pgErr = (code, constraint) => Object.assign(new Error(`pg ${code}`), { code, constraint });

const sqls = () => mockState.clientLog.map((q) => q.sql);
const find = (re) => mockState.clientLog.find((q) => re.test(q.sql));
const findAll = (re) => mockState.clientLog.filter((q) => re.test(q.sql));

beforeEach(() => {
  mockState.handler = async () => ({ rows: [] });
  mockState.clientLog = [];
  mockState.poolLog = [];
  mockState.released = 0;
  mockState.connects = 0;
  jest.clearAllMocks();
});

const fullFields = (over = {}) => ({ productName: 'Wire 2', productCode: '0007L5BR123', price: 6, ...over });

describe('normalizeStockRow', () => {
  it('turns numeric strings into numbers and gives both spellings, no __raw', () => {
    const n = Stock.normalizeStockRow(row());
    expect(n).toMatchObject({
      product_id: 7, productId: 7, stock_quantity: 10, stockQuantity: 10, price: 5.5,
      returnable_qty: 4, returnableQty: 4, qty_required: 3, qtyRequired: 3,
      product_code: '0007L5BR123', productCode: '0007L5BR123', image_url: 'http://img', imageUrl: 'http://img',
      location: 'Rack A', createdAt: '2026-01-01T00:00:00Z',
    });
    expect(n).not.toHaveProperty('__raw');
  });
  it('keeps a missing price as null and junk numbers as 0', () => {
    const n = Stock.normalizeStockRow(row({ price: null, stock_quantity: 'abc', qty_required: null }));
    expect(n.price).toBeNull();
    expect(n.stockQuantity).toBe(0);
    expect(n.qtyRequired).toBe(0);
  });
  it('returns null for no row', () => expect(Stock.normalizeStockRow(undefined)).toBeNull());
});

describe('getAll', () => {
  it('passes limit/offset and returns numbers + total', async () => {
    mockState.handler = async (sql) => (/COUNT/.test(sql) ? { rows: [{ count: '104' }] } : { rows: [row()] });
    const out = await Stock.getAll({ limit: 5000, offset: 0 });
    expect(out.total).toBe(104);
    expect(out.data[0].stockQuantity).toBe(10);
    expect(mockState.poolLog[0].params).toEqual([5000, 0]);
  });
});

describe('create', () => {
  it('manual part number: checks it, inserts without an id and audits initial stock', async () => {
    mockState.handler = async (sql) => {
      if (/^INSERT INTO raw_materials/.test(sql)) return { rows: [row({ product_id: 171, product_code: '0042L5BR123', stock_quantity: '12.00' })] };
      return { rows: [] };
    };
    const out = await Stock.create({ ...fullFields({ productCode: '0042L5BR123' }), stockQuantity: 12, partNumberAuto: false }, { userId: 3 });
    expect(out.partNumberWarning).toBeNull();
    expect(out.item.productId).toBe(171);
    const ins = find(/^INSERT INTO raw_materials/);
    expect(ins.sql).not.toMatch(/product_id, created_at/);
    expect(ins.params[2]).toBe('0042L5BR123');
    const audit = find(/INSERT INTO stock_adjustments/);
    expect(audit.params).toEqual([171, 12, 12, 'Initial stock', 'create', 3]);
    expect(sqls()[0]).toBe('BEGIN');
    expect(sqls()).toContain('COMMIT');
    expect(mockState.released).toBe(1);
  });

  it('manual part number already used → PART_NUMBER_TAKEN, rolled back, released', async () => {
    mockState.handler = async (sql) => (/WHERE part_number = \$1$/.test(sql) ? { rows: [{ product_id: 9, product_name: 'Bolt' }] } : { rows: [] });
    await expect(Stock.create({ ...fullFields(), partNumberAuto: false })).rejects.toMatchObject({
      code: 'PART_NUMBER_TAKEN', message: 'Part Number 0007 is already used by Bolt (#9)',
    });
    expect(find(/^INSERT INTO raw_materials/)).toBeUndefined();
    expect(sqls()).toContain('ROLLBACK');
    expect(mockState.released).toBe(1);
  });

  it('auto: reserves the next id and uses it as the part number', async () => {
    mockState.handler = async (sql, params) => {
      if (/nextval/.test(sql)) return { rows: [{ id: '171' }] };
      if (/^INSERT INTO raw_materials/.test(sql)) return { rows: [row({ product_id: params[9], product_code: params[2], stock_quantity: '0' })] };
      return { rows: [] };
    };
    const out = await Stock.create({ ...fullFields({ productCode: '0170L5BR123' }), partNumberAuto: true });
    const ins = find(/^INSERT INTO raw_materials/);
    expect(ins.params[2]).toBe('0171L5BR123');
    expect(ins.params[9]).toBe(171);
    expect(out.partNumberWarning).toBeNull();
    expect(out.item.productCode).toBe('0171L5BR123');
    expect(find(/INSERT INTO stock_adjustments/)).toBeUndefined(); // no stock → no audit
  });

  it('auto: id already matches → no extra check needed, code unchanged', async () => {
    mockState.handler = async (sql, params) => {
      if (/nextval/.test(sql)) return { rows: [{ id: 171 }] };
      if (/^INSERT INTO raw_materials/.test(sql)) return { rows: [row({ product_id: params[9], product_code: params[2] })] };
      return { rows: [] };
    };
    await Stock.create({ ...fullFields({ productCode: '0171L5BR123' }), partNumberAuto: true });
    expect(findAll(/WHERE part_number = \$1$/)).toHaveLength(1);
    expect(find(/^INSERT INTO raw_materials/).params[2]).toBe('0171L5BR123');
  });

  it('auto: id-based part number taken → keeps the requested code with a warning', async () => {
    mockState.handler = async (sql, params) => {
      if (/nextval/.test(sql)) return { rows: [{ id: '171' }] };
      if (/WHERE part_number = \$1$/.test(sql)) return params[0] === '0171' ? { rows: [{ product_id: 5, product_name: 'Nut' }] } : { rows: [] };
      if (/^INSERT INTO raw_materials/.test(sql)) return { rows: [row({ product_id: params[9], product_code: params[2] })] };
      return { rows: [] };
    };
    const out = await Stock.create({ ...fullFields({ productCode: '0170L5BR123' }), partNumberAuto: true });
    expect(find(/^INSERT INTO raw_materials/).params[2]).toBe('0170L5BR123');
    expect(out.partNumberWarning).toMatch(/0171 is already used by Nut \(#5\); kept 0170/);
  });

  it('auto: both id-based and requested part numbers taken → PART_NUMBER_TAKEN', async () => {
    mockState.handler = async (sql) => {
      if (/nextval/.test(sql)) return { rows: [{ id: '171' }] };
      if (/WHERE part_number = \$1$/.test(sql)) return { rows: [{ product_id: 5, product_name: 'Nut' }] };
      return { rows: [] };
    };
    await expect(Stock.create({ ...fullFields({ productCode: '0170L5BR123' }), partNumberAuto: true })).rejects.toMatchObject({ code: 'PART_NUMBER_TAKEN' });
    expect(sqls()).toContain('ROLLBACK');
    expect(mockState.released).toBe(1);
  });

  it('auto: id over 9999 → warning, requested code kept', async () => {
    mockState.handler = async (sql, params) => {
      if (/nextval/.test(sql)) return { rows: [{ id: '10000' }] };
      if (/^INSERT INTO raw_materials/.test(sql)) return { rows: [row({ product_id: params[9], product_code: params[2] })] };
      return { rows: [] };
    };
    const out = await Stock.create({ ...fullFields({ productCode: '0170L5BR123' }), partNumberAuto: true });
    expect(find(/^INSERT INTO raw_materials/).params[2]).toBe('0170L5BR123');
    expect(out.partNumberWarning).toMatch(/exceeds 9999/);
  });

  it('defaults optional fields on insert', async () => {
    mockState.handler = async (sql) => (/^INSERT INTO raw_materials/.test(sql) ? { rows: [row({ stock_quantity: '0' })] } : { rows: [] });
    await Stock.create(fullFields());
    expect(find(/^INSERT INTO raw_materials/).params).toEqual(['Wire 2', null, '0007L5BR123', 6, 0, 0, null, null, 0]);
  });

  it('a pg error (unique violation) propagates after rollback', async () => {
    mockState.handler = async (sql) => {
      if (/^INSERT INTO raw_materials/.test(sql)) throw pgErr('23505', 'raw_materials_product_code_key');
      return { rows: [] };
    };
    await expect(Stock.create(fullFields())).rejects.toMatchObject({ code: '23505' });
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
    expect(mockState.released).toBe(1);
  });
});

describe('update', () => {
  const lockedRow = row();
  const standardHandler = (extra) => async (sql, params) => {
    if (extra) {
      const r = await extra(sql, params);
      if (r) return r;
    }
    if (/FOR UPDATE$/.test(sql)) return { rows: [lockedRow] };
    if (/^UPDATE raw_materials SET product_name/.test(sql)) {
      return { rows: [row({ product_name: params[0], description: params[1], product_code: params[2], price: params[3], stock_quantity: params[4], qty_required: params[5], location: params[6], image_url: params[7], returnable_qty: params[8] })] };
    }
    return { rows: [] };
  };

  it('keeps every optional field that was not sent (location is NOT wiped)', async () => {
    mockState.handler = standardHandler();
    const item = await Stock.update(7, fullFields(), { userId: 1 });
    const upd = find(/^UPDATE raw_materials SET product_name/);
    expect(upd.params).toEqual(['Wire 2', 'desc', '0007L5BR123', 6, 10, 3, 'Rack A', 'http://img', '4.00', 7]);
    expect(item.location).toBe('Rack A');
    expect(find(/INSERT INTO stock_adjustments/)).toBeUndefined(); // stock unchanged
    expect(find(/FOR UPDATE$/).params).toEqual([7]);
  });

  it('saves returnableQty, qtyRequired, clears description/location when null', async () => {
    mockState.handler = standardHandler();
    const item = await Stock.update(7, fullFields({ returnableQty: 2, qtyRequired: 9, description: null, location: null }));
    const upd = find(/^UPDATE raw_materials SET product_name/);
    expect(upd.params[1]).toBeNull();
    expect(upd.params[5]).toBe(9);
    expect(upd.params[6]).toBeNull();
    expect(upd.params[8]).toBe(2);
    expect(item.returnableQty).toBe(2);
  });

  it('audits a stock change with the given reason', async () => {
    mockState.handler = standardHandler();
    await Stock.update(7, fullFields({ stockQuantity: 7.5, stockChangeReason: 'Recount' }), { userId: 4 });
    const audit = find(/INSERT INTO stock_adjustments/);
    expect(audit.params).toEqual([7, -2.5, 7.5, 'Recount', 'edit', 4]);
    expect(sqls()).toEqual(expect.arrayContaining(['SAVEPOINT stock_audit', 'RELEASE SAVEPOINT stock_audit', 'COMMIT']));
  });

  it('uses a default reason when none is given', async () => {
    mockState.handler = standardHandler();
    await Stock.update(7, fullFields({ stockQuantity: 11 }));
    expect(find(/INSERT INTO stock_adjustments/).params[3]).toBe('Edited in stock form');
  });

  it('missing stock_adjustments table: rolls back the savepoint, warns, still commits', async () => {
    mockState.handler = standardHandler(async (sql) => {
      if (/INSERT INTO stock_adjustments/.test(sql)) throw pgErr('42P01');
      return null;
    });
    const item = await Stock.update(7, fullFields({ stockQuantity: 20 }));
    expect(item.stockQuantity).toBe(20);
    expect(sqls()).toContain('ROLLBACK TO SAVEPOINT stock_audit');
    expect(sqls()).toContain('COMMIT');
    expect(sqls()).not.toContain('ROLLBACK');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/stock_adjustments table missing/));
  });

  it('any other audit failure aborts the whole update', async () => {
    mockState.handler = standardHandler(async (sql) => {
      if (/INSERT INTO stock_adjustments/.test(sql)) throw pgErr('23502');
      return null;
    });
    await expect(Stock.update(7, fullFields({ stockQuantity: 20 }))).rejects.toMatchObject({ code: '23502' });
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
    expect(mockState.released).toBe(1);
  });

  it('not found → NOT_FOUND, released', async () => {
    mockState.handler = async () => ({ rows: [] });
    await expect(Stock.update(99, fullFields())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockState.released).toBe(1);
  });

  it('part number used by another item → PART_NUMBER_TAKEN (checked excluding itself)', async () => {
    mockState.handler = standardHandler(async (sql, params) => {
      if (/part_number = \$1 AND product_id <> \$2/.test(sql)) {
        expect(params).toEqual(['0008', 7]);
        return { rows: [{ product_id: 8, product_name: 'Other' }] };
      }
      return null;
    });
    await expect(Stock.update(7, fullFields({ productCode: '0008L5BR123' }))).rejects.toMatchObject({ code: 'PART_NUMBER_TAKEN' });
    expect(find(/^UPDATE raw_materials SET product_name/)).toBeUndefined();
  });

  it('still releases the client when ROLLBACK itself fails', async () => {
    mockState.handler = async (sql) => {
      if (sql === 'ROLLBACK') throw new Error('connection lost');
      if (/FOR UPDATE$/.test(sql)) throw new Error('boom');
      return { rows: [] };
    };
    await expect(Stock.update(7, fullFields())).rejects.toThrow('boom');
    expect(mockState.released).toBe(1);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('adjustStock', () => {
  const handler = (stock) => async (sql, params) => {
    if (/FOR UPDATE$/.test(sql)) return { rows: [row({ stock_quantity: stock })] };
    if (/^UPDATE raw_materials SET stock_quantity = \$1/.test(sql)) return { rows: [row({ stock_quantity: String(params[0]) })] };
    return { rows: [] };
  };

  it('adds stock under a row lock and audits it', async () => {
    mockState.handler = handler('10.00');
    const item = await Stock.adjustStock({ productId: 7, quantity: 2.5, reason: 'Found', userId: 2 });
    expect(item.stockQuantity).toBe(12.5);
    expect(find(/^UPDATE raw_materials SET stock_quantity/).params).toEqual([12.5, 7]);
    expect(find(/INSERT INTO stock_adjustments/).params).toEqual([7, 2.5, 12.5, 'Found', 'adjust', 2]);
    expect(sqls()).toContain('COMMIT');
  });

  it('removing down to exactly 0 is allowed', async () => {
    mockState.handler = handler('10.00');
    const item = await Stock.adjustStock({ productId: 7, quantity: -10 });
    expect(item.stockQuantity).toBe(0);
  });

  it('refuses to go below 0 → INSUFFICIENT_STOCK, no write', async () => {
    mockState.handler = handler('10.00');
    await expect(Stock.adjustStock({ productId: 7, quantity: -10.01 })).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK', message: 'Cannot remove 10.01: only 10 in stock',
    });
    expect(find(/^UPDATE raw_materials/)).toBeUndefined();
    expect(sqls()).toContain('ROLLBACK');
    expect(mockState.released).toBe(1);
  });

  it('not found → NOT_FOUND', async () => {
    mockState.handler = async () => ({ rows: [] });
    await expect(Stock.adjustStock({ productId: 7, quantity: 1 })).rejects.toBeInstanceOf(StockError);
  });

  it('works before the migration (audit skipped)', async () => {
    const base = handler('1.00');
    mockState.handler = async (sql, params) => {
      if (/INSERT INTO stock_adjustments/.test(sql)) throw pgErr('42P01');
      return base(sql, params);
    };
    const item = await Stock.adjustStock({ productId: 7, quantity: 1 });
    expect(item.stockQuantity).toBe(2);
    expect(sqls()).toContain('COMMIT');
  });
});

describe('acceptReturn', () => {
  const handler = async (sql, params) => {
    if (/FOR UPDATE$/.test(sql)) return { rows: [row({ stock_quantity: '10.00', returnable_qty: '4.00' })] };
    if (/SET stock_quantity = \$1, returnable_qty = \$2/.test(sql)) return { rows: [row({ stock_quantity: String(params[0]), returnable_qty: String(params[1]) })] };
    return { rows: [] };
  };

  it('moves returned units into stock and audits', async () => {
    mockState.handler = handler;
    const item = await Stock.acceptReturn({ productId: 7, quantity: 3, userId: 5 });
    expect(item).toMatchObject({ stockQuantity: 13, returnableQty: 1 });
    expect(find(/SET stock_quantity = \$1, returnable_qty = \$2/).params).toEqual([13, 1, 7]);
    expect(find(/INSERT INTO stock_adjustments/).params).toEqual([7, 3, 13, 'Return accepted', 'return', 5]);
  });

  it('accepting all returnable units is allowed', async () => {
    mockState.handler = handler;
    const item = await Stock.acceptReturn({ productId: 7, quantity: 4 });
    expect(item.returnableQty).toBe(0);
  });

  it('more than returnable → RETURN_EXCEEDS_RETURNABLE, nothing written', async () => {
    mockState.handler = handler;
    await expect(Stock.acceptReturn({ productId: 7, quantity: 4.01 })).rejects.toMatchObject({ code: 'RETURN_EXCEEDS_RETURNABLE' });
    expect(find(/^UPDATE raw_materials/)).toBeUndefined();
    expect(mockState.released).toBe(1);
  });

  it('not found → NOT_FOUND', async () => {
    mockState.handler = async () => ({ rows: [] });
    await expect(Stock.acceptReturn({ productId: 7, quantity: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('getAdjustments', () => {
  it('returns newest-first rows as numbers', async () => {
    mockState.handler = async () => ({
      rows: [{ adjustment_id: 3, product_id: 7, quantity: '-2.00', balance_after: '8.00', reason: 'x', source: 'adjust', created_by: 1, created_by_name: 'Asha', created_at: 't' }],
    });
    const out = await Stock.getAdjustments(7, 20);
    expect(out).toEqual({
      available: true,
      data: [{ adjustmentId: 3, productId: 7, quantity: -2, balanceAfter: 8, reason: 'x', source: 'adjust', createdBy: 1, createdByName: 'Asha', createdAt: 't' }],
    });
    expect(mockState.poolLog[0].params).toEqual([7, 20]);
    expect(mockState.poolLog[0].sql).toMatch(/ORDER BY sa.created_at DESC/);
  });

  it('keeps null balance / user as null', async () => {
    mockState.handler = async () => ({ rows: [{ adjustment_id: 1, product_id: 7, quantity: '1', balance_after: null, created_by: null }] });
    const out = await Stock.getAdjustments(7);
    expect(out.data[0]).toMatchObject({ balanceAfter: null, createdBy: null, createdByName: null });
  });

  it('table missing → available:false', async () => {
    mockState.handler = async () => { throw pgErr('42P01'); };
    expect(await Stock.getAdjustments(7)).toEqual({ available: false, data: [] });
  });

  it('other errors propagate', async () => {
    mockState.handler = async () => { throw pgErr('57P01'); };
    await expect(Stock.getAdjustments(7)).rejects.toMatchObject({ code: '57P01' });
  });
});

describe('delete / getById / setImageUrl', () => {
  it('delete returns the id', async () => {
    mockState.handler = async () => ({ rows: [{ product_id: 7 }] });
    expect(await Stock.delete(7)).toEqual({ product_id: 7, productId: 7 });
  });
  it('delete of a missing item → NOT_FOUND', async () => {
    await expect(Stock.delete(7)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('delete of an in-use item lets the FK error through', async () => {
    mockState.handler = async () => { throw pgErr('23503'); };
    await expect(Stock.delete(7)).rejects.toMatchObject({ code: '23503' });
  });
  it('getById returns null when missing, item otherwise', async () => {
    expect(await Stock.getById(1)).toBeNull();
    mockState.handler = async () => ({ rows: [row()] });
    expect((await Stock.getById(7)).stockQuantity).toBe(10);
  });
  it('setImageUrl returns the item or null', async () => {
    expect(await Stock.setImageUrl(7, 'u')).toBeNull();
    mockState.handler = async () => ({ rows: [row({ image_url: 'u' })] });
    expect((await Stock.setImageUrl(7, 'u')).imageUrl).toBe('u');
  });
});
