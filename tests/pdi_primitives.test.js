const PDFDocument = require('pdfkit');
const {
  decodeImageDataUri, resolveCols, fmtDate, registerFonts, getFonts,
  stripEmoji, t, drawPaginatedRows, PAGE_H, BOT_M,
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

describe('stripEmoji', () => {
  it('removes emoji, skin tones, variation selectors and ZWJ sequences', () => {
    expect(stripEmoji('OK 👍✅')).toBe('OK ');
    expect(stripEmoji('a👨‍👩‍👧b')).toBe('ab');
    expect(stripEmoji('x👍🏽y')).toBe('xy');
    expect(stripEmoji('❤️ok')).toBe('ok');
  });

  it('leaves ordinary text, symbols and other scripts alone', () => {
    expect(stripEmoji('384V ±5% Ω µ °C – “q” © ®')).toBe('384V ±5% Ω µ °C – “q” © ®');
    expect(stripEmoji('सभी ठीक')).toBe('सभी ठीक');
    expect(stripEmoji('plain ascii')).toBe('plain ascii');
  });
});

describe('t()', () => {
  function capture(text, opts) {
    const doc = new PDFDocument({ autoFirstPage: false });
    registerFonts(doc);
    doc.addPage();
    const calls = [];
    const original = doc.text.bind(doc);
    doc.text = (str, x, y, o) => { calls.push({ str, o }); return original(str, x, y, o); };
    t(doc, text, 10, 10, 200, opts);
    return calls[0];
  }

  it('is single-line with ellipsis by default', () => {
    const { o } = capture('hello');
    expect(o.lineBreak).toBe(false);
    expect(o.ellipsis).toBe(true);
  });

  it('wraps within maxHeight and ellipsizes there', () => {
    const { o } = capture('a\nb', { maxHeight: 30 });
    expect(o.lineBreak).toBe(true);
    expect(o.height).toBe(30);
    expect(o.ellipsis).toBe(true);
  });

  it('strips emoji and does not crash on Devanagari or non-strings', () => {
    expect(capture('ok 🚀').str).toBe('ok ');
    expect(() => capture('जितेंद्र')).not.toThrow();
    expect(capture(0).str).toBe('0');
    expect(capture(null).str).toBe('');
  });
});

describe('drawPaginatedRows', () => {
  // Lays out `n` rows starting at `startY`, recording which page each row and
  // the footer land on.
  function layout(n, { startY = 100, rowHeight = 14, footerHeight = 92 } = {}) {
    let page = 0;
    const rowPages = [];
    const doc = { addPage: () => { page++; } };
    const y = drawPaginatedRows(doc, {
      rows: Array.from({ length: n }, (_, i) => i),
      drawRow: (d, row, ry) => { rowPages.push(page); return ry + rowHeight; },
      rowHeight, y: startY, footerHeight,
      redrawHeader: (py) => py + 14,
    });
    return { rowPages, footerFits: y + footerHeight <= PAGE_H - BOT_M, pages: page + 1 };
  }

  it('never leaves fewer than 3 rows above the footer on a continuation page', () => {
    for (let n = 3; n <= 120; n++) {
      const { rowPages, footerFits } = layout(n);
      const last = rowPages[rowPages.length - 1];
      expect(rowPages.filter((p) => p === last).length).toBeGreaterThanOrEqual(Math.min(3, n));
      expect(footerFits).toBe(true);
    }
  });

  it('does not break when everything fits', () => {
    const { pages } = layout(10);
    expect(pages).toBe(1);
  });

  it('without a footer, fills each page fully', () => {
    const { rowPages } = layout(60, { footerHeight: 0 });
    const perPage = rowPages.filter((p) => p === 0).length;
    expect(perPage).toBe(Math.floor((PAGE_H - BOT_M - 100) / 14));
  });
});
