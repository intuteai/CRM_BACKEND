// Lot-aware rules on single PDI reports: lot fields in report payloads and
// list rows, PATCH status/revision/lot-lock rules, refusing to finalize a lot
// member alone, the error-to-JSON mapping, and the PDI role allow-list.
// The database is mocked, same pattern as tests/pdi_report_batches.test.js.
const mockState = { impl: null };
const mockQuery = jest.fn(async (...args) => (mockState.impl ? mockState.impl(...args) : { rows: [], rowCount: 0 }));
jest.mock('../config/db', () => ({ query: (...a) => mockQuery(...a), connect: jest.fn() }));
jest.mock('../config/redis', () => ({ isReady: false }));
jest.mock('../services/googleDrive', () => ({ uploadBufferToDrivePrivate: jest.fn(), deleteDriveFile: jest.fn() }));

const PdiReports = require('../models/operations/pdiReports');
const controller = require('../controllers/operations/pdiReports.controller');
const { requirePdiAccess } = require('../middleware/pdiAccess');

const fullRow = (over = {}) => ({
  report_id: 7, sr_no: 7, customer_id: null, order_id: null, status: 'In Progress',
  inspected_by: null, inspection_date: null, template_id: 'autonxt', template_version: null,
  drive_file_id: null, revision_no: 3, batch_id: null, lot_index: null, batch: null,
  data: { pdi_no: 'P' }, photos: {},
  ...over,
});

beforeEach(() => {
  mockQuery.mockClear();
  mockState.impl = null;
});

describe('report payload lot fields (getById)', () => {
  it('adds batch_id, lot_index, lot_quantity, batch_status and batch_pdi_no for a lot member', async () => {
    mockState.impl = async () => ({ rows: [fullRow({ batch_id: 21, lot_index: 2, batch: { lot_quantity: 6, status: 'In Progress', pdi_no: 'LOT-21' } })] });
    const report = await PdiReports.getById(7);
    expect(report).toMatchObject({ batch_id: 21, lot_index: 2, lot_quantity: 6, batch_status: 'In Progress', batch_pdi_no: 'LOT-21' });
    expect(mockQuery.mock.calls[0][0]).toMatch(/FROM pdi_report_batches b WHERE b\.batch_id = pre_dispatch_inspection_reports\.batch_id/);
  });

  it('returns nulls for a standalone report (and for rows without the new columns)', async () => {
    mockState.impl = async () => ({ rows: [{ report_id: 7, status: 'Pending', data: {}, photos: [] }] });
    const report = await PdiReports.getById(7);
    expect(report).toMatchObject({ batch_id: null, lot_index: null, lot_quantity: null, batch_status: null, batch_pdi_no: null });
  });
});

describe('listReports', () => {
  it('returns lot fields and serials per row, and searches template names, serials and the authored name', async () => {
    mockState.impl = async (sql) => {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: 1 }] };
      return {
        rows: [{
          report_id: 9, status: 'Pending', template_id: 'autonxt_controller', form_customer_name: '', linked_customer_name: 'Linked Co',
          motor_sr_no: null, controller_sr_no: 'C9', batch_id: 21, lot_index: 3, lot_quantity: 6, batch_status: 'In Progress', batch_pdi_no: 'LOT-21',
        }],
      };
    };

    const result = await PdiReports.listReports({ search: 'controller' });

    expect(result.data[0]).toMatchObject({
      customer_name: 'Linked Co', motor_sr_no: null, controller_sr_no: 'C9',
      batch_id: 21, lot_index: 3, lot_quantity: 6, batch_status: 'In Progress', batch_pdi_no: 'LOT-21',
    });
    const [listSql, listParams] = mockQuery.mock.calls.find(([sql]) => !/COUNT\(\*\)/.test(sql));
    const [countSql, countParams] = mockQuery.mock.calls.find(([sql]) => /COUNT\(\*\)/.test(sql));
    expect(listParams[3]).toEqual(['autonxt_controller']);
    expect(countParams).toEqual(listParams.slice(0, 4));
    for (const sql of [listSql, countSql]) {
      expect(sql).toMatch(/LEFT JOIN pdi_report_batches b ON b\.batch_id = pdi\.batch_id/);
      expect(sql).toMatch(/LEFT JOIN pdi_templates pt/);
      expect(sql).toMatch(/COALESCE\(NULLIF\(pdi\.data->>'customer_name', ''\), u\.name\) ILIKE/);
      expect(sql).toMatch(/pdi\.data->>'motor_sr_no' ILIKE/);
      expect(sql).toMatch(/pdi\.data->>'controller_sr_no' ILIKE/);
      expect(sql).toMatch(/pt\.name ILIKE/);
      expect(sql).toMatch(/pdi\.template_id = ANY\(\$4::text\[\]\)/);
    }
  });

  it('sorts customer_name by the non-empty form value, falling back to the linked customer', async () => {
    mockState.impl = async (sql) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ count: 0 }] } : { rows: [] });
    await PdiReports.listReports({ sortBy: 'customer_name', sortDir: 'asc' });
    const [listSql, listParams] = mockQuery.mock.calls.find(([sql]) => !/COUNT\(\*\)/.test(sql));
    expect(listSql).toMatch(/ORDER BY COALESCE\(NULLIF\(pdi\.data->>'customer_name', ''\), u\.name\) ASC NULLS LAST/);
    expect(listSql).toMatch(/LIMIT \$5 OFFSET \$6/);
    expect(listParams).toEqual([null, null, null, [], 11, 0]);
  });

  it('keeps cursor pagination working with the extra parameter', async () => {
    mockState.impl = async (sql) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ count: 0 }] } : { rows: [] });
    await PdiReports.listReports({ cursor: '50', limit: 5 });
    const [listSql, listParams] = mockQuery.mock.calls.find(([sql]) => !/COUNT\(\*\)/.test(sql));
    expect(listSql).toMatch(/pdi\.report_id < \$5/);
    expect(listSql).toMatch(/LIMIT \$6/);
    expect(listParams).toEqual([null, null, null, [], 50, 6]);
  });
});

describe('patchReport rules', () => {
  // preRead: what the status/revision/lot pre-read sees.
  // updateRows: what the guarded UPDATE returns.
  // stateRow: what the follow-up read sees after a 0-row UPDATE.
  function fakeReport({ preRead, updateRows = [fullRow({ revision_no: 4 })], stateRow = null }) {
    mockState.impl = async (sql) => {
      if (/SELECT status, revision_no, data,/.test(sql)) return { rows: preRead ? [preRead] : [] };
      if (/^\s*UPDATE pre_dispatch_inspection_reports/.test(sql)) return { rows: updateRows, rowCount: updateRows.length };
      if (/SELECT r\.status, r\.revision_no, r\.batch_id, b\.status AS batch_status/.test(sql)) return { rows: stateRow ? [stateRow] : [] };
      return { rows: [] };
    };
  }
  const updateCall = () => mockQuery.mock.calls.find(([sql]) => /^\s*UPDATE pre_dispatch_inspection_reports/.test(sql));

  it.each(['Completed', 'Done', null, ''])('rejects status %p with INVALID_STATUS before touching the database', async (status) => {
    await expect(PdiReports.patchReport(7, { status })).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each(['Pending', 'In Progress'])('accepts status %p', async (status) => {
    fakeReport({ preRead: { status: 'Pending', revision_no: 3, data: {}, batch_status: null } });
    await expect(PdiReports.patchReport(7, { status })).resolves.toBeDefined();
  });

  it.each(['Completed', 'Finalizing'])('refuses to save a member of a %s lot with BATCH_MEMBER_LOCKED', async (batchStatus) => {
    fakeReport({ preRead: { status: 'In Progress', revision_no: 3, data: {}, batch_status: batchStatus } });
    await expect(PdiReports.patchReport(7, { data: { motor_sr_no: 'X' } })).rejects.toMatchObject({
      code: 'BATCH_MEMBER_LOCKED', message: "This report belongs to a finalized lot and can't be edited.",
    });
    expect(updateCall()).toBeUndefined();
  });

  it('bumps revision_no on every save and guards the UPDATE on the lot still being In Progress (row-locked)', async () => {
    fakeReport({ preRead: { status: 'In Progress', revision_no: 3, data: {}, batch_status: 'In Progress' } });
    const result = await PdiReports.patchReport(7, { data: { motor_sr_no: 'X' } });
    expect(result.revision_no).toBe(4);
    const [sql, params] = updateCall();
    expect(sql).toMatch(/revision_no = revision_no \+ 1/);
    expect(sql).toMatch(/b\.status = 'In Progress'\s+FOR SHARE/);
    expect(sql).not.toMatch(/AND revision_no = \$/);
    expect(new Set(sql.match(/\$\d+/g)).size).toBe(params.length);
  });

  it('enforces expected_revision on a non-Completed report when sent: matching value goes into the guard', async () => {
    fakeReport({ preRead: { status: 'In Progress', revision_no: 3, data: {}, batch_status: null } });
    await PdiReports.patchReport(7, { data: { a: 1 } }, null, { expected_revision: 3 });
    const [sql, params] = updateCall();
    const n = Number(sql.match(/AND revision_no = \$(\d+)/)[1]);
    expect(params[n - 1]).toBe(3);
  });

  it('rejects a stale expected_revision on a non-Completed report with REPORT_VERSION_CONFLICT, writing nothing', async () => {
    fakeReport({ preRead: { status: 'In Progress', revision_no: 5, data: {}, batch_status: null } });
    await expect(PdiReports.patchReport(7, { data: { a: 1 } }, null, { expected_revision: 4 })).rejects.toMatchObject({ code: 'REPORT_VERSION_CONFLICT' });
    expect(updateCall()).toBeUndefined();
  });

  it('explains a 0-row UPDATE: lot finalized meanwhile -> BATCH_MEMBER_LOCKED', async () => {
    fakeReport({ preRead: { status: 'In Progress', revision_no: 3, data: {}, batch_status: 'In Progress' }, updateRows: [], stateRow: { status: 'In Progress', revision_no: 3, batch_id: 21, batch_status: 'Finalizing' } });
    await expect(PdiReports.patchReport(7, { data: { a: 1 } })).rejects.toMatchObject({ code: 'BATCH_MEMBER_LOCKED' });
  });

  it('explains a 0-row UPDATE: report finalized meanwhile -> REPORT_LOCKED', async () => {
    fakeReport({ preRead: { status: 'In Progress', revision_no: 3, data: {}, batch_status: null }, updateRows: [], stateRow: { status: 'Completed', revision_no: 3, batch_id: null, batch_status: null } });
    await expect(PdiReports.patchReport(7, { data: { a: 1 } })).rejects.toMatchObject({ code: 'REPORT_LOCKED' });
  });

  it('explains a 0-row UPDATE: someone else saved first -> REPORT_VERSION_CONFLICT; deleted -> Report not found', async () => {
    fakeReport({ preRead: { status: 'In Progress', revision_no: 3, data: {}, batch_status: null }, updateRows: [], stateRow: { status: 'In Progress', revision_no: 4, batch_id: null, batch_status: null } });
    await expect(PdiReports.patchReport(7, { data: { a: 1 } }, null, { expected_revision: 3 })).rejects.toMatchObject({ code: 'REPORT_VERSION_CONFLICT' });
    fakeReport({ preRead: { status: 'In Progress', revision_no: 3, data: {}, batch_status: null }, updateRows: [], stateRow: null });
    await expect(PdiReports.patchReport(7, { data: { a: 1 } })).rejects.toThrow('Report not found');
  });

  it('?photos=summary: the save answers with photo counts, not the stored photos', async () => {
    fakeReport({ preRead: { status: 'In Progress', revision_no: 3, data: {}, batch_status: null } });
    await PdiReports.patchReport(7, { photos: { front: 'data:image/jpeg;base64,AAAA' } }, null, { photosSummary: true });
    const [sql] = updateCall();
    expect(sql).toMatch(/RETURNING[\s\S]*'image_count'[\s\S]*AS photos/);
  });
});

describe('finalizeReport on a lot member', () => {
  it('refuses with BATCH_MEMBER_USE_LOT and never renders or writes', async () => {
    mockState.impl = async () => ({ rows: [fullRow({ batch_id: 21, lot_index: 1, batch: { lot_quantity: 6, status: 'In Progress', pdi_no: 'LOT' } })] });
    await expect(PdiReports.finalizeReport(7)).rejects.toMatchObject({
      code: 'BATCH_MEMBER_USE_LOT', message: 'This report is part of a lot. Finalize it from the lot page.',
    });
    expect(mockQuery.mock.calls.some(([sql]) => /UPDATE/.test(sql))).toBe(false);
  });
});

describe('controller error mapping', () => {
  const fakeRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.json = jest.fn((b) => { res.body = b; return res; });
    return res;
  };
  const req = (over = {}) => ({ params: { id: '7' }, query: {}, body: {}, headers: {}, user: { user_id: 1, role_id: 1 }, get: () => undefined, ...over });

  it.each([
    [{ status: 'Completed' }, 400, 'INVALID_STATUS'],
  ])('PATCH %p -> %i %s as { error, code }', async (body, status, code) => {
    const res = fakeRes();
    await controller.patchReport(req({ body }), res);
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({ error: expect.any(String), code });
  });

  it('PATCH on a locked lot member -> 409 BATCH_MEMBER_LOCKED', async () => {
    mockState.impl = async () => ({ rows: [{ status: 'In Progress', revision_no: 1, data: {}, batch_status: 'Completed' }] });
    const res = fakeRes();
    await controller.patchReport(req({ body: { data: {} } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('BATCH_MEMBER_LOCKED');
  });

  it('finalize on a lot member -> 409 BATCH_MEMBER_USE_LOT; missing report -> 404 with a code', async () => {
    mockState.impl = async () => ({ rows: [fullRow({ batch_id: 21 })] });
    let res = fakeRes();
    await controller.finalizeReport(req(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('BATCH_MEMBER_USE_LOT');

    mockState.impl = async () => ({ rows: [] });
    res = fakeRes();
    await controller.getReport(req(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Report not found', code: 'REPORT_NOT_FOUND' });
  });
});

describe('requirePdiAccess', () => {
  const run = (user) => {
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    const next = jest.fn();
    requirePdiAccess({ user }, res, next);
    return { res, next };
  };

  it.each([
    ['admin', 1], ['production', 5],
    ['Production', 99], // role_name from the roles table, any case
    ['', 5], // role_name missing, role_id maps to production
  ])('lets %p (role_id %p) through', (role_name, role_id) => {
    expect(run({ role_name: role_name.toLowerCase(), role_id }).next).toHaveBeenCalled();
  });

  it.each([['sales', 3], ['customer', 2], ['design', 4], ['store', 6], ['dispatch', 7], ['accounts', 8], ['employee', 9], ['hr', 10], ['', undefined]])('refuses %p with 403 PDI_FORBIDDEN', (role_name, role_id) => {
    const { res, next } = run({ role_name, role_id });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "You don't have access to PDI reports.", code: 'PDI_FORBIDDEN' });
  });
});
