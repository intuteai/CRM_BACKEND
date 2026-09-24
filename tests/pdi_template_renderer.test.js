const PDFDocument = require('pdfkit');
const { registerFonts } = require('../models/operations/pdi/primitives');
const { renderTemplate } = require('../models/operations/pdi/renderer');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const SYNTHETIC_TEMPLATE = {
  id: 'synthetic-test',
  name: 'Synthetic Test Template',
  version: 1,
  pages: [
    {
      sections: [
        {
          type: 'header', gap: 4,
          companyName: 'Test Co.', formatNo: 'F/1', revNo: '00', effDate: '01/01/2026',
          logoAsset: 'does-not-exist.png', // exercises the "missing asset" path
          infoFields: [['Customer:', (d) => d.customer || '', 'Date:', () => '']],
        },
        {
          // repeatable + grouped 2-level header + pagination (30 rows forces a continuation page)
          type: 'table', gap: 4,
          mode: 'repeatable', dataKey: 'rows', filterRow: (r) => !!r.id,
          columns: [
            { key: 'id', label: 'ID', w: 30, align: 'center' },
            { key: 'a', label: 'A', w: 60, align: 'center', group: 'Group' },
            { key: 'b', label: 'B', w: 60, align: 'center', group: 'Group' },
            { key: 'notes', label: 'Notes', align: 'left' },
          ],
          headerHeight: 36, rowHeight: 14,
          footerHeight: () => 100,
        },
        {
          // fixed + computed columns + spec row
          type: 'table', gap: 4,
          mode: 'fixed', dataKey: 'checks',
          fixedRows: () => [{ key: 'x', label: 'Check X' }],
          columns: [
            { label: 'Check', w: 200, align: 'left', value: (row) => row.label },
            { label: 'Result', align: 'center', value: (row, sectionData) => (sectionData[row.key] || {}).measured || 'GO' },
          ],
          headerHeight: 14, rowHeight: 14,
          specRow: { fill: '#fffde7', firstColLabel: 'Spec', build: () => ({}) },
        },
        { type: 'text', gap: 4, label: 'Remarks:', dataKey: 'remarks', default: 'OK' },
        { type: 'signature', roles: [{ key: 'a_sig', label: 'A' }, { key: 'b_sig', label: 'B' }, { key: 'c_sig', label: 'C' }] },
      ],
    },
    {
      sections: [
        {
          type: 'image', title: 'Page 2', dataKey: 'missing_image', height: 80,
          placeholder: {
            text: () => 'no image',
            annotations: [{ text: 'note', xFrac: 0.1, y: 4, wFrac: 0.5 }],
          },
        },
        { type: 'image', dataKey: 'real_image', height: 80 }, // real embedded image, no placeholder needed
      ],
    },
    {
      sections: [
        { type: 'photo', mode: 'freeform', dataKey: 'photos' },
      ],
    },
    {
      sections: [
        {
          type: 'photo', mode: 'fixed-slots', dataKey: 'slot_photos',
          slots: [{ key: 'front', label: 'Front' }, { key: 'back', label: 'Back' }],
        },
      ],
    },
  ],
};

describe('PDI template renderer', () => {
  it('renders every section type, including pagination overflow, without throwing', async () => {
    // 80 rows at 14pt each (1120pt) comfortably exceeds the ~660pt of table
    // space actually available below the header on an A4 page, forcing a
    // real continuation page — 30 rows (420pt) was not enough to overflow.
    const rows = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, a: 'x', b: 'y', notes: 'n' }));
    const data = {
      customer: 'Acme',
      rows,
      checks: { x: { measured: 'GO' } },
      remarks: 'All good',
      a_sig: 'Alice', b_sig: 'Bob', c_sig: 'Carol',
      real_image: TINY_PNG,
      photos: [{ label: 'Shot 1', image: TINY_PNG }, { label: '', image: '' }],
      slot_photos: { front: TINY_PNG },
    };

    const doc = new PDFDocument({
      size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 },
      autoFirstPage: false, bufferPages: true,
    });
    registerFonts(doc);
    renderTemplate(doc, SYNTHETIC_TEMPLATE, data);
    // Must read this before doc.end() — PDFKit flushes and clears its
    // buffered-pages state once the document is finalized, so checking
    // afterward always reports 0 regardless of how many pages were drawn.
    const pageCount = doc.bufferedPageRange().count;
    doc.end();

    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
    // 80 rows at headerHeight 36 + 14/row easily overflows page 1 onto a
    // continuation page, so the real page count must exceed the 4 declared pages.
    expect(pageCount).toBeGreaterThan(4);
  });

  it('throws a clear error for an unknown section type', () => {
    const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    const badTemplate = { pages: [{ sections: [{ type: 'nope' }] }] };
    expect(() => renderTemplate(doc, badTemplate, {})).toThrow(/Unknown PDI template section type/);
  });

  it('throws a clear error for a table section with an invalid/missing mode', () => {
    const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    const badTemplate = {
      pages: [{
        sections: [{
          type: 'table', dataKey: 'rows',
          columns: [{ key: 'id', label: 'ID', w: 60, align: 'center' }],
          headerHeight: 14, rowHeight: 14,
        }],
      }],
    };
    expect(() => renderTemplate(doc, badTemplate, {})).toThrow(/invalid mode/);
  });

  it('throws a clear error for a photo section with an invalid/missing mode', () => {
    const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    const badTemplate = {
      pages: [{ sections: [{ type: 'photo', dataKey: 'photos' }] }],
    };
    expect(() => renderTemplate(doc, badTemplate, {})).toThrow(/invalid mode/);
  });

  it('renders a repeatable table section with zero matching rows without throwing', async () => {
    const template = {
      pages: [{
        sections: [{
          type: 'table',
          mode: 'repeatable', dataKey: 'rows',
          columns: [{ key: 'id', label: 'ID', w: 60, align: 'center' }],
          headerHeight: 14, rowHeight: 14,
        }],
      }],
    };
    const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    expect(() => renderTemplate(doc, template, { rows: [] })).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders a signature section with an empty roles array without throwing', async () => {
    const template = {
      pages: [{ sections: [{ type: 'signature', roles: [] }] }],
    };
    const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    expect(() => renderTemplate(doc, template, {})).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders a header section with formatNo/revNo/effDate omitted, with no literal "undefined" text in the PDF', async () => {
    const template = {
      pages: [{
        sections: [{
          type: 'header',
          companyName: 'Test Co.',
          infoFields: [['Customer:', () => 'Acme', 'Date:', () => '']],
        }],
      }],
    };
    const doc = new PDFDocument({
      size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 },
      autoFirstPage: false, bufferPages: true,
    });
    registerFonts(doc);
    expect(() => renderTemplate(doc, template, {})).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buf.toString('latin1').includes('undefined')).toBe(false);
  });

  it('renders a header section with extraFormatLines without throwing', async () => {
    const template = {
      pages: [{
        sections: [{
          type: 'header',
          companyName: 'Test Co.', formatNo: 'F/1', revNo: '00', effDate: '01/01/2026',
          extraFormatLines: ['REV DT: 11/10/2024'],
          infoFields: [['Customer:', () => 'Acme', 'Date:', () => '']],
        }],
      }],
    };
    const doc = new PDFDocument({
      size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 },
      autoFirstPage: false, bufferPages: true,
    });
    registerFonts(doc);
    expect(() => renderTemplate(doc, template, {})).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('spec row labelSpan merges leading columns\' width for the label cell (backend-changes-v1.0.8.md item 2)', async () => {
    // Mirrors general.js's ECOLS/MCOLS shape: a spec row's first two columns
    // (S.No, Motor Sr.No) are always blank in that row, so the label can
    // safely use both widths. Before labelSpan existed, the label was
    // confined to the first column's own width (22) regardless of what
    // string it held, which is what forced "Specification" to render as
    // "Spe…" -- ellipsis-truncated by PDFKit at draw time, not because the
    // stored label text was ever actually "Spe…".
    const template = {
      pages: [{
        sections: [{
          type: 'table',
          mode: 'fixed', dataKey: 'rows',
          fixedRows: () => [],
          columns: [
            { key: 'sno', label: 'S.No', w: 22, align: 'center' },
            { key: 'sr',  label: 'Sr',   w: 56, align: 'center' },
            { key: 'val', label: 'Val',  w: 60, align: 'center' },
          ],
          headerHeight: 14, rowHeight: 14,
          specRow: { fill: '#fffde7', firstColLabel: 'Specification', labelSpan: 2, build: () => ({ val: '10' }) },
        }],
      }],
    };
    const doc = new PDFDocument({
      size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 },
      autoFirstPage: false, bufferPages: true,
    });
    registerFonts(doc);

    const rectWidths = [];
    const originalRect = doc.rect.bind(doc);
    doc.rect = (x, y, w, h) => { rectWidths.push(w); return originalRect(x, y, w, h); };

    renderTemplate(doc, template, {});
    doc.end();
    await bufferPdf(doc);

    // 22 + 56 = 78 -- the merged label cell's width. Nothing else in this
    // template is 78pt wide, so its presence is unambiguous.
    expect(rectWidths).toContain(78);
    // The label cell's own 22pt width must not appear a second time on its
    // own (that would mean it was drawn narrow, not merged) -- the header
    // row's S.No column (also 22) is the only other legitimate source of a
    // bare 22, so this only proves the merge, not that 22 never appears at all.
  });

  it('spec row without labelSpan keeps the old behavior: the label cell is exactly the first column\'s own width', async () => {
    const template = {
      pages: [{
        sections: [{
          type: 'table',
          mode: 'fixed', dataKey: 'rows',
          fixedRows: () => [],
          columns: [
            { key: 'sno', label: 'S.No', w: 22, align: 'center' },
            { key: 'sr',  label: 'Sr',   w: 56, align: 'center' },
          ],
          headerHeight: 14, rowHeight: 14,
          specRow: { fill: '#fffde7', firstColLabel: 'Spec', build: () => ({}) },
        }],
      }],
    };
    const doc = new PDFDocument({
      size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 },
      autoFirstPage: false, bufferPages: true,
    });
    registerFonts(doc);

    const rectWidths = [];
    const originalRect = doc.rect.bind(doc);
    doc.rect = (x, y, w, h) => { rectWidths.push(w); return originalRect(x, y, w, h); };

    renderTemplate(doc, template, {});
    doc.end();
    await bufferPdf(doc);

    expect(rectWidths).not.toContain(78);
  });

  describe('spec row sizes itself to its text', () => {
    // 22 + 56 label span, then a 40pt value column -- as narrow as General's
    // Shaft Length / Mounting PCD columns.
    const specTemplate = (specText) => ({
      pages: [{
        sections: [{
          type: 'table',
          mode: 'fixed', dataKey: 'rows',
          fixedRows: () => [],
          columns: [
            { key: 'sno', label: 'S.No', w: 22, align: 'center' },
            { key: 'sr',  label: 'Sr',   w: 56, align: 'center' },
            { key: 'val', label: 'Val',  w: 40, align: 'center' },
          ],
          headerHeight: 14, rowHeight: 14,
          specRow: { fill: '#fffde7', firstColLabel: 'Specification', labelSpan: 2, build: () => ({ val: specText }) },
        }],
      }],
    });
    async function rectHeights(specText) {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
      registerFonts(doc);
      const heights = [];
      const originalRect = doc.rect.bind(doc);
      doc.rect = (x, y, w, h) => { heights.push(h); return originalRect(x, y, w, h); };
      renderTemplate(doc, specTemplate(specText), {});
      doc.end();
      await bufferPdf(doc);
      return heights;
    }

    it('keeps a short value on a normal row (same height as a data row), so it looks as it always did', async () => {
      expect(Math.max(...(await rectHeights('40 ±0.5')))).toBe(14);
    });

    it('grows for a value too wide for one line, so it wraps instead of being clipped', async () => {
      expect(Math.max(...(await rectHeights('152.74 +0.15/-0.10')))).toBeGreaterThan(14);
    });

    it('is no taller than its text needs (two wrapped lines, not a fixed tall row)', async () => {
      expect(Math.max(...(await rectHeights('19.0 +0/-0.02')))).toBeLessThanOrEqual(26);
    });

    it('an empty spec row is still a normal row', async () => {
      expect(Math.max(...(await rectHeights('')))).toBe(14);
    });
  });

  it('a signature role\'s value(data) is used instead of a plain data[role.key] lookup when provided', async () => {
    // Mirrors general.js's MECH_SIG_ROLES: the Mechanical page's signature
    // falls back to the Electrical one for a report saved before it had its
    // own (backend-changes-v1.0.8.md item 3), using ?? so a deliberately
    // blank value is respected rather than papered over.
    const template = {
      pages: [{
        sections: [{
          type: 'signature',
          roles: [
            { key: 'prepared_by_mechanical', label: 'Prepared By',
              value: (d) => d.prepared_by_mechanical ?? d.prepared_by ?? '' },
          ],
        }],
      }],
    };
    const doc = new PDFDocument({
      size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 },
      autoFirstPage: false, bufferPages: true,
    });
    registerFonts(doc);

    const drawnTexts = [];
    const originalText = doc.text.bind(doc);
    doc.text = (str, ...rest) => { drawnTexts.push(str); return originalText(str, ...rest); };

    // Old-shaped report: no prepared_by_mechanical at all -- falls back.
    renderTemplate(doc, template, { prepared_by: 'S. Choudhary' });
    expect(drawnTexts).toContain('S. Choudhary');

    // New-shaped report with its own mechanical name -- does not fall back.
    drawnTexts.length = 0;
    renderTemplate(doc, template, { prepared_by: 'S. Choudhary', prepared_by_mechanical: 'R. Kumar' });
    expect(drawnTexts).toContain('R. Kumar');
    expect(drawnTexts).not.toContain('S. Choudhary');

    // Deliberately left blank on a new-shaped report -- '' is respected,
    // never falls back to the Electrical name (?? not ||).
    drawnTexts.length = 0;
    renderTemplate(doc, template, { prepared_by: 'S. Choudhary', prepared_by_mechanical: '' });
    expect(drawnTexts).toContain('');
    expect(drawnTexts).not.toContain('S. Choudhary');

    doc.end();
    await bufferPdf(doc);
  });

  it('renders a table section title/caption and actually draws it (not just accepts and ignores it)', async () => {
    const template = {
      pages: [{
        sections: [{
          type: 'table',
          title: 'A. Test Title',
          mode: 'fixed', dataKey: 'checks',
          fixedRows: () => [{ key: 'x', label: 'Check X' }],
          columns: [
            { label: 'Check', w: 200, align: 'left', value: (row) => row.label },
            { label: 'Result', align: 'center', value: () => 'GO' },
          ],
          headerHeight: 14, rowHeight: 14,
        }],
      }],
    };
    const doc = new PDFDocument({
      size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 },
      autoFirstPage: false, bufferPages: true,
    });
    registerFonts(doc);

    // This repo always embeds Roboto TTF fonts (assets/fonts/*.ttf exist),
    // so drawn text is encoded in the content stream as CID glyph-index hex
    // strings (e.g. `<0001000200030004> TJ`), not literal ASCII bytes —
    // even with stream compression disabled. So a raw-buffer substring
    // search can't verify the title was drawn; spy on doc.text() (which
    // primitives.t() calls under the hood) to capture what was actually
    // handed to PDFKit for drawing instead.
    const drawnTexts = [];
    const originalText = doc.text.bind(doc);
    doc.text = (str, ...rest) => { drawnTexts.push(str); return originalText(str, ...rest); };

    expect(() => renderTemplate(doc, template, {})).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(drawnTexts).toContain('A. Test Title');
  });
});
