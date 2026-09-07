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
    const buf = await bufferPdf(await PDIGenerator.generate('general', null, {
      pdi_no: 'PDI-UNIT-1', customer_name: 'Unit Test Co.',
      rows: [{ motor_sr_no: 'SR1', voltage: '24V' }],
    }));
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('throws for an unknown template id', async () => {
    await expect(PDIGenerator.generate('does-not-exist', null, { pdi_no: 'X' })).rejects.toThrow(/Unknown PDI template/);
  });

  it('still requires pdi_no', async () => {
    await expect(PDIGenerator.generate('general', null, {})).rejects.toThrow(/pdi_no required/);
  });

  it('every registered template is keyed by its own id (registry/id can\'t silently drift apart)', () => {
    const templates = require('../models/operations/pdi/templates');
    Object.entries(templates).forEach(([key, template]) => {
      expect(template.id).toBe(key);
    });
  });

  it('generates a valid PDF for the autonxt template with representative fixture data', async () => {
    const buf = await bufferPdf(await PDIGenerator.generate('autonxt', null, {
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

  it('generates a valid PDF for a DB-backed (authored) template, resolved by id + version', async () => {
    const AuthoredTemplates = require('../models/operations/pdi/authoredTemplates');
    const pool = require('../config/db');
    const id = 'test-generate-authored-' + Date.now();
    const definition = {
      pages: [{
        sections: [
          { type: 'text', label: 'Remarks:', dataKey: 'remarks', default: 'OK' },
        ],
      }],
    };
    const row = await AuthoredTemplates.create({ id, name: 'Test', definition });
    try {
      const buf = await bufferPdf(await PDIGenerator.generate(id, row.version, { pdi_no: 'X', remarks: 'All fine' }));
      expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
    } finally {
      await pool.query('DELETE FROM pdi_templates WHERE id = $1', [id]);
    }
  });

  it('throws for a DB template id that exists but at the wrong version', async () => {
    await expect(PDIGenerator.generate('some-authored-id', 999, { pdi_no: 'X' })).rejects.toThrow(/Unknown PDI template/);
  });
});
