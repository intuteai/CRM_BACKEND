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
