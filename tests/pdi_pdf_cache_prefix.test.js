const fs = require('fs');
const os = require('os');
const path = require('path');
const pdfCache = require('../models/operations/pdi/pdfCache');

let cacheDir;
beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdi-cache-prefix-test-'));
  process.env.PDI_PDF_CACHE_DIR = cacheDir;
});
afterEach(() => { fs.rmSync(cacheDir, { recursive: true, force: true }); delete process.env.PDI_PDF_CACHE_DIR; });

describe('pdfCache — batch prefix', () => {
  it('defaults to the "report" prefix, unchanged from today', async () => {
    await pdfCache.write(7, Buffer.from('%PDF-1.4 report'));
    expect(fs.existsSync(path.join(cacheDir, 'report-7.pdf'))).toBe(true);
    expect((await pdfCache.read(7)).toString()).toBe('%PDF-1.4 report');
  });

  it('a "batch" prefix writes/reads a separate file from the same id under "report"', async () => {
    await pdfCache.write(7, Buffer.from('%PDF-1.4 report'));
    await pdfCache.write(7, Buffer.from('%PDF-1.4 batch'), 'batch');
    expect(fs.existsSync(path.join(cacheDir, 'batch-7.pdf'))).toBe(true);
    expect((await pdfCache.read(7)).toString()).toBe('%PDF-1.4 report'); // unaffected
    expect((await pdfCache.read(7, 'batch')).toString()).toBe('%PDF-1.4 batch');
  });

  it('remove(id, "batch") only removes the batch file, not the report file with the same id', async () => {
    await pdfCache.write(7, Buffer.from('%PDF-1.4 report'));
    await pdfCache.write(7, Buffer.from('%PDF-1.4 batch'), 'batch');
    await pdfCache.remove(7, 'batch');
    expect(await pdfCache.read(7, 'batch')).toBeNull();
    expect((await pdfCache.read(7)).toString()).toBe('%PDF-1.4 report');
  });

  it('eviction counts report and batch files together against one shared MAX_FILES budget', async () => {
    for (let i = 1; i <= pdfCache.MAX_FILES; i++) {
      await pdfCache.write(i, Buffer.from(`%PDF-1.4 ${i}`));
      const f = path.join(cacheDir, `report-${i}.pdf`);
      fs.utimesSync(f, new Date(Date.now() - (10000 - i) * 1000), new Date(Date.now() - (10000 - i) * 1000));
    }
    // One more file, as a batch -- pushes total past MAX_FILES, should evict the oldest report file.
    await pdfCache.write(999, Buffer.from('%PDF-1.4 newest'), 'batch');
    const left = fs.readdirSync(cacheDir).filter((n) => /^(?:report|batch)-\d+\.pdf$/.test(n));
    expect(left.length).toBeLessThanOrEqual(pdfCache.MAX_FILES);
    expect(await pdfCache.read(999, 'batch')).not.toBeNull(); // newest survives
    expect(await pdfCache.read(1)).toBeNull(); // oldest report evicted
  });
});
