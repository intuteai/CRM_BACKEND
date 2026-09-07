const PDIGenerator = require('../models/operations/pdi_generator');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

describe('PDIGenerator (template dispatch)', () => {
  it('generates a valid PDF for the general template', async () => {
    const buf = await bufferPdf(PDIGenerator.generate('general', {
      pdi_no: 'PDI-UNIT-1', customer_name: 'Unit Test Co.',
      rows: [{ motor_sr_no: 'SR1', voltage: '24V' }],
    }));
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('throws for an unknown template id', () => {
    expect(() => PDIGenerator.generate('does-not-exist', { pdi_no: 'X' })).toThrow(/Unknown PDI template/);
  });

  it('still requires pdi_no', () => {
    expect(() => PDIGenerator.generate('general', {})).toThrow(/pdi_no required/);
  });
});
