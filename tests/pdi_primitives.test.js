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

  it('decodeImageDataUri rejects PNG with valid signature but corrupt IDAT data', () => {
    // Construct a PNG with valid signature + IDAT chunk with garbage (non-zlib) data + IEND.
    // PNG signature: 8 bytes [137, 80, 78, 71, 13, 10, 26, 10]
    // IDAT chunk: [4-byte length][4-byte type 'IDAT'][garbage bytes][4-byte CRC]
    // IEND chunk: [4-byte length=0][4-byte type 'IEND'][0 bytes data][4-byte CRC]
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    // Create IDAT chunk with garbage (non-zlib) data
    const idatData = Buffer.from([0xFF, 0xFE, 0xFD, 0xFC]); // garbage bytes, not zlib
    const idatChunk = Buffer.alloc(4 + 4 + idatData.length + 4);
    idatChunk.writeUInt32BE(idatData.length, 0);
    idatChunk.write('IDAT', 4);
    idatData.copy(idatChunk, 8);
    idatChunk.writeUInt32BE(0x12345678, 8 + idatData.length); // dummy CRC

    // Create IEND chunk
    const iendChunk = Buffer.alloc(4 + 4 + 4);
    iendChunk.writeUInt32BE(0, 0);
    iendChunk.write('IEND', 4);
    iendChunk.writeUInt32BE(0x87654321, 8); // dummy CRC

    const corruptPng = Buffer.concat([signature, idatChunk, iendChunk]);
    const dataUri = 'data:image/png;base64,' + corruptPng.toString('base64');

    expect(decodeImageDataUri(dataUri)).toBeNull();
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

  it('registerFonts picks up Roboto when font assets are present', () => {
    // This test verifies the actual behavior in the repo where Roboto files exist.
    const doc = new PDFDocument({ autoFirstPage: false });
    expect(() => registerFonts(doc)).not.toThrow();
    const { F, FB } = getFonts();
    expect(F).toBe('Roboto');
    expect(FB).toBe('Roboto-Bold');
  });

  it('registerFonts falls back to Helvetica when Roboto assets are missing', () => {
    // Mock fs.existsSync to return false for Roboto files, then reload the module.
    jest.doMock('fs', () => {
      const actualFs = jest.requireActual('fs');
      return {
        ...actualFs,
        existsSync: (path) => {
          // Return false for Roboto files, true for everything else
          if (typeof path === 'string' && path.includes('Roboto')) {
            return false;
          }
          return actualFs.existsSync(path);
        },
      };
    });

    jest.resetModules();
    const { registerFonts: registerFontsMocked, getFonts: getFontsMocked } = require('../models/operations/pdi/primitives');

    const doc = new PDFDocument({ autoFirstPage: false });
    expect(() => registerFontsMocked(doc)).not.toThrow();
    const { F, FB } = getFontsMocked();
    expect(F).toBe('Helvetica');
    expect(FB).toBe('Helvetica-Bold');

    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
  });
});
