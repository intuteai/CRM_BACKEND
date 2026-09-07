const PDFDocument = require('pdfkit');
const {
  decodeImageDataUri, resolveCols, fmtDate, registerFonts, getFonts,
} = require('../models/operations/pdi/primitives');

// A real (tiny, valid) 1x1 transparent PNG, base64-encoded.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('pdi primitives', () => {
  it('decodeImageDataUri accepts a valid PNG data URI', () => {
    const buf = decodeImageDataUri(TINY_PNG);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('decodeImageDataUri rejects non-image / malformed input', () => {
    expect(decodeImageDataUri(null)).toBeNull();
    expect(decodeImageDataUri('not a data uri')).toBeNull();
    expect(decodeImageDataUri('data:image/png;base64,not-base64!!!')).toBeNull();
  });

  it('resolveCols splits remaining width evenly across flex columns', () => {
    const cols = resolveCols(
      [{ key: 'a', w: 100 }, { key: 'b' }, { key: 'c' }],
      300
    );
    expect(cols[0].w).toBe(100);
    expect(cols[1].w).toBe(100); // (300-100)/2
    expect(cols[2].w).toBe(100);
  });

  it('resolveCols enforces a 40pt floor on flex columns', () => {
    const cols = resolveCols([{ key: 'a', w: 290 }, { key: 'b' }], 300);
    expect(cols[1].w).toBe(40);
  });

  it('fmtDate formats as DD/MM/YYYY in UTC', () => {
    expect(fmtDate('2026-01-05T00:00:00.000Z')).toBe('05/01/2026');
    expect(fmtDate(null)).toBe('');
    expect(fmtDate('not a date')).toBe('');
  });

  it('registerFonts falls back to Helvetica when Roboto assets are missing, without throwing', () => {
    const doc = new PDFDocument({ autoFirstPage: false });
    expect(() => registerFonts(doc)).not.toThrow();
    const { F, FB } = getFonts();
    expect(typeof F).toBe('string');
    expect(typeof FB).toBe('string');
  });
});
