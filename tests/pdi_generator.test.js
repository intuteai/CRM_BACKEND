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

  it('every registered template is keyed by its own id (registry/id can\'t silently drift apart)', () => {
    const templates = require('../models/operations/pdi/templates');
    Object.entries(templates).forEach(([key, template]) => {
      expect(template.id).toBe(key);
    });
  });

  it('generates a valid PDF for the autonxt template with representative fixture data', async () => {
    const buf = await bufferPdf(PDIGenerator.generate('autonxt', {
      pdi_no: 'CASPL-QA-PDI-001', customer_name: 'Autonxt', product_id: 'MOTOR-AN-1',
      drawing_no: 'CASPL-220/007-00', motor_sr_no: 'SN12345', controller_type: 'CT-1',
      performance_test: { rpm_500: { bemf_measured: '79.5', current_measured: '5.9' } },
      general_check: { shield_plate: { measured: 'GO' } },
      physical_parameters: { motor_total_length: { measured: 'GO' } },
      page1_remarks: 'ALL OK, PASSED.', page2_remarks: 'ALL OK, PASSED.',
      prepared_by_electrical: 'Tanisha', prepared_by_mechanical: 'Jitendra', approved_by: 'Aditya',
      photos: { overall_motor: '' },
    }));
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
