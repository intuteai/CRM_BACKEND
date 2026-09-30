// A malformed inspection_date (the mobile app's date field is free text, no
// format enforcement) used to throw RangeError: Invalid time value from
// `new Date(x).toISOString()`, uncaught, turning every save into an opaque
// 500 with no trace of the real cause. Reproduced live against report #1059
// on 22 Sep 2026: every save failed identically from the moment the date
// field held an unparseable value, 4ms in, never touching the database.
// This mocks the database, so it touches no real data.
const mockQuery = jest.fn(async (sql) => {
  // patchReport's pre-read of the report's current status/revision_no/data,
  // now issued before the guarded UPDATE (see the design spec) -- these
  // tests are about date parsing, not the Completed-report edit path, so
  // 'Pending' keeps every one of them on the same normal-edit branch they
  // exercised before this query existed.
  if (/SELECT status, revision_no, data FROM/.test(sql)) {
    return { rows: [{ status: 'Pending', revision_no: 1, data: {} }] };
  }
  if (/RETURNING/.test(sql)) {
    return {
      rows: [{
        report_id: 1, sr_no: 1, customer_id: null, order_id: null, status: 'Pending',
        inspected_by: null, inspection_date: null, template_id: 'general', template_version: 1,
        drive_file_id: null, prepared_by: null, approved_by: null, revision_no: 1, data: {}, photos: [], created_at: new Date(),
      }],
    };
  }
  return { rows: [] };
});
jest.mock('../config/db', () => ({ query: (...args) => mockQuery(...args) }));
jest.mock('../models/operations/pdi/templates', () => ({ general: { version: 1 } }));

const PdiReports = require('../models/operations/pdiReports');

describe('Inspection date parsing', () => {
  beforeEach(() => mockQuery.mockClear());

  it('rejects an unparseable date with a clear error, not a crash', async () => {
    await expect(
      PdiReports.patchReport(1, { inspection_date: '22-09-2026' })
    ).rejects.toMatchObject({ code: 'INVALID_INSPECTION_DATE' });
    // Must fail before ever touching the database -- exactly what made this
    // bug invisible in the request's timing (4ms, no DB round trip).
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects the same bad date on report creation', async () => {
    await expect(
      PdiReports.createReport({ inspection_date: 'not a date', data: {}, photos: [], template_id: 'general' })
    ).rejects.toMatchObject({ code: 'INVALID_INSPECTION_DATE' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('still accepts a normal ISO date', async () => {
    await PdiReports.patchReport(1, { inspection_date: '2026-09-22' });
    // [0] is the new pre-read; [1] is the actual UPDATE.
    const values = mockQuery.mock.calls[1][1];
    expect(values).toContain(new Date('2026-09-22').toISOString());
  });

  it('treats an empty date as no date, not an error', async () => {
    await expect(
      PdiReports.patchReport(1, { inspection_date: '' })
    ).resolves.toBeDefined();
    const values = mockQuery.mock.calls[1][1];
    expect(values).toContain(null);
  });
});
