// General template PDF, per backend-changes-v1.0.8.md: the spec-row display
// strings, Mechanical page's own signatures, and mounting_pcd as GO/NG. Both
// a 1.0.8-shaped report and a report saved before it (missing every new key)
// must render without throwing -- the fallbacks are the whole point.
const PDIGenerator = require('../models/operations/pdi_generator');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

describe('General template PDF — v1.0.8 fields', () => {
  it('renders a 1.0.8-shaped report: display strings, mechanical signatures, GO/NG PCD', async () => {
    const buf = await bufferPdf(await PDIGenerator.generate('general', null, {
      pdi_no: 'PDI-V108-1',
      customer_name: 'Unit Test Co.',
      prepared_by: 'S. Choudhary',
      approved_by: 'QA Head',
      prepared_by_mechanical: 'R. Kumar',
      approved_by_mechanical: 'QA Head',
      spec_reading_directions: 'forwardReverse',
      spec_current_standard: '10',
      spec_current_display: '10 ±0.5',
      spec_rpm_specified: '3000',
      spec_rpm_display: '3000 ±5%',
      spec_motor_length: '250',
      spec_motor_length_display: '250 ±1',
      spec_shaft_length: '40',
      spec_shaft_length_display: '40 ±0.5',
      spec_shaft_diameter: '19.0',
      spec_shaft_diameter_display: '19.0 +0/-0.02',
      spec_mounting_pcd: '153',
      spec_mounting_pcd_display: '153 ±0.2',
      spec_locating_dia: '50.0',
      spec_locating_dia_display: '50.0 +0.1/-0.2',
      rows: [
        { sno: 1, motor_sr_no: '31615', current_measured: '10.2/9.8', rpm_measured: '3001/2990', mounting_pcd: 'GO', key_dim_result: 'GO' },
        { sno: 2, motor_sr_no: '31616', current_measured: '9.9/9.7', rpm_measured: '3010/2985', mounting_pcd: 'NG', key_dim_result: 'GO' },
      ],
    }));
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders a report saved before 1.0.8 -- no display strings, no mechanical signatures, a numeric mounting_pcd', async () => {
    const buf = await bufferPdf(await PDIGenerator.generate('general', null, {
      pdi_no: 'PDI-LEGACY-1',
      customer_name: 'Unit Test Co.',
      prepared_by: 'S. Choudhary',
      approved_by: 'QA Head',
      spec_current_standard: '10',
      spec_rpm_specified: '3000',
      spec_motor_length: '250',
      spec_shaft_length: '40',
      spec_shaft_diameter: '19.0',
      spec_mounting_pcd: '153',
      spec_locating_dia: '50.0',
      rows: [
        { sno: 1, motor_sr_no: '31615', current_measured: '10', rpm_measured: '3001', mounting_pcd: '153.1', key_dim_result: 'GO' },
      ],
    }));
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });
});

// backend-change-tolerance-format-v1.0.8.md: the product owner dropped the
// accepted range ("(49.5 – 50.5)") from the printed specification. The PDF must
// print the app's *_display text exactly as sent -- nothing added, nothing
// built from the tolerance fields. General's ECOLS/MCOLS spec rows are drawn
// through drawn-text spying (fonts are embedded, so the raw PDF bytes don't
// contain the text).
describe('General template PDF — specification text is printed exactly as the app sends it', () => {
  const PDFDocument = require('pdfkit');
  const { registerFonts } = require('../models/operations/pdi/primitives');
  const { renderTemplate } = require('../models/operations/pdi/renderer');
  const general = require('../models/operations/pdi/templates/general');

  function drawnTexts(data) {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    const drawn = [];
    const originalText = doc.text.bind(doc);
    doc.text = (str, ...rest) => { drawn.push(String(str)); return originalText(str, ...rest); };
    renderTemplate(doc, general, data);
    doc.end();
    return drawn;
  }
  const base = { pdi_no: 'X', rows: [{ sno: 1, motor_sr_no: 'SR1' }] };

  it('prints each *_display value verbatim, and adds no bracketed range anywhere', () => {
    const drawn = drawnTexts({
      ...base,
      spec_current_standard: '10', spec_current_tol: '0.5', spec_current_tol_mode: '\u00b1', spec_current_display: '10 \u00b10.5',
      spec_rpm_specified: '3000', spec_rpm_tol: '5', spec_rpm_tol_mode: '%', spec_rpm_display: '3000 \u00b15%',
      spec_shaft_diameter: '19.0', spec_shaft_diameter_tol: '0', spec_shaft_diameter_tol_minus: '-0.02', spec_shaft_diameter_tol_mode: 'bilateral', spec_shaft_diameter_display: '19.0 +0/-0.02',
      spec_locating_dia: '50.0', spec_locating_dia_display: '50.0 +0.1/-0.2',
    });
    for (const text of ['10 \u00b10.5', '3000 \u00b15%', '19.0 +0/-0.02', '50.0 +0.1/-0.2']) expect(drawn).toContain(text);
    // The tolerance fields are there (a range COULD be derived from them) -- it must not be.
    expect(drawn.filter((t) => /\(\s*[\d.]+\s*[\u2013-]\s*[\d.]+\s*\)/.test(t))).toEqual([]);
    expect(drawn.some((t) => t.includes('\u2013'))).toBe(false);
  });

  it('prints only the nominal when the app sent no tolerance, and falls back to the plain nominal for a report with no *_display', () => {
    const noTolerance = drawnTexts({ ...base, spec_current_standard: '10', spec_current_display: '10', spec_motor_length_display: '250' });
    expect(noTolerance).toContain('10');
    expect(noTolerance).toContain('250');

    const old = drawnTexts({ ...base, spec_current_standard: '10', spec_rpm_specified: '3000', spec_motor_length: '250', spec_locating_dia: '50.0' });
    for (const text of ['10', '3000', '250', '50.0']) expect(old).toContain(text);
  });
});
