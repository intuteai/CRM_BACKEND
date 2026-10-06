const PDFDocument = require('pdfkit');
const { registerFonts } = require('../models/operations/pdi/primitives');
const { renderTemplate } = require('../models/operations/pdi/renderer');
const autonxtControllerTemplate = require('../models/operations/pdi/templates/autonxt_controller');
const { CONTROLLER_TYPE_PRESETS, computeRemarks } = require('../models/operations/pdi/templates/autonxt_controller');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

describe('AutoNXT Controller — CONTROLLER_TYPE_PRESETS', () => {
  it('CASHV38140 preset has exactly 35 rows, transcribed from the reference PDI document', () => {
    const rows = CONTROLLER_TYPE_PRESETS.CASHV38140;
    expect(rows).toHaveLength(35);
    expect(rows[0]).toEqual({ parameter: 'F01.00', specification: '11' });
    expect(rows[rows.length - 1]).toEqual({ parameter: 'F01.13', specification: '37.50' });
    rows.forEach((r) => {
      expect(typeof r.parameter).toBe('string');
      expect(typeof r.specification).toBe('string');
    });
  });
});

describe('AutoNXT Controller — computeRemarks (exact-match, not tolerance)', () => {
  it('returns OK when Measured exactly matches Specification (after trimming)', () => {
    expect(computeRemarks({ specification: '90', measured: '90' })).toBe('OK');
    expect(computeRemarks({ specification: '90', measured: ' 90 ' })).toBe('OK');
  });

  it('returns NG when Measured does not match Specification', () => {
    expect(computeRemarks({ specification: '90', measured: '91' })).toBe('NG');
  });

  it('returns blank when Measured is not yet filled in', () => {
    expect(computeRemarks({ specification: '90', measured: '' })).toBe('');
    expect(computeRemarks({ specification: '90' })).toBe('');
  });

  it('an explicit remarks value (e.g. a manual NA override) always wins over the computed value', () => {
    expect(computeRemarks({ specification: '90', measured: '91', remarks: 'NA' })).toBe('NA');
    expect(computeRemarks({ specification: '90', measured: '90', remarks: 'NA' })).toBe('NA');
  });

  it('compares plain decimals numerically', () => {
    expect(computeRemarks({ specification: '0001', measured: '1' })).toBe('OK');
    expect(computeRemarks({ specification: '37.50', measured: '37.5' })).toBe('OK');
    expect(computeRemarks({ specification: '11.0', measured: '11' })).toBe('OK');
    expect(computeRemarks({ specification: '0', measured: 0 })).toBe('OK');
  });

  it('falls back to an exact string match for anything not a plain decimal', () => {
    expect(computeRemarks({ specification: '1000', measured: '1e3' })).toBe('NG');
    expect(computeRemarks({ specification: '0x5', measured: '0x5' })).toBe('OK');
    expect(computeRemarks({ specification: '5', measured: '0x5' })).toBe('NG');
  });

  it('trims whitespace on both sides', () => {
    expect(computeRemarks({ specification: ' 37.50 ', measured: ' 37.5 ' })).toBe('OK');
    expect(computeRemarks({ specification: ' ABC ', measured: 'ABC' })).toBe('OK');
  });

  it('never treats a stored OK/NG (any case) as an override', () => {
    expect(computeRemarks({ specification: '90', measured: '91', remarks: 'OK' })).toBe('NG');
    expect(computeRemarks({ specification: '90', measured: '91', remarks: 'ok' })).toBe('NG');
    expect(computeRemarks({ specification: '90', measured: '90', remarks: 'NG' })).toBe('OK');
  });

  it('does not throw on null/undefined fields or rows', () => {
    expect(computeRemarks({ specification: null, measured: undefined, remarks: null })).toBe('');
    expect(computeRemarks({ specification: null, measured: '5' })).toBe('NG');
    expect(computeRemarks(null)).toBe('');
    expect(computeRemarks(undefined)).toBe('');
  });
});

function newDoc() {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
  registerFonts(doc);
  return doc;
}

function spyTexts(doc) {
  const texts = [];
  const original = doc.text.bind(doc);
  doc.text = (str, ...rest) => { texts.push(String(str)); return original(str, ...rest); };
  return texts;
}

const okRows = () => CONTROLLER_TYPE_PRESETS.CASHV38140.map((r) => ({ ...r, measured: r.specification }));
const GC_KEYS = ['can_card', 'io_card', 'power_connector', 'pin14_connector', 'resolver_conn', 'rj45_connector', 'harness_check', 'drive_on_key', 'run_750_rpm', 'physical_check'];
const allGo = () => Object.fromEntries(GC_KEYS.map((k) => [k, { measured: 'GO' }]));

describe('AutoNXT Controller — rendering rules', () => {
  it('skips null and non-object parameter rows instead of crashing', async () => {
    const doc = newDoc();
    const data = { pdi_no: 'X', parameter_rows: [null, undefined, 'abc', 7, [1, 2], { parameter: 'F01.00', specification: '11', measured: 11 }] };
    expect(() => renderTemplate(doc, autonxtControllerTemplate, data)).not.toThrow();
    doc.end();
    await bufferPdf(doc);
  });

  it('flags both Measured Value and Remarks on an NG parameter row, and the Measurement on an NG general check', async () => {
    const doc = newDoc();
    const fills = [];
    const originalFill = doc.fillColor.bind(doc);
    doc.fillColor = (c, ...rest) => { fills.push(c); return originalFill(c, ...rest); };
    const rows = okRows();
    rows[3] = { parameter: 'F01.09', specification: '90', measured: '91', remarks: 'OK' };
    const general_check = { ...allGo(), harness_check: { measured: 'ng' } };
    renderTemplate(doc, autonxtControllerTemplate, { pdi_no: 'X', parameter_rows: rows, general_check });
    doc.end();
    await bufferPdf(doc);
    // One flagged-cell fill per flagged cell: 2 on the NG parameter row + 1 on the NG general check.
    expect(fills.filter((c) => c === '#fee2e2')).toHaveLength(3);
  });

  it('defaults each remarks box to ALL OK only when its own section has no NG', async () => {
    const render = (data) => {
      const doc = newDoc();
      const texts = spyTexts(doc);
      renderTemplate(doc, autonxtControllerTemplate, { pdi_no: 'X', ...data });
      doc.end();
      return texts.filter((t) => t === 'ALL OK, PASSED.').length;
    };
    expect(render({ parameter_rows: okRows(), general_check: allGo() })).toBe(2);

    const ngRows = okRows();
    ngRows[0].measured = '12';
    expect(render({ parameter_rows: ngRows, general_check: allGo() })).toBe(1);
    expect(render({ parameter_rows: okRows(), general_check: { ...allGo(), io_card: { measured: 'NG' } } })).toBe(1);
    // Whitespace-only stored remarks still fall back to the computed default.
    expect(render({ parameter_rows: ngRows, page1_remarks: '   ', general_check: allGo() })).toBe(1);
    // An explicit stored remark is always printed as-is.
    expect(render({ parameter_rows: ngRows, page1_remarks: 'F01.00 re-flashed', general_check: allGo() })).toBe(1);
  });

  it('prints two-digit page numbers and END OF REPORT on the last page only', async () => {
    const doc = newDoc();
    const texts = spyTexts(doc);
    renderTemplate(doc, autonxtControllerTemplate, { pdi_no: 'X', parameter_rows: okRows(), general_check: allGo() });
    doc.end();
    await bufferPdf(doc);
    expect(texts.filter((t) => /^Pg /.test(t))).toEqual(['Pg 01 of 02', 'Pg 02 of 02']);
    expect(texts.filter((t) => t === 'END OF REPORT')).toHaveLength(1);
    expect(texts.indexOf('END OF REPORT')).toBe(texts.indexOf('Pg 02 of 02') - 1);
  });

  it('uses the reference document\'s casing for Section A', async () => {
    const doc = newDoc();
    const texts = spyTexts(doc);
    renderTemplate(doc, autonxtControllerTemplate, { pdi_no: 'X', parameter_rows: okRows() });
    doc.end();
    await bufferPdf(doc);
    ['A. PARAMETER CHECK:', 'S.NO', 'PARAMETER', 'SPECIFICATION', 'MEASURED VALUE', 'REMARKS', 'B. General Check']
      .forEach((label) => expect(texts).toContain(label));
  });

  it('keeps a full 35-row, 5-photo report on 2 pages', async () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const doc = newDoc();
    renderTemplate(doc, autonxtControllerTemplate, {
      pdi_no: 'X', parameter_rows: okRows(), general_check: allGo(),
      photos: { overall_controller: PNG, name_plate: PNG, can_io_card: PNG, harness_photo: PNG, packing_photo: PNG },
      prepared_by: 'A', approved_by: 'B',
    });
    expect(doc.bufferedPageRange().count).toBe(2);
    doc.end();
    await bufferPdf(doc);
  });

  it('prints numeric 0 values instead of blanks', async () => {
    const doc = newDoc();
    const texts = spyTexts(doc);
    renderTemplate(doc, autonxtControllerTemplate, { pdi_no: 'X', parameter_rows: [{ parameter: 'F10.43', specification: 0, measured: 0 }] });
    doc.end();
    await bufferPdf(doc);
    expect(texts.filter((t) => t === '0')).toHaveLength(2);
  });
});

describe('AutoNXT Controller template renders without throwing', () => {
  it('renders a report with parameter rows, general check, and photos', async () => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    const data = {
      customer_name: 'Autonxt', pdi_no: 'CASPL-QA-PDI-202509008',
      controller_sr_no: '2500-00184', controller_type: 'CASHV38140',
      parameter_rows: CONTROLLER_TYPE_PRESETS.CASHV38140.map((r) => ({ ...r, measured: r.specification })),
      general_check: { can_card: { measured: 'GO' } },
      photos: {},
    };
    expect(() => renderTemplate(doc, autonxtControllerTemplate, data)).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders an empty/new report (no parameter_rows yet) without throwing', async () => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    expect(() => renderTemplate(doc, autonxtControllerTemplate, { customer_name: 'New Co.', pdi_no: 'PDI-NEW-1' })).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });
});

describe('AutoNXT Controller template is registered', () => {
  it('is reachable via templates/index.js under id "autonxt_controller"', () => {
    const templates = require('../models/operations/pdi/templates');
    expect(templates.autonxt_controller).toBe(autonxtControllerTemplate);
    expect(templates.autonxt_controller.name).toBe('AutoNXT Controller PDI');
  });
});
