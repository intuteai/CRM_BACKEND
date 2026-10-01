// Controlled editing of finalized PDI reports
// (docs/superpowers/specs/2026-09-30-pdi-finalized-report-editing-design.md).
// The database and Google Drive are mocked, matching every other PDI model
// test in this repo -- see tests/pdi_finalize_pdf.test.js for the established
// pattern this extends.
const mockState = {
  preReadRow: null,     // status/revision_no/data as patchReport's pre-read sees it
  permissionRows: [],   // hasPermission's own SELECT
  updateRows: [],        // RETURNING rows from whichever guarded UPDATE actually runs
  fullReportRow: null,  // the reportColumns()-shaped row getById (used by the background re-render) returns
  queries: [],
};
const mockQuery = jest.fn(async (sql, params) => {
  mockState.queries.push({ sql, params });
  if (/SELECT can_write FROM permissions/.test(sql)) return { rows: mockState.permissionRows };
  if (/SELECT status, revision_no, data FROM/.test(sql)) return { rows: mockState.preReadRow ? [mockState.preReadRow] : [] };
  if (/WHERE report_id = \$\d+ AND status <> 'Completed'/.test(sql)) return { rows: mockState.updateRows, rowCount: mockState.updateRows.length };
  if (/SET drive_file_id/.test(sql)) return { rows: [], rowCount: 1 };
  if (/SELECT 1 FROM pre_dispatch_inspection_reports WHERE report_id/.test(sql)) return { rows: mockState.reportExists ? [{ '?column?': 1 }] : [] };
  if (/FROM pdi_report_revisions WHERE report_id/.test(sql)) return { rows: mockState.revisionsRows || [] };
  if (/report_id, sr_no, customer_id[\s\S]*FROM pre_dispatch_inspection_reports WHERE report_id/.test(sql)) {
    return { rows: mockState.fullReportRow ? [mockState.fullReportRow] : [] };
  }
  return { rows: [], rowCount: 0 };
});
// The guarded UPDATE + audit-snapshot INSERT for editing a Completed report
// run inside one transaction (pool.connect()) -- see the design spec's
// atomicity fix. BEGIN/COMMIT/ROLLBACK are no-ops here; the two real
// statements share mockState with mockQuery's patterns above.
const mockClient = { query: jest.fn(), release: jest.fn() };
const mockConnect = jest.fn(async () => mockClient);
jest.mock('../config/db', () => ({ query: (...a) => mockQuery(...a), connect: (...a) => mockConnect(...a) }));
const mockUpload = jest.fn(async () => ({ id: 'drive-new' }));
const mockDeleteDrive = jest.fn(async () => undefined);
jest.mock('../services/googleDrive', () => ({
  uploadBufferToDrivePrivate: (...a) => mockUpload(...a),
  deleteDriveFile: (...a) => mockDeleteDrive(...a),
}));

const PdiReports = require('../models/operations/pdiReports');

beforeEach(() => {
  mockQuery.mockClear(); mockUpload.mockClear(); mockDeleteDrive.mockClear();
  mockConnect.mockClear(); mockClient.release.mockClear();
  mockClient.query.mockReset();
  mockClient.query.mockImplementation(async (sql, params) => {
    mockState.queries.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (/status = 'Completed' AND revision_no = /.test(sql)) return { rows: mockState.updateRows, rowCount: mockState.updateRows.length };
    if (/INSERT INTO pdi_report_revisions/.test(sql)) return { rows: [], rowCount: 1 };
    // #reRenderFinalizedReport's own transaction (the Drive-swap race fix):
    // SELECT ... FOR UPDATE reads the row's drive_file_id as it stands right
    // now -- i.e. whatever getById (fullReportRow) would also see -- then the
    // UPDATE below overwrites it with the freshly-uploaded Drive file's id.
    if (/SELECT drive_file_id FROM pre_dispatch_inspection_reports WHERE report_id = \$1 FOR UPDATE/.test(sql)) {
      return { rows: [{ drive_file_id: mockState.fullReportRow ? mockState.fullReportRow.drive_file_id : null }] };
    }
    if (/SET drive_file_id/.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected client query in test: ${sql}`);
  });
  mockState.preReadRow = { status: 'Completed', revision_no: 3, data: { pdi_no: 'PDI-EDIT-1', customer_name: 'Old Name' } };
  mockState.permissionRows = [{ can_write: true }];
  mockState.updateRows = [{
    report_id: 7, sr_no: 7, customer_id: null, order_id: null, status: 'Completed',
    inspected_by: null, inspection_date: null, template_id: 'general', template_version: null,
    drive_file_id: 'drive-old', revision_no: 4, data: { pdi_no: 'PDI-EDIT-1', customer_name: 'New Name' }, photos: [],
  }];
  mockState.fullReportRow = {
    report_id: 7, sr_no: 7, customer_id: null, order_id: null, status: 'Completed',
    inspected_by: null, inspection_date: null, template_id: 'general', template_version: null,
    drive_file_id: 'drive-old', revision_no: 4, data: { pdi_no: 'PDI-EDIT-1', customer_name: 'New Name' }, photos: [],
  };
  mockState.queries = [];
});

describe('patchReport editing an already-Completed report', () => {
  it('permitted edit with the correct expected_revision succeeds: bumps revision_no, snapshots the pre-edit data, and re-renders in the background', async () => {
    const result = await PdiReports.patchReport(
      7, { data: { pdi_no: 'PDI-EDIT-1', customer_name: 'New Name' } }, null,
      // role_id (1) and edited_by (42) are deliberately different values here
      // -- edited_by references users(user_id), a completely different id
      // space from role_id, and using distinct numbers proves the snapshot
      // stores the editing USER, not their role.
      { role_id: 1, edited_by: 42, expected_revision: 3 }
    );

    expect(result.revision_no).toBe(4);
    expect(result.status).toBe('Completed');

    const snapshotInsert = mockState.queries.find((q) => /INSERT INTO pdi_report_revisions/.test(q.sql));
    expect(snapshotInsert.params).toEqual([7, 3, JSON.stringify({ pdi_no: 'PDI-EDIT-1', customer_name: 'Old Name' }), 42]);

    await result.background;
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const driveUpdate = mockState.queries.find((q) => /SET drive_file_id/.test(q.sql));
    expect(driveUpdate.params).toEqual(['drive-new', 7]);
    // the superseded Drive file (from before this edit) gets cleaned up, not left orphaned
    expect(mockDeleteDrive).toHaveBeenCalledWith('drive-old');
  });

  it('does not leak the background promise into the JSON response shape', async () => {
    const result = await PdiReports.patchReport(
      7, { data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 1, expected_revision: 3 }
    );
    expect(JSON.stringify(result)).not.toMatch(/background/);
    await result.background;
  });

  it('rejects with FINALIZED_REPORT_FORBIDDEN when the role lacks can_write on PreDispatchInspectionReports, writing nothing', async () => {
    mockState.permissionRows = [];
    await expect(
      PdiReports.patchReport(7, { data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 99, expected_revision: 3 })
    ).rejects.toMatchObject({ code: 'FINALIZED_REPORT_FORBIDDEN' });
    expect(mockState.queries.some((q) => /INSERT INTO pdi_report_revisions/.test(q.sql))).toBe(false);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('rejects with REPORT_VERSION_CONFLICT when expected_revision is missing', async () => {
    await expect(
      PdiReports.patchReport(7, { data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 1 })
    ).rejects.toMatchObject({ code: 'REPORT_VERSION_CONFLICT' });
    expect(mockState.queries.some((q) => /INSERT INTO pdi_report_revisions/.test(q.sql))).toBe(false);
  });

  it('rejects with REPORT_VERSION_CONFLICT when expected_revision is stale', async () => {
    await expect(
      PdiReports.patchReport(7, { data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 1, expected_revision: 2 })
    ).rejects.toMatchObject({ code: 'REPORT_VERSION_CONFLICT' });
    expect(mockState.queries.some((q) => /INSERT INTO pdi_report_revisions/.test(q.sql))).toBe(false);
  });

  it('rejects with REPORT_VERSION_CONFLICT when a concurrent edit wins the race (the guarded UPDATE matches no row), and never writes a phantom audit snapshot for the rejected edit', async () => {
    mockState.updateRows = []; // permission + pre-check both passed, but the UPDATE itself found no matching row
    await expect(
      PdiReports.patchReport(7, { data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 1, edited_by: 42, expected_revision: 3 })
    ).rejects.toMatchObject({ code: 'REPORT_VERSION_CONFLICT' });
    expect(mockUpload).not.toHaveBeenCalled();
    // The UPDATE and the snapshot INSERT are one transaction specifically so
    // a losing race never leaves behind a snapshot row attributing an edit
    // that was actually rejected to the user who attempted it.
    expect(mockState.queries.some((q) => /INSERT INTO pdi_report_revisions/.test(q.sql))).toBe(false);
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('commits the UPDATE and the snapshot INSERT together, in that order, inside one transaction', async () => {
    await PdiReports.patchReport(
      7, { data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 1, edited_by: 42, expected_revision: 3 }
    );
    const clientCalls = mockClient.query.mock.calls.map(([sql]) => sql);
    const updateIndex = clientCalls.findIndex((sql) => /status = 'Completed' AND revision_no = /.test(sql));
    const insertIndex = clientCalls.findIndex((sql) => /INSERT INTO pdi_report_revisions/.test(sql));
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(updateIndex);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('never lets `status` change through this path, even if the caller sends one', async () => {
    await PdiReports.patchReport(
      7, { status: 'Pending', data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 1, expected_revision: 3 }
    );
    const finalUpdate = mockState.queries.find((q) => /status = 'Completed' AND revision_no = /.test(q.sql));
    expect(finalUpdate.sql).not.toMatch(/status = \$/);
  });

  it('excludes status/inspected_by/customer_id/order_id/inspection_date entirely from the SET clause on a finalized edit, and never leaves a bound value with no matching placeholder (the original 42P18 bug)', async () => {
    const result = await PdiReports.patchReport(
      7,
      {
        data: { pdi_no: 'X' },
        status: 'Pending',
        inspected_by: 'Someone',
        customer_id: 99,
        order_id: 42,
        inspection_date: '2026-01-01',
      },
      null,
      { role_id: 1, expected_revision: 3 }
    );
    expect(result).toBeDefined();

    const finalUpdate = mockState.queries.find((q) => /status = 'Completed' AND revision_no = /.test(q.sql));
    expect(finalUpdate).toBeDefined();
    // Only data/photos are actually editable once Completed -- these five
    // are no-ops, not errors, and must not appear as SET targets at all.
    expect(finalUpdate.sql).not.toMatch(/status = \$/);
    expect(finalUpdate.sql).not.toMatch(/inspected_by = \$/);
    expect(finalUpdate.sql).not.toMatch(/customer_id = \$/);
    expect(finalUpdate.sql).not.toMatch(/order_id = \$/);
    expect(finalUpdate.sql).not.toMatch(/inspection_date = \$/);
    // The merge now happens in JS (against the already-fetched currentData),
    // not via Postgres's `||` jsonb operator -- see pdiReports.js for why:
    // `||` only merges two JSON objects; any other shape on either side
    // (null, a string, a number, an array) silently wraps into a JSON array
    // instead of merging, which would corrupt the stored data. The SQL here
    // is a plain assignment of an already-merged value.
    expect(finalUpdate.sql).toMatch(/data = \$\d+::jsonb/);
    expect(finalUpdate.sql).not.toMatch(/data = data \|\|/);
    expect(finalUpdate.sql).toMatch(/prepared_by = \$\d+/);
    expect(finalUpdate.sql).toMatch(/approved_by = \$\d+/);
    expect(finalUpdate.sql).toMatch(/revision_no = revision_no \+ 1/);

    // Direct regression test for the original bug: a stray bound value with
    // no matching placeholder in the SQL text, which Postgres can't
    // type-infer (42P18). The number of distinct $N placeholders actually
    // present in the query text must equal the number of bound values.
    const placeholderCount = new Set(finalUpdate.sql.match(/\$\d+/g) || []).size;
    expect(finalUpdate.params.length).toBe(placeholderCount);
  });

  it('merges fields.data onto currentData in JS, so a partial payload does not lose keys the client omitted', async () => {
    // preReadRow.data (set in beforeEach) has both pdi_no and customer_name;
    // send only customer_name and confirm the merged value written still
    // carries pdi_no through from currentData -- proving the merge reads
    // the pre-fetched row, not just `fields.data` alone.
    const result = await PdiReports.patchReport(
      7, { data: { customer_name: 'New Name' } }, null, { role_id: 1, expected_revision: 3 }
    );
    expect(result).toBeDefined();

    const finalUpdate = mockState.queries.find((q) => /status = 'Completed' AND revision_no = /.test(q.sql));
    const dataParamIndex = Number(finalUpdate.sql.match(/data = \$(\d+)::jsonb/)[1]);
    const dataValue = JSON.parse(finalUpdate.params[dataParamIndex - 1]);
    expect(dataValue).toEqual({ pdi_no: 'PDI-EDIT-1', customer_name: 'New Name' });
  });

  it.each([
    ['null', null],
    ['a string', 'oops'],
    ['an array', ['oops']],
  ])('throws INVALID_DATA_PAYLOAD when fields.data is %s, without reaching the database or Drive', async (_label, badData) => {
    await expect(
      PdiReports.patchReport(7, { data: badData }, null, { role_id: 1, expected_revision: 3 })
    ).rejects.toMatchObject({ code: 'INVALID_DATA_PAYLOAD' });
    // Only the pre-read SELECT should have run -- never the guarded UPDATE
    // transaction (mockConnect) or the Drive upload.
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does not touch permission/revision/snapshot machinery for a report that is NOT Completed (unchanged existing behavior)', async () => {
    mockState.preReadRow = { status: 'Pending', revision_no: 1, data: {} };
    mockState.updateRows = [{
      report_id: 7, sr_no: 7, customer_id: null, order_id: null, status: 'Pending',
      inspected_by: null, inspection_date: null, template_id: 'general', template_version: null,
      drive_file_id: null, revision_no: 1, data: { pdi_no: 'X' }, photos: [],
    }];
    const result = await PdiReports.patchReport(7, { data: { pdi_no: 'X' } }, null, {});
    expect(result.status).toBe('Pending');
    expect(mockState.queries.some((q) => /SELECT can_write FROM permissions/.test(q.sql))).toBe(false);
    expect(mockState.queries.some((q) => /INSERT INTO pdi_report_revisions/.test(q.sql))).toBe(false);
  });
});

describe('getRevisions', () => {
  it('returns snapshots newest-first', async () => {
    mockState.reportExists = true;
    mockState.revisionsRows = [
      { revision_no: 3, edited_by: 2, edited_at: new Date('2026-09-30T02:00:00Z'), data: { customer_name: 'B' } },
      { revision_no: 2, edited_by: 1, edited_at: new Date('2026-09-29T02:00:00Z'), data: { customer_name: 'A' } },
    ];
    const rows = await PdiReports.getRevisions(7);
    expect(rows).toEqual(mockState.revisionsRows);
  });

  it('throws "Report not found" for a report that does not exist', async () => {
    mockState.reportExists = false;
    await expect(PdiReports.getRevisions(999)).rejects.toThrow('Report not found');
  });
});
