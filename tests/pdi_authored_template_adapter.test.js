const PDFDocument = require('pdfkit');
const { registerFonts, M } = require('../models/operations/pdi/primitives');
const { renderTemplate } = require('../models/operations/pdi/renderer');
const { hydrateTemplate, buildSampleData } = require('../models/operations/pdi/authoredTemplate');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function renderDefinition(definition, data) {
  const hydrated = hydrateTemplate(definition);
  const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: M, right: M }, autoFirstPage: false, bufferPages: true });
  registerFonts(doc);
  renderTemplate(doc, hydrated, data);
  doc.end();
  return doc;
}

const SAMPLE_DEFINITION = {
  pages: [
    {
      sections: [
        {
          type: 'header', gap: 4,
          companyName: 'Test Co.', formatNo: 'F/1', revNo: '00', effDate: '01/01/2026',
          infoFields: [
            { leftLabel: 'Customer:', leftKey: 'customer_name', leftFormat: 'text', rightLabel: 'Date:', rightKey: 'date', rightFormat: 'date' },
          ],
        },
        {
          type: 'table', gap: 4,
          mode: 'repeatable', dataKey: 'rows', filterKey: 'sno',
          columns: [
            { key: 'sno', label: 'S.No', w: 30, align: 'center', cell: { source: 'row' } },
            { key: 'notes', label: 'Notes', align: 'left', cell: { source: 'row' } },
          ],
          headerHeight: 20, rowHeight: 14,
        },
        {
          type: 'table', gap: 4,
          mode: 'fixed', dataKey: 'checks',
          fixedRows: [{ key: 'check_a', label: 'Check A' }],
          columns: [
            { key: 'label', label: 'Check', w: 200, align: 'left', cell: { source: 'row' } },
            { key: 'spec', label: 'Spec', align: 'center', cell: { source: 'constant', value: 'Go/NG' } },
            { key: 'measured', label: 'Result', align: 'center', cell: { source: 'sectionData', subfield: 'measured', default: 'GO' } },
          ],
          headerHeight: 14, rowHeight: 14,
        },
        { type: 'text', gap: 4, label: 'Remarks:', dataKey: 'remarks', default: 'OK' },
        { type: 'signature', roles: [{ key: 'prepared_by', label: 'Prepared By' }] },
      ],
    },
    {
      sections: [
        { type: 'photo', mode: 'freeform', dataKey: 'photos' },
      ],
    },
  ],
};

describe('authored template adapter', () => {
  it('hydrates a declarative definition into something renderTemplate can draw', async () => {
    const data = {
      pdi_no: 'TEST-1', customer_name: 'Acme', date: '2026-01-05',
      rows: [{ sno: 1, notes: 'n1' }, { sno: 2, notes: 'n2' }],
      checks: { check_a: { measured: 'GO' } },
      remarks: 'All good', prepared_by: 'Alice',
      photos: [],
    };
    const doc = renderDefinition(SAMPLE_DEFINITION, data);
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('a "row"-sourced column falls back to plain row[key] lookup (undefined value fn)', () => {
    const hydrated = hydrateTemplate(SAMPLE_DEFINITION);
    const repeatableTable = hydrated.pages[0].sections[1];
    expect(repeatableTable.columns[0].value).toBeUndefined();
  });

  it('a "constant"-sourced column always returns its fixed value regardless of row/data', () => {
    const hydrated = hydrateTemplate(SAMPLE_DEFINITION);
    const fixedTable = hydrated.pages[0].sections[2];
    const specCol = fixedTable.columns[1];
    expect(specCol.value({ key: 'check_a' }, {})).toBe('Go/NG');
  });

  it('a "sectionData"-sourced column reads sectionData[row.key][subfield], falling back to its default', () => {
    const hydrated = hydrateTemplate(SAMPLE_DEFINITION);
    const fixedTable = hydrated.pages[0].sections[2];
    const measuredCol = fixedTable.columns[2];
    expect(measuredCol.value({ key: 'check_a' }, { check_a: { measured: 'NG' } })).toBe('NG');
    expect(measuredCol.value({ key: 'check_a' }, {})).toBe('GO'); // default, no data supplied
  });

  it('computes footerHeight automatically from known-height sections that follow', () => {
    const hydrated = hydrateTemplate(SAMPLE_DEFINITION);
    const repeatableTable = hydrated.pages[0].sections[1];
    // fixed table (14 header + 1*14 row + 4 gap) + text (40 + 4 gap) + signature (36) = 112
    expect(repeatableTable.footerHeight()).toBe(112);
  });

  it('falls back to a fixed buffer when a following section has data-dependent height', () => {
    const definitionWithPhotoAfter = {
      pages: [{
        sections: [
          {
            type: 'table', mode: 'repeatable', dataKey: 'rows',
            columns: [{ key: 'sno', label: 'S.No', align: 'center', cell: { source: 'row' } }],
            headerHeight: 20, rowHeight: 14,
          },
          { type: 'photo', mode: 'freeform', dataKey: 'photos' },
        ],
      }],
    };
    const hydrated = hydrateTemplate(definitionWithPhotoAfter);
    expect(hydrated.pages[0].sections[0].footerHeight()).toBe(150);
  });

  it('throws a clear error for an unknown section type (same style as renderer.js)', () => {
    expect(() => hydrateTemplate({ pages: [{ sections: [{ type: 'bogus' }] }] }))
      .toThrow(/Unknown PDI template section type/);
  });

  it('buildSampleData synthesizes plausible data covering every dataKey the definition references, producing a valid preview PDF', async () => {
    const sample = buildSampleData(SAMPLE_DEFINITION);
    expect(sample.customer_name).toBeTruthy();
    expect(sample.date).toBeTruthy();
    expect(Array.isArray(sample.rows)).toBe(true);
    expect(sample.checks.check_a.measured).toBe('GO');
    expect(sample.remarks).toBeTruthy();
    expect(sample.prepared_by).toBeTruthy();
    expect(sample.photos).toEqual([]);

    const doc = renderDefinition(SAMPLE_DEFINITION, sample);
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
