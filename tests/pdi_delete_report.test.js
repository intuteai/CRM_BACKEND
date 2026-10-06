// TOCTOU fix for deleteReport: the DELETE itself is the guard (batch-lock +
// finalized-report-permission), not a separate check-then-act read. Same
// mocking pattern as tests/pdi_finalized_edit.test.js -- the database and
// Google Drive are mocked.
const mockState = {
  deleteRows: [],     // RETURNING rows from the guarded DELETE
  checkRow: null,     // fallback SELECT's row, used only to explain a 0-row DELETE
  permissionRows: [], // hasPermission's own SELECT
  queries: [],
};
const mockQuery = jest.fn(async (sql, params) => {
  mockState.queries.push({ sql, params });
  if (/SELECT can_write FROM permissions/.test(sql)) return { rows: mockState.permissionRows };
  if (/DELETE FROM pre_dispatch_inspection_reports r/.test(sql)) {
    return { rows: mockState.deleteRows, rowCount: mockState.deleteRows.length };
  }
  if (/SELECT r\.status, r\.batch_id, b\.status AS batch_status/.test(sql)) {
    return { rows: mockState.checkRow ? [mockState.checkRow] : [] };
  }
  return { rows: [], rowCount: 0 };
});
jest.mock('../config/db', () => ({ query: (...a) => mockQuery(...a) }));
const mockRemove = jest.fn(async () => undefined);
jest.mock('../models/operations/pdi/pdfCache', () => ({ remove: (...a) => mockRemove(...a) }));
const mockDeleteDrive = jest.fn(async () => undefined);
jest.mock('../services/googleDrive', () => ({
  uploadBufferToDrivePrivate: jest.fn(),
  deleteDriveFile: (...a) => mockDeleteDrive(...a),
}));

const PdiReports = require('../models/operations/pdiReports');

beforeEach(() => {
  mockQuery.mockClear();
  mockRemove.mockClear();
  mockDeleteDrive.mockClear();
  mockState.deleteRows = [];
  mockState.checkRow = null;
  mockState.permissionRows = [];
  mockState.queries = [];
});

describe('deleteReport (guarded DELETE closes the TOCTOU race)', () => {
  it('deletes a normal report (not Completed, not batch-locked): the guarded DELETE returns a row, cleanup runs', async () => {
    mockState.deleteRows = [{ report_id: 7, drive_file_id: 'drive-7' }];

    const result = await PdiReports.deleteReport(7, null, { role_id: 1 });

    expect(result).toEqual({ report_id: 7 });
    expect(mockRemove).toHaveBeenCalledWith(7);
    expect(mockDeleteDrive).toHaveBeenCalledWith('drive-7');
    // No fallback read needed when the guarded DELETE already matched a row.
    expect(mockState.queries.some((q) => /SELECT r\.status, r\.batch_id/.test(q.sql))).toBe(false);
  });

  it('rejects with BATCH_MEMBER_LOCKED when the report belongs to a finalized batch', async () => {
    mockState.deleteRows = []; // guarded DELETE matched nothing
    mockState.checkRow = { status: 'Pending', batch_id: 55, batch_status: 'Completed' };

    await expect(
      PdiReports.deleteReport(7, null, { role_id: 1 })
    ).rejects.toMatchObject({ code: 'BATCH_MEMBER_LOCKED' });
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockDeleteDrive).not.toHaveBeenCalled();
  });

  it('rejects with BATCH_MEMBER_LOCKED for ANY lot member, even of an In Progress lot -- the whole lot is deleted from the lot page', async () => {
    mockState.deleteRows = [];
    mockState.checkRow = { status: 'Pending', batch_id: 21, batch_status: 'In Progress' };

    await expect(
      PdiReports.deleteReport(7, null, { role_id: 1 })
    ).rejects.toMatchObject({ code: 'BATCH_MEMBER_LOCKED', message: 'This report is part of a lot. Delete the whole lot from the lot page instead.' });
    // The lot check lives in the guarded DELETE itself, not only in the fallback read.
    const del = mockState.queries.find((q) => /DELETE FROM pre_dispatch_inspection_reports r/.test(q.sql));
    expect(del.sql).toMatch(/AND r\.batch_id IS NULL/);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('rejects with FINALIZED_REPORT_FORBIDDEN for a Completed report when the role lacks can_write', async () => {
    mockState.deleteRows = []; // guarded DELETE matched nothing ($2 was false)
    mockState.checkRow = { status: 'Completed', batch_id: null, batch_status: null };
    mockState.permissionRows = []; // hasPermission resolves false

    await expect(
      PdiReports.deleteReport(7, null, { role_id: 99 })
    ).rejects.toMatchObject({ code: 'FINALIZED_REPORT_FORBIDDEN' });
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockDeleteDrive).not.toHaveBeenCalled();
  });

  it('deletes a Completed report when the role has can_write: the guarded DELETE returns a row on the first query, no fallback read', async () => {
    mockState.deleteRows = [{ report_id: 7, drive_file_id: 'drive-7' }];
    mockState.permissionRows = [{ can_write: true }];

    const result = await PdiReports.deleteReport(7, null, { role_id: 1 });

    expect(result).toEqual({ report_id: 7 });
    expect(mockState.queries.some((q) => /SELECT r\.status, r\.batch_id/.test(q.sql))).toBe(false);
  });

  it("throws 'Report not found' when the report genuinely does not exist", async () => {
    mockState.deleteRows = [];
    mockState.checkRow = null; // fallback check also finds nothing

    await expect(
      PdiReports.deleteReport(999, null, { role_id: 1 })
    ).rejects.toThrow('Report not found');
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockDeleteDrive).not.toHaveBeenCalled();
  });
});
