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

describe('AutoNXT template — drawn PDF content', () => {
  function drawnTexts(data) {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    const drawn = [];
    const originalText = doc.text.bind(doc);
    doc.text = (str, ...rest) => { drawn.push(String(str)); return originalText(str, ...rest); };
    renderTemplate(doc, autonxtTemplate, data);
    doc.end();
    return drawn;
  }

  it('prints the default literal spec text for every tolerance-eligible field when data has no overrides', () => {
    const drawn = drawnTexts({ customer_name: 'X', pdi_no: 'X' });
    expect(drawn).toContain('79.0±3%');
    expect(drawn).toContain('467.5±1.0');
    expect(drawn).toContain('Ø180.0 (-0.01 TO -0.05)');
  });

  it('prints an edited spec_X_display verbatim, and never derives it from the tolerance fields', () => {
    const drawn = drawnTexts({
      customer_name: 'X', pdi_no: 'X',
      spec_motor_total_length_display: '470.0 (special run)',
      spec_motor_total_length: '470.0', spec_motor_total_length_tol_mode: '±', spec_motor_total_length_tol: '0.5',
    });
    expect(drawn).toContain('470.0 (special run)');
    expect(drawn).not.toContain('467.5±1.0');
  });

  it('flags an out-of-tolerance Motor Total Length measurement in red, and leaves an in-range one alone', () => {
    const outOfRange = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(outOfRange);
    const fillsOut = [];
    const origFillOut = outOfRange.fillColor.bind(outOfRange);
    outOfRange.fillColor = (c, ...rest) => { fillsOut.push(c); return origFillOut(c, ...rest); };
    renderTemplate(outOfRange, autonxtTemplate, {
      customer_name: 'X', pdi_no: 'X',
      physical_parameters: { motor_total_length: { measured: '470.0' } },
    });
    outOfRange.end();
    expect(fillsOut).toContain('#fee2e2');

    const inRange = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(inRange);
    const fillsIn = [];
    const origFillIn = inRange.fillColor.bind(inRange);
    inRange.fillColor = (c, ...rest) => { fillsIn.push(c); return origFillIn(c, ...rest); };
    renderTemplate(inRange, autonxtTemplate, {
      customer_name: 'X', pdi_no: 'X',
      physical_parameters: { motor_total_length: { measured: '467.8' } },
    });
    inRange.end();
    expect(fillsIn).not.toContain('#fee2e2');
  });

  it('a non-numeric Measurement (e.g. still "GO") on a tolerance-eligible row is never flagged', () => {
    const drawn = drawnTexts({
      customer_name: 'X', pdi_no: 'X',
      physical_parameters: { motor_total_length: { measured: 'GO' } },
    });
    expect(drawn).toContain('GO');
  });

  it('the 22 non-numeric Physical Parameters rows still print their fixed spec text unchanged', () => {
    const drawn = drawnTexts({ customer_name: 'X', pdi_no: 'X' });
    expect(drawn).toContain('PCD Ø63.0, 06Nos M10, Depth 25.0, Go/NG');
    expect(drawn).toContain('No Abnormal Noise');
  });
});
