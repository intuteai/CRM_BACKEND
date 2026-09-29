const PDFDocument = require('pdfkit');
const { registerFonts } = require('../models/operations/pdi/primitives');
const { renderTemplate } = require('../models/operations/pdi/renderer');
const autonxtTemplate = require('../models/operations/pdi/templates/autonxt');
const { specDisplay, specOutOfTolerance, SPEC_DEFAULTS } = require('../models/operations/pdi/templates/autonxt');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

describe('AutoNXT tolerance-eligible fields — specDisplay/specOutOfTolerance', () => {
  it('SPEC_DEFAULTS has exactly the 19 documented field ids', () => {
    expect(Object.keys(SPEC_DEFAULTS).sort()).toEqual([
      'locating_dia', 'motor_total_length', 'shaft_op_length',
      'rpm_1000_bemf', 'rpm_1000_current', 'rpm_1500_bemf', 'rpm_1500_current',
      'rpm_1800_bemf', 'rpm_1800_current', 'rpm_2000_bemf', 'rpm_2000_current',
      'rpm_2200_bemf', 'rpm_2200_current', 'rpm_2500_bemf', 'rpm_2500_current',
      'rpm_3000_bemf', 'rpm_3000_current', 'rpm_500_bemf', 'rpm_500_current',
    ].sort());
  });

  it('specDisplay falls back to the default literal when data has no override', () => {
    expect(specDisplay({}, 'rpm_500_bemf')).toBe('79.0±3%');
    expect(specDisplay({}, 'motor_total_length')).toBe('467.5±1.0');
    expect(specDisplay({}, 'locating_dia')).toBe('Ø180.0 (-0.01 TO -0.05)');
  });

  it('specDisplay prints exactly what was typed when data has an override', () => {
    expect(specDisplay({ spec_rpm_500_bemf_display: '80.0±2%' }, 'rpm_500_bemf')).toBe('80.0±2%');
  });

  it('specOutOfTolerance flags a measured value outside the default ± range', () => {
    expect(specOutOfTolerance('469.0', {}, 'motor_total_length')).toBe(true);
    expect(specOutOfTolerance('467.8', {}, 'motor_total_length')).toBe(false);
  });

  it('specOutOfTolerance flags a measured value outside the default % range', () => {
    expect(specOutOfTolerance('82.0', {}, 'rpm_500_bemf')).toBe(true);
    expect(specOutOfTolerance('80.0', {}, 'rpm_500_bemf')).toBe(false);
  });

  it('specOutOfTolerance flags a measured value outside the default bilateral range (Locating Dia.)', () => {
    expect(specOutOfTolerance('179.90', {}, 'locating_dia')).toBe(true);
    expect(specOutOfTolerance('179.97', {}, 'locating_dia')).toBe(false);
  });

  it('specOutOfTolerance never flags a blank-spec row (rpm 2000-3000) until a real nominal is entered', () => {
    expect(specOutOfTolerance('999', {}, 'rpm_2000_bemf')).toBe(false);
    expect(specOutOfTolerance('999', { spec_rpm_2000_bemf: '10', spec_rpm_2000_bemf_tol_mode: '±', spec_rpm_2000_bemf_tol: '1' }, 'rpm_2000_bemf')).toBe(true);
  });

  it('a report\'s own spec_X/_tol_mode/_tol override the default nominal/tolerance used for the check', () => {
    const data = { spec_motor_total_length: '500', spec_motor_total_length_tol_mode: '±', spec_motor_total_length_tol: '2' };
    expect(specOutOfTolerance('469.0', data, 'motor_total_length')).toBe(true);
    expect(specOutOfTolerance('499.5', data, 'motor_total_length')).toBe(false);
  });
});

describe('AutoNXT template still renders without throwing (unchanged by this task)', () => {
  it('renders an old-shaped report (no spec_* fields at all) without throwing', async () => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    expect(() => renderTemplate(doc, autonxtTemplate, {
      customer_name: 'Old Co.', pdi_no: 'PDI-OLD-1',
      performance_test: { rpm_500: { bemf_measured: '80', current_measured: '6.5' } },
      physical_parameters: { motor_total_length: { measured: '468' } },
    })).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
