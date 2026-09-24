// Finalize & PDF performance work (backend-performance-v1.0.8.md):
//  - the Google Drive upload of the PDF no longer holds up the finalize response
//  - a Completed report's PDF is stored at finalize and served back by GET /pdf
//  - finalize / GET /pdf report their timings
// The database and Google Drive are mocked, so this touches no real data.
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockState = { row: null, metaRow: null, updateRows: [{ report_id: 7, status: 'Completed' }], driveUpdateRowCount: 1, queries: [] };
const mockQuery = jest.fn(async (sql, params) => {
  mockState.queries.push({ sql, params });
  if (/SET status = 'Completed'/.test(sql)) return { rows: mockState.updateRows, rowCount: mockState.updateRows.length };
  if (/SET drive_file_id/.test(sql)) return { rows: [], rowCount: mockState.driveUpdateRowCount };
  if (/DELETE FROM pre_dispatch_inspection_reports/.test(sql)) return { rows: [{ report_id: 7, drive_file_id: null }], rowCount: 1 };
  if (/SELECT status, data->>'pdi_no'/.test(sql)) return { rows: mockState.metaRow ? [mockState.metaRow] : [], rowCount: mockState.metaRow ? 1 : 0 };
  if (/FROM pre_dispatch_inspection_reports WHERE report_id/.test(sql)) return { rows: mockState.row ? [mockState.row] : [], rowCount: mockState.row ? 1 : 0 };
  return { rows: [], rowCount: 0 };
});
const mockUpload = jest.fn();
const mockDeleteDrive = jest.fn(async () => undefined);
jest.mock('../config/db', () => ({ query: (...a) => mockQuery(...a) }));
jest.mock('../services/googleDrive', () => ({
  uploadBufferToDrivePrivate: (...a) => mockUpload(...a),
  deleteDriveFile: (...a) => mockDeleteDrive(...a),
}));

const PdiReports = require('../models/operations/pdiReports');
const pdfCache = require('../models/operations/pdi/pdfCache');

const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';
const reportRow = (over = {}) => ({
  report_id: 7, sr_no: 7, customer_id: null, order_id: null, status: 'In Progress',
  inspected_by: 'T', inspection_date: null, template_id: 'general', template_version: null, drive_file_id: null,
  data: { pdi_no: 'PDI-T-7', customer_name: 'Unit', rows: [{ motor_sr_no: 'SR1' }] },
  photos: [{ id: 'p', label: 'Overall', images: [TINY_JPEG, TINY_JPEG] }],
  ...over,
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

let cacheDir;
beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdi-cache-test-'));
  process.env.PDI_PDF_CACHE_DIR = cacheDir;
  mockQuery.mockClear(); mockUpload.mockReset(); mockDeleteDrive.mockClear();
  Object.assign(mockState, { row: reportRow(), metaRow: { status: 'In Progress', pdi_no: 'PDI-T-7' }, updateRows: [{ report_id: 7, status: 'Completed' }], driveUpdateRowCount: 1, queries: [] });
});
afterEach(() => { fs.rmSync(cacheDir, { recursive: true, force: true }); delete process.env.PDI_PDF_CACHE_DIR; });

describe('finalizeReport', () => {
  it('responds before the Google Drive upload finishes, then records the Drive file id', async () => {
    const upload = deferred();
    mockUpload.mockReturnValue(upload.promise);

    const result = await PdiReports.finalizeReport(7);
    // Returned while the upload is still in flight -- this is the whole point.
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(result.pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(result.payload.status).toBe('Completed');
    expect(mockState.queries.some((q) => /SET drive_file_id/.test(q.sql))).toBe(false);

    upload.resolve({ id: 'drive-123' });
    await result.background;
    const driveUpdate = mockState.queries.find((q) => /SET drive_file_id/.test(q.sql));
    expect(driveUpdate.params).toEqual(['drive-123', 7]);
  });

  it('still finalizes when the Drive upload fails, and does not reject', async () => {
    mockUpload.mockRejectedValue(new Error('Drive is down'));
    const result = await PdiReports.finalizeReport(7);
    await expect(result.background).resolves.toBeDefined();
    expect(result.payload.status).toBe('Completed');
    expect(mockState.queries.some((q) => /SET drive_file_id/.test(q.sql))).toBe(false);
  });

  it('deletes the uploaded Drive file if the report was deleted while it uploaded', async () => {
    mockUpload.mockResolvedValue({ id: 'drive-orphan' });
    mockState.driveUpdateRowCount = 0; // no such report any more
    const result = await PdiReports.finalizeReport(7);
    await result.background;
    expect(mockDeleteDrive).toHaveBeenCalledWith('drive-orphan');
  });

  it('stores the PDF on disk so a later GET /pdf can serve it', async () => {
    mockUpload.mockResolvedValue({ id: 'd' });
    const result = await PdiReports.finalizeReport(7);
    await result.background;
    const cached = await pdfCache.read(7);
    expect(cached.equals(result.pdfBuffer)).toBe(true);
  });

  it('needs a pdi_no, checked on the report it already loaded (not by loading it a second time)', async () => {
    mockState.row = reportRow({ data: { customer_name: 'No number yet' } });
    await expect(PdiReports.finalizeReport(7)).rejects.toMatchObject({ code: 'PDI_NO_REQUIRED', message: 'pdi_no required before finalizing' });
    expect(mockUpload).not.toHaveBeenCalled();
    // one SELECT of the report, nothing else
    expect(mockState.queries.filter((q) => /FROM pre_dispatch_inspection_reports WHERE report_id/.test(q.sql))).toHaveLength(1);
  });

  it('refuses an already Completed report without generating or uploading anything', async () => {
    mockState.row = reportRow({ status: 'Completed' });
    await expect(PdiReports.finalizeReport(7)).rejects.toMatchObject({ code: 'REPORT_LOCKED' });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('refuses when a concurrent finalize won the race (the guarded UPDATE matches no row) -- and uploads nothing', async () => {
    mockState.updateRows = [];
    await expect(PdiReports.finalizeReport(7)).rejects.toMatchObject({ code: 'REPORT_LOCKED' });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does not read the photos column back after the UPDATE', async () => {
    mockUpload.mockResolvedValue({ id: 'd' });
    const result = await PdiReports.finalizeReport(7);
    await result.background;
    const update = mockState.queries.find((q) => /SET status = 'Completed'/.test(q.sql));
    expect(update.sql).toMatch(/RETURNING report_id, status/);
    expect(update.sql).not.toMatch(/photos/);
  });

  it('reports what it spent: photo count, load, render (with the downscale), PDF size', async () => {
    mockUpload.mockResolvedValue({ id: 'd' });
    const { timings, background, pdfBuffer } = await PdiReports.finalizeReport(7);
    await background;
    expect(timings.photos).toBe(2);
    expect(timings.pdfBytes).toBe(pdfBuffer.length);
    for (const k of ['loadMs', 'renderMs', 'updateMs', 'totalMs']) expect(typeof timings[k]).toBe('number');
    expect(timings.optimize).toBeTruthy();
  });
});

describe('getPdfForDownload', () => {
  it('renders a draft and does not store it (it can still change)', async () => {
    const out = await PdiReports.getPdfForDownload(7);
    expect(out.source).toBe('rendered');
    expect(out.buffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(await pdfCache.read(7)).toBeNull();
  });

  it('renders a Completed report once, stores it, and serves the stored copy without touching the report again', async () => {
    mockState.metaRow = { status: 'Completed', pdi_no: 'PDI-T-7' };
    mockState.row = reportRow({ status: 'Completed' });
    const first = await PdiReports.getPdfForDownload(7);
    expect(first.source).toBe('rendered');

    mockQuery.mockClear();
    const second = await PdiReports.getPdfForDownload(7);
    expect(second.source).toBe('cache');
    expect(second.buffer.equals(first.buffer)).toBe(true);
    // Only the cheap status/pdi_no lookup ran -- the report (and its photos) was never loaded.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/SELECT status, data->>'pdi_no'/);
  });

  it('says pdi_no is required, and that a missing report is not found', async () => {
    mockState.metaRow = { status: 'In Progress', pdi_no: null };
    await expect(PdiReports.getPdfForDownload(7)).rejects.toMatchObject({ code: 'PDI_NO_REQUIRED' });
    mockState.metaRow = null;
    await expect(PdiReports.getPdfForDownload(7)).rejects.toThrow('Report not found');
    await expect(PdiReports.getPdfForDownload('abc')).rejects.toThrow('Report not found');
  });

  it('deleting a report removes its stored PDF', async () => {
    await pdfCache.write(7, Buffer.from('%PDF-1.4 fake'));
    expect(await pdfCache.read(7)).not.toBeNull();
    await PdiReports.deleteReport(7);
    expect(await pdfCache.read(7)).toBeNull();
  });
});

describe('pdfCache', () => {
  it('round-trips a PDF', async () => {
    const pdf = Buffer.from('%PDF-1.4 hello');
    expect(await pdfCache.write(3, pdf)).toBe(true);
    expect((await pdfCache.read(3)).equals(pdf)).toBe(true);
  });

  it('treats a missing file as a miss, and a file that is not a PDF as a miss it cleans up', async () => {
    expect(await pdfCache.read(99)).toBeNull();
    fs.writeFileSync(path.join(cacheDir, 'report-5.pdf'), 'not a pdf at all');
    expect(await pdfCache.read(5)).toBeNull();
    expect(fs.existsSync(path.join(cacheDir, 'report-5.pdf'))).toBe(false);
  });

  it('keeps only the newest MAX_FILES', async () => {
    for (let i = 1; i <= pdfCache.MAX_FILES + 5; i++) {
      await pdfCache.write(i, Buffer.from(`%PDF-1.4 ${i}`));
      // distinct mtimes so "oldest" is well defined
      const f = path.join(cacheDir, `report-${i}.pdf`);
      if (fs.existsSync(f)) fs.utimesSync(f, new Date(Date.now() - (1000 - i) * 1000), new Date(Date.now() - (1000 - i) * 1000));
    }
    const left = fs.readdirSync(cacheDir).filter((n) => /^report-\d+\.pdf$/.test(n));
    expect(left.length).toBeLessThanOrEqual(pdfCache.MAX_FILES);
    expect(await pdfCache.read(pdfCache.MAX_FILES + 5)).not.toBeNull(); // newest survives
  }, 30000);

  it('never throws when the folder cannot be written', async () => {
    process.env.PDI_PDF_CACHE_DIR = path.join(cacheDir, 'a-file-not-a-folder');
    fs.writeFileSync(process.env.PDI_PDF_CACHE_DIR, 'x'); // mkdir on a file path fails
    await expect(pdfCache.write(1, Buffer.from('%PDF-1.4'))).resolves.toBe(false);
    await expect(pdfCache.read(1)).resolves.toBeNull();
  });
});
