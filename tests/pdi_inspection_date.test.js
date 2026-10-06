// A malformed inspection_date (the mobile app's date field is free text, no
// format enforcement) used to throw RangeError: Invalid time value from
// `new Date(x).toISOString()`, uncaught, turning every save into an opaque
// 500 with no trace of the real cause. Reproduced live against report #1059
// on 22 Sep 2026: every save failed identically from the moment the date
// field held an unparseable value, 4ms in, never touching the database.
// This mocks the database, so it touches no real data.
const mockQuery = jest.fn(async (sql, params) => {
  // patchReport's pre-read of the report's current status/revision_no/data,
  // now issued before the guarded UPDATE (see the design spec) -- these
  // tests are about date parsing, not the Completed-report edit path, so
  // 'Pending' keeps every one of them on the same normal-edit branch they
  // exercised before this query existed. Report 2 is the one exception,
  // kept Completed for the finalized-edit date-ignoring test below.
  if (/SELECT status, revision_no, data,/.test(sql)) {
    const [id] = params || [];
    if (id === 2) return { rows: [{ status: 'Completed', revision_no: 5, data: { pdi_no: 'FINAL-1' } }] };
    return { rows: [{ status: 'Pending', revision_no: 1, data: {} }] };
  }
  // getById's plain SELECT (no RETURNING) -- hit when a finalized edit
  // excludes every field it was given, leaving nothing to update. Unique
  // to this query among the ones patchReport/getById issue: the pre-read
  // (checked above, already returned by now) is the only other query
  // against this same table+WHERE, and the UPDATE path has no `FROM` at all.
  if (/FROM pre_dispatch_inspection_reports WHERE report_id = \$1/.test(sql)) {
    return {
      rows: [{
        report_id: 2, sr_no: 2, customer_id: null, order_id: null, status: 'Completed',
        inspected_by: null, inspection_date: null, template_id: 'general', template_version: 1,
        drive_file_id: null, revision_no: 5, data: { pdi_no: 'FINAL-1' }, photos: [],
      }],
    };
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
    // patchReport now reads the report's current status BEFORE building
    // sets/values (needed so a finalized edit can exclude inspection_date
    // entirely -- see the test below), so the database IS touched once
    // here, for that pre-read. It must still fail before ever issuing the
    // actual UPDATE: exactly one query is sent, and it's the pre-read, not
    // a write.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/SELECT status, revision_no, data,/);
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

  it('silently ignores a malformed inspection_date on a finalized (Completed) report, never validating it', async () => {
    // Report 2 is mocked Completed (revision_no 5). isFinalizedEdit excludes
    // inspection_date from the build pass entirely, so toIsoDateOrNull never
    // runs on it in this branch -- the malformed value is a no-op, not an
    // error. role_id/expected_revision are supplied as they would be for a
    // real finalized edit, even though this particular call never reaches
    // the permission/revision checks (nothing is left in `sets` once
    // inspection_date is excluded, so it short-circuits to the no-op
    // getById fallback before that code runs).
    await expect(
      PdiReports.patchReport(2, { inspection_date: '22-09-2026' }, null, { role_id: 1, expected_revision: 5 })
    ).resolves.toMatchObject({ report_id: 2, status: 'Completed' });
  });
});
