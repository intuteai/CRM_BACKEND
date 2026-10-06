const PDIGenerator = require('../models/operations/pdi_generator');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

const motorData = (n) => ({
  customer_name: 'Unit Test Co.', pdi_no: 'BATCH-TEST-1', motor_sr_no: `SR${n}`,
});

describe('PDIGenerator.generateCombined', () => {
  it('renders N reports into one PDF, more pages than any single report alone', async () => {
    const single = await bufferPdf(await PDIGenerator.generate('autonxt', null, motorData(1)));
    const combined = await bufferPdf(await PDIGenerator.generateCombined([
      { templateId: 'autonxt', templateVersion: null, data: motorData(1) },
      { templateId: 'autonxt', templateVersion: null, data: motorData(2) },
      { templateId: 'autonxt', templateVersion: null, data: motorData(3) },
    ]));
    expect(combined.slice(0, 5).toString('ascii')).toBe('%PDF-');
    // A combined 3-motor PDF must be meaningfully larger than one motor's own
    // PDF. Not a clean 3x (or even 2x): PDFKit embeds a subsetted Roboto font
    // once per document, and that subset is a large, roughly fixed cost that
    // doesn't scale with page count -- especially for this photo-less fixture,
    // where font-subset bytes dominate over per-page content bytes. 1.3x still
    // rules out "generateCombined silently only rendered the first report".
    expect(combined.length).toBeGreaterThan(single.length * 1.3);
  });

  it('numbers pages restarting at 1 for each report, not continuously across the combined document', async () => {
    const PDFDocument = require('pdfkit');
    const drawn = [];
    const originalText = PDFDocument.prototype.text;
    PDFDocument.prototype.text = function patchedText(str, ...rest) {
      drawn.push(String(str));
      return originalText.call(this, str, ...rest);
    };
    try {
      await bufferPdf(await PDIGenerator.generateCombined([
        { templateId: 'autonxt', templateVersion: null, data: motorData(1) },
        { templateId: 'autonxt', templateVersion: null, data: motorData(2) },
      ]));
    } finally {
      PDFDocument.prototype.text = originalText;
    }
    const pageLabels = drawn.filter((t) => /^Pg \d+ of \d+$/.test(t));
    // AutoNXT is a 3-page template -- 2 motors combined = 6 pages, but each
    // motor's own 3 pages restart at "Pg 1 of 3", matching the real
    // customer-facing PDI format (confirmed against an actual 16-motor
    // Compage lot document, where every motor's footer independently reads
    // "Pg 01 of 03"), never continuous "Pg 1 of 6" across the whole lot.
    expect(pageLabels).toEqual(['Pg 1 of 3', 'Pg 2 of 3', 'Pg 3 of 3', 'Pg 1 of 3', 'Pg 2 of 3', 'Pg 3 of 3']);
  });

  it('loads each report\'s photos through its loadPhotos, one report at a time, in order', async () => {
    const order = [];
    const loader = (n) => async () => { order.push(`load${n}`); return {}; };
    const doc = await PDIGenerator.generateCombined([
      { templateId: 'autonxt', templateVersion: null, data: motorData(1), loadPhotos: loader(1) },
      { templateId: 'autonxt', templateVersion: null, data: motorData(2), loadPhotos: loader(2) },
    ]);
    const pdf = await bufferPdf(doc);
    expect(pdf.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(order).toEqual(['load1', 'load2']);
  });

  it('rejects a report missing pdi_no, the same requirement generate() already has', async () => {
    await expect(PDIGenerator.generateCombined([
      { templateId: 'autonxt', templateVersion: null, data: { customer_name: 'No number' } },
    ])).rejects.toThrow('pdi_no required');
  });

  it('rejects an unknown template id, the same as generate()', async () => {
    await expect(PDIGenerator.generateCombined([
      { templateId: 'not-a-real-template', templateVersion: null, data: motorData(1) },
    ])).rejects.toThrow(/Unknown PDI template/);
  });
});
