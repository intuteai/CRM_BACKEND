// Raw-material stock API input validation (pure functions, no database).
const v = require('../controllers/core/stock.validation');

const base = () => ({ productName: 'Copper wire', productCode: '0042L5BR123', price: 10 });
const fieldsOf = (r) => r.errors.map((e) => e.field);

describe('validateStockBody', () => {
  it('accepts a minimal valid body and trims / upper-cases', () => {
    const r = v.validateStockBody({ productName: '  Wire  ', productCode: ' 0042l5br123 ', price: 0 });
    expect(r.errors).toEqual([]);
    expect(r.value).toMatchObject({ productName: 'Wire', productCode: '0042L5BR123', price: 0, partNumberAuto: false });
  });

  it('only returns optional fields that were sent (so update can keep the rest)', () => {
    const r = v.validateStockBody(base());
    expect(Object.keys(r.value).sort()).toEqual(['partNumberAuto', 'price', 'productCode', 'productName']);
  });

  it.each([null, undefined, 'x', [], 5])('rejects a non-object body (%p)', (body) => {
    expect(fieldsOf(v.validateStockBody(body))).toEqual(['body']);
  });

  it.each([
    [{ productName: '' }, 'productName'],
    [{ productName: '   ' }, 'productName'],
    [{ productName: 5 }, 'productName'],
    [{ productName: 'x'.repeat(101) }, 'productName'],
    [{ productCode: undefined }, 'productCode'],
    [{ productCode: '0042L5BR12' }, 'productCode'],
    [{ productCode: '0042L5BR1234' }, 'productCode'],
    [{ productCode: 'ABCDL5BR123' }, 'productCode'],
    [{ productCode: '0042L5BR12X' }, 'productCode'],
    [{ productCode: '0042L-BR123' }, 'productCode'],
    [{ price: undefined }, 'price'],
    [{ price: null }, 'price'],
    [{ price: '10' }, 'price'],
    [{ price: -1 }, 'price'],
    [{ price: NaN }, 'price'],
    [{ price: Infinity }, 'price'],
    [{ price: 100000000 }, 'price'],
    [{ stockQuantity: -0.01 }, 'stockQuantity'],
    [{ stockQuantity: '5' }, 'stockQuantity'],
    [{ stockQuantity: 1e9 }, 'stockQuantity'],
    [{ returnableQty: -1 }, 'returnableQty'],
    [{ returnableQty: 'a' }, 'returnableQty'],
    [{ qtyRequired: 1.5 }, 'qtyRequired'],
    [{ qtyRequired: -1 }, 'qtyRequired'],
    [{ qtyRequired: 2147483648 }, 'qtyRequired'],
    [{ qtyRequired: '3' }, 'qtyRequired'],
    [{ description: 5 }, 'description'],
    [{ description: 'x'.repeat(5001) }, 'description'],
    [{ location: 'x'.repeat(101) }, 'location'],
    [{ location: {} }, 'location'],
    [{ imageUrl: 3 }, 'imageUrl'],
    [{ stockChangeReason: 'x'.repeat(501) }, 'stockChangeReason'],
    [{ part_number_auto: 'yes' }, 'part_number_auto'],
  ])('rejects %p', (patch, field) => {
    const r = v.validateStockBody({ ...base(), ...patch });
    expect(fieldsOf(r)).toEqual([field]);
    expect(typeof r.errors[0].message).toBe('string');
  });

  it('reports every bad field at once', () => {
    const r = v.validateStockBody({ productName: '', productCode: 'x', price: -1 });
    expect(fieldsOf(r)).toEqual(['productName', 'productCode', 'price']);
  });

  it('rounds amounts to 2 decimals and allows the column maximum', () => {
    const r = v.validateStockBody({ ...base(), stockQuantity: 2.349, returnableQty: 99999999.99 });
    expect(r.errors).toEqual([]);
    expect(r.value.stockQuantity).toBe(2.35);
    expect(r.value.returnableQty).toBe(99999999.99);
  });

  it('treats null/"" text as clear (null) and leaves undefined out', () => {
    const r = v.validateStockBody({ ...base(), description: '', location: null, stockChangeReason: '  why  ' });
    expect(r.value.description).toBeNull();
    expect(r.value.location).toBeNull();
    expect(r.value.stockChangeReason).toBe('why');
    expect('imageUrl' in r.value).toBe(false);
  });

  it('null optional numbers count as "not sent"', () => {
    const r = v.validateStockBody({ ...base(), stockQuantity: null, qtyRequired: null, returnableQty: null });
    expect(r.errors).toEqual([]);
    expect(r.value).not.toHaveProperty('stockQuantity');
    expect(r.value).not.toHaveProperty('qtyRequired');
    expect(r.value).not.toHaveProperty('returnableQty');
  });

  it('accepts part_number_auto true', () => {
    expect(v.validateStockBody({ ...base(), part_number_auto: true }).value.partNumberAuto).toBe(true);
  });
});

describe('validateAdjustBody', () => {
  it.each([[5, 5], [-2.5, -2.5], [1.004, 1]])('accepts %p', (q, out) => {
    const r = v.validateAdjustBody({ quantity: q, reason: ' Count ' });
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ quantity: out, reason: 'Count' });
  });
  it.each([0, 0.001, '5', null, undefined, NaN, 1e9, -1e9])('rejects quantity %p', (q) => {
    expect(fieldsOf(v.validateAdjustBody({ quantity: q }))).toEqual(['quantity']);
  });
  it('rejects a long reason and a missing body', () => {
    expect(fieldsOf(v.validateAdjustBody({ quantity: 1, reason: 'x'.repeat(501) }))).toEqual(['reason']);
    expect(fieldsOf(v.validateAdjustBody(undefined))).toEqual(['quantity']);
  });
});

describe('validateAcceptReturnBody', () => {
  it('accepts a positive amount', () => {
    expect(v.validateAcceptReturnBody({ quantity: 3 })).toEqual({ errors: [], value: { quantity: 3 } });
  });
  it.each([0, -1, '2', null, undefined, NaN, 1e9])('rejects %p', (q) => {
    expect(fieldsOf(v.validateAcceptReturnBody({ quantity: q }))).toEqual(['quantity']);
  });
  it('rejects a missing body', () => {
    expect(fieldsOf(v.validateAcceptReturnBody(null))).toEqual(['quantity']);
  });
});

describe('parseProductId', () => {
  it.each([['1', 1], ['170', 170], [42, 42], [' 7 ', 7]])('parses %p', (raw, out) => {
    expect(v.parseProductId(raw)).toBe(out);
  });
  it.each(['0', '-1', 'abc', '1.5', '1e3', '', '2147483648', undefined, null, {}])('rejects %p', (raw) => {
    expect(v.parseProductId(raw)).toBeNull();
  });
});

describe('parsePaging', () => {
  it('defaults', () => expect(v.parsePaging({})).toEqual({ limit: 10, offset: 0 }));
  it('clamps limit to 10000', () => expect(v.parsePaging({ limit: '50000' }).limit).toBe(10000));
  it('keeps the big page sizes the pages use', () => expect(v.parsePaging({ limit: '5000', offset: '20' })).toEqual({ limit: 5000, offset: 20 }));
  it.each([['abc', 'x'], ['-5', '-3'], ['0', '0']])('falls back for limit %p offset %p', (limit, offset) => {
    expect(v.parsePaging({ limit, offset })).toEqual({ limit: 10, offset: 0 });
  });
  it('handles a missing query', () => expect(v.parsePaging(undefined)).toEqual({ limit: 10, offset: 0 }));
});
