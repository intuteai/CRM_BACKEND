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
      spec_current_display: '10 ±0.5 (9.5 – 10.5)',
      spec_rpm_specified: '3000',
      spec_rpm_display: '3000 ±5% (2850 – 3150)',
      spec_motor_length: '250',
      spec_motor_length_display: '250 ±1 (249 – 251)',
      spec_shaft_length: '40',
      spec_shaft_length_display: '40 ±0.5 (39.5 – 40.5)',
      spec_shaft_diameter: '19.0',
      spec_shaft_diameter_display: '19.0 (+0 / -0.02) (18.98 – 19)',
      spec_mounting_pcd: '153',
      spec_mounting_pcd_display: '153 ±0.2 (152.8 – 153.2)',
      spec_locating_dia: '50.0',
      spec_locating_dia_display: '50.0 (+0.1 / -0.2) (49.8 – 50.1)',
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
