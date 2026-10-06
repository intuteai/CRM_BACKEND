// AutoNXT lot/batch reports (docs/superpowers/specs/2026-09-29-autonxt-batch-reports-design.md).
// The database and Google Drive are mocked, matching every other PDI model test in this repo --
// see tests/pdi_finalize_pdf.test.js for the established pattern this extends.
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};
const mockState = {
  poolQueryImpl: null, // set per-test for pool.query calls outside a transaction
};
const mockQuery = jest.fn(async (...args) => {
  if (mockState.poolQueryImpl) return mockState.poolQueryImpl(...args);
  return { rows: [], rowCount: 0 };
});
const mockConnect = jest.fn(async () => mockClient);
const mockUpload = jest.fn();
const mockDeleteDrive = jest.fn(async () => undefined);

jest.mock('../config/db', () => ({
  query: (...a) => mockQuery(...a),
  connect: (...a) => mockConnect(...a),
}));
jest.mock('../services/googleDrive', () => ({
  uploadBufferToDrivePrivate: (...a) => mockUpload(...a),
  deleteDriveFile: (...a) => mockDeleteDrive(...a),
}));

const PdiReportBatches = require('../models/operations/pdiReportBatches');
const pdfCache = require('../models/operations/pdi/pdfCache');
const PDIGenerator = require('../models/operations/pdi_generator');

// Shared report-row fixture used by both the finalizeBatch and
// getBatchPdfForDownload describe blocks below.
const reportRow = (lotIndex, over = {}) => ({
  report_id: 1000 + lotIndex, lot_index: lotIndex, status: 'Pending', template_id: 'autonxt', template_version: null,
  data: { pdi_no: 'PDI-2026-001', customer_name: 'Unit', motor_sr_no: `SR${lotIndex}` }, photos: {},
  ...over,
});

let cacheDir;
beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdi-batch-cache-test-'));
  process.env.PDI_PDF_CACHE_DIR = cacheDir;
  mockQuery.mockClear();
  mockConnect.mockClear();
  mockClient.query.mockReset();
  mockClient.release.mockClear();
  mockUpload.mockReset();
  mockDeleteDrive.mockClear();
  mockState.poolQueryImpl = null;
});
afterEach(() => { fs.rmSync(cacheDir, { recursive: true, force: true }); delete process.env.PDI_PDF_CACHE_DIR; });

describe('createBatch', () => {
  it('validates lot quantity is an integer in [1, 50]', async () => {
    await expect(PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'P-1', quantity: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_LOT_QUANTITY' });
    await expect(PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'P-1', quantity: 51 }))
      .rejects.toMatchObject({ code: 'INVALID_LOT_QUANTITY' });
    await expect(PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'P-1', quantity: 2.5 }))
      .rejects.toMatchObject({ code: 'INVALID_LOT_QUANTITY' });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('creates one batch row and N linked report rows inside one transaction, in lot_index order, storing template_version too', async () => {
    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (/INSERT INTO pdi_report_batches/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt', pdi_no: 'PDI-2026-001', lot_quantity: 3, status: 'In Progress' }] };
      }
      if (/INSERT INTO pre_dispatch_inspection_reports/.test(sql)) {
        const lotIndex = params[params.length - 1];
        return { rows: [{ report_id: 1000 + lotIndex, lot_index: lotIndex }] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    });

    const result = await PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'PDI-2026-001', quantity: 3, created_by: 5 });

    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(result.batch_id).toBe(101);
    expect(result.lot_quantity).toBe(3);
    expect(result.status).toBe('In Progress');
    expect(result.reports).toEqual([
      { report_id: 1001, lot_index: 1, lot_quantity: 3 },
      { report_id: 1002, lot_index: 2, lot_quantity: 3 },
      { report_id: 1003, lot_index: 3, lot_quantity: 3 },
    ]);

    // autonxt is a code-registered template, so resolveTemplateVersion resolves
    // its version as null -- confirm that null is actually bound into the INSERT,
    // proving createBatch wires template_version through rather than dropping it.
    const reportInsertCalls = mockClient.query.mock.calls.filter(([sql]) => /INSERT INTO pre_dispatch_inspection_reports/.test(sql));
    expect(reportInsertCalls).toHaveLength(3);
    for (const [sql, params] of reportInsertCalls) {
      expect(sql).toMatch(/template_version/);
      expect(params[0]).toBe('autonxt'); // templateId
      expect(params[1]).toBeNull(); // templateVersion -- null for a code-registered template
    }
  });

  it('stamps optional shared fields (customer/product/dwg/controller) onto the batch row and every linked report, alongside pdi_no', async () => {
    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (/INSERT INTO pdi_report_batches/.test(sql)) {
        return {
          rows: [{
            batch_id: 101, template_id: 'autonxt', pdi_no: 'PDI-2026-001', lot_quantity: 2, status: 'In Progress',
            customer_name: 'Autonxt', product_id: 'PMSM220_HV32384', product_specifications: '32.0kw, 384V, 2350',
            drawing_no: 'CASPL-220/007-00', controller_type: 'CASHV38140',
          }],
        };
      }
      if (/INSERT INTO pre_dispatch_inspection_reports/.test(sql)) {
        const lotIndex = params[params.length - 1];
        return { rows: [{ report_id: 1000 + lotIndex, lot_index: lotIndex }] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    });

    const result = await PdiReportBatches.createBatch({
      template_id: 'autonxt', pdi_no: 'PDI-2026-001', quantity: 2,
      customer_name: 'Autonxt', product_id: 'PMSM220_HV32384', product_specifications: '32.0kw, 384V, 2350',
      drawing_no: 'CASPL-220/007-00', controller_type: 'CASHV38140',
    });
    expect(result.customer_name).toBe('Autonxt');

    const reportInsertCalls = mockClient.query.mock.calls.filter(([sql]) => /INSERT INTO pre_dispatch_inspection_reports/.test(sql));
    expect(reportInsertCalls).toHaveLength(2);
    for (const [, params] of reportInsertCalls) {
      const stampedData = JSON.parse(params[2]); // data is the 3rd bound param
      expect(stampedData).toEqual({
        pdi_no: 'PDI-2026-001', customer_name: 'Autonxt', product_id: 'PMSM220_HV32384',
        product_specifications: '32.0kw, 384V, 2350', drawing_no: 'CASPL-220/007-00', controller_type: 'CASHV38140',
      });
    }
  });

  it('omits shared fields from every linked report\'s data when none are provided (only pdi_no is stamped)', async () => {
    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (/INSERT INTO pdi_report_batches/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt', pdi_no: 'P', lot_quantity: 1, status: 'In Progress' }] };
      }
      if (/INSERT INTO pre_dispatch_inspection_reports/.test(sql)) {
        return { rows: [{ report_id: 1001, lot_index: params[params.length - 1] }] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    });

    await PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'P', quantity: 1 });

    const [, params] = mockClient.query.mock.calls.find(([sql]) => /INSERT INTO pre_dispatch_inspection_reports/.test(sql));
    expect(JSON.parse(params[2])).toEqual({ pdi_no: 'P' });
  });

  it('rejects any template other than autonxt/autonxt_controller with TEMPLATE_NOT_BATCHABLE, before opening a connection', async () => {
    await expect(PdiReportBatches.createBatch({ template_id: 'not-a-real-template', pdi_no: 'P-1', quantity: 2 }))
      .rejects.toMatchObject({ code: 'TEMPLATE_NOT_BATCHABLE' });
    await expect(PdiReportBatches.createBatch({ template_id: 'general', pdi_no: 'P-1', quantity: 2 }))
      .rejects.toMatchObject({ code: 'TEMPLATE_NOT_BATCHABLE' });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('accepts a digit-string quantity (trimmed) and rejects anything else that is not a whole number', async () => {
    for (const bad of ['3.0', '1e1', 'abc', '', '  ', true, null, undefined, [], '-2']) {
      await expect(PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'P-1', quantity: bad }))
        .rejects.toMatchObject({ code: 'INVALID_LOT_QUANTITY' });
    }
    expect(mockConnect).not.toHaveBeenCalled();

    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (/INSERT INTO pdi_report_batches/.test(sql)) return { rows: [{ batch_id: 101, lot_quantity: params[2] }] };
      return { rows: [{ report_id: 1000 + params[params.length - 1], lot_index: params[params.length - 1] }] };
    });
    const result = await PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'P-1', quantity: ' 3 ' });
    expect(result.reports).toHaveLength(3);
  });

  it('trims pdi_no and shared fields, ignores non-string shared values, and requires a non-blank string pdi_no', async () => {
    await expect(PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: '   ', quantity: 1 })).rejects.toMatchObject({ code: 'PDI_NO_REQUIRED' });
    await expect(PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 123, quantity: 1 })).rejects.toMatchObject({ code: 'PDI_NO_REQUIRED' });

    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (/INSERT INTO pdi_report_batches/.test(sql)) return { rows: [{ batch_id: 101 }] };
      return { rows: [{ report_id: 1001, lot_index: params[params.length - 1] }] };
    });
    await PdiReportBatches.createBatch({
      template_id: 'autonxt', pdi_no: '  P-1 ', quantity: 1, customer_name: ' Acme ', product_id: 42, drawing_no: { x: 1 }, product_specifications: '  ',
    });
    const [, batchParams] = mockClient.query.mock.calls.find(([sql]) => /INSERT INTO pdi_report_batches/.test(sql));
    expect(batchParams.slice(1, 2)).toEqual(['P-1']);
    expect(batchParams.slice(4)).toEqual(['Acme', null, null, null, null]);
    const [, reportParams] = mockClient.query.mock.calls.find(([sql]) => /INSERT INTO pre_dispatch_inspection_reports/.test(sql));
    expect(JSON.parse(reportParams[2])).toEqual({ pdi_no: 'P-1', customer_name: 'Acme' });
  });

  it('a Controller lot must use a known controller type preset', async () => {
    await expect(PdiReportBatches.createBatch({ template_id: 'autonxt_controller', pdi_no: 'P', quantity: 1, controller_type: 'NOPE' }))
      .rejects.toMatchObject({ code: 'INVALID_CONTROLLER_TYPE' });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('emits pdiReportUpdate Pending for every member after commit', async () => {
    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (/INSERT INTO pdi_report_batches/.test(sql)) return { rows: [{ batch_id: 101 }] };
      return { rows: [{ report_id: 1000 + params[params.length - 1], lot_index: params[params.length - 1] }] };
    });
    const io = { emit: jest.fn() };
    await PdiReportBatches.createBatch({ template_id: 'autonxt_controller', pdi_no: 'P', quantity: 2, controller_type: 'CASHV38140' }, io);
    expect(io.emit.mock.calls).toEqual([
      ['pdiReportUpdate', { report_id: 1001, status: 'Pending' }],
      ['pdiReportUpdate', { report_id: 1002, status: 'Pending' }],
    ]);
  });

  it('rolls back the whole transaction if any report insert fails -- no partial batch', async () => {
    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (/INSERT INTO pdi_report_batches/.test(sql)) return { rows: [{ batch_id: 101, template_id: 'autonxt', pdi_no: 'P', lot_quantity: 3, status: 'In Progress' }] };
      if (/INSERT INTO pre_dispatch_inspection_reports/.test(sql)) {
        const lotIndex = params[params.length - 1];
        if (lotIndex === 2) throw new Error('simulated DB failure on report 2');
        return { rows: [{ report_id: 1000 + lotIndex, lot_index: lotIndex }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'P', quantity: 3 })).rejects.toThrow(/simulated DB failure/);
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('getBatch', () => {
  it('throws Batch not found for a non-numeric batchId, without querying the database', async () => {
    await expect(PdiReportBatches.getBatch('not-a-number')).rejects.toThrow('Batch not found');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('throws Batch not found for ids that are not 1-9 plain digits, without querying the database', async () => {
    for (const bad of ['12abc', '1234567890', ' 12', '0x1F', '1.0']) {
      await expect(PdiReportBatches.getBatch(bad)).rejects.toThrow('Batch not found');
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('throws Batch not found when no batch row matches', async () => {
    mockState.poolQueryImpl = async () => ({ rows: [] });
    await expect(PdiReportBatches.getBatch(101)).rejects.toThrow('Batch not found');
  });

  it('returns controller_sr_no (alongside motor_sr_no) for each linked report, matching whichever field that report\'s data actually holds', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT [\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt_controller', pdi_no: 'PDI-2026-001', lot_quantity: 2, status: 'In Progress' }] };
      }
      if (/SELECT [\s\S]*FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql)) {
        return {
          rows: [
            { report_id: 1001, lot_index: 1, status: 'Completed', motor_sr_no: null, controller_sr_no: 'CSR1', pdi_no: 'PDI-2026-001' },
            { report_id: 1002, lot_index: 2, status: 'Pending', motor_sr_no: null, controller_sr_no: null, pdi_no: 'PDI-2026-001' },
          ],
        };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    };

    const result = await PdiReportBatches.getBatch(101);

    expect(result.reports).toHaveLength(2);
    expect(result.reports[0].controller_sr_no).toBe('CSR1');
    expect(result.reports[0].motor_sr_no).toBeNull();
    expect(result.reports[1].controller_sr_no).toBeNull();

    // Guard against a future regression silently dropping the column again --
    // the query itself must actually select controller_sr_no, not just happen
    // to pass because the mock echoes it back.
    const [reportsQuerySql] = mockQuery.mock.calls.find(([sql]) => /FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql));
    expect(reportsQuerySql).toMatch(/data->>'controller_sr_no' AS controller_sr_no/);
  });

  it('still returns motor_sr_no correctly for a Motor (autonxt) batch -- no regression', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT [\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) {
        return { rows: [{ batch_id: 102, template_id: 'autonxt', pdi_no: 'PDI-2026-002', lot_quantity: 1, status: 'In Progress' }] };
      }
      if (/SELECT [\s\S]*FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql)) {
        return { rows: [{ report_id: 2001, lot_index: 1, status: 'Pending', motor_sr_no: 'SR1', controller_sr_no: null, pdi_no: 'PDI-2026-002' }] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    };

    const result = await PdiReportBatches.getBatch(102);
    expect(result.reports[0].motor_sr_no).toBe('SR1');
  });
});

describe('finalizeBatch', () => {
  // finalizeBatch first flips the lot In Progress -> Finalizing with a
  // guarded pool.query UPDATE, reads members (without photos) and each
  // member's photos through pool.query, and does the two Completed UPDATEs
  // in a pool.connect() transaction. Any failure after the flip reverts the
  // lot with another pool.query UPDATE. This fake pool keeps the lot's status
  // so each test can check where it ended up.
  function fakeLot({ batch, reports, photosById = {} }) {
    const lot = { ...batch };
    mockState.poolQueryImpl = async (sql, params) => {
      if (/UPDATE pdi_report_batches SET status = 'Finalizing'/.test(sql)) {
        if (lot.status !== 'In Progress') return { rows: [], rowCount: 0 };
        lot.status = 'Finalizing';
        return { rows: [{ ...lot }], rowCount: 1 };
      }
      if (/SET status = 'In Progress' WHERE batch_id = \$1 AND status = 'Finalizing'/.test(sql)) {
        if (lot.status !== 'Finalizing') return { rows: [], rowCount: 0 };
        lot.status = 'In Progress';
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT status FROM pdi_report_batches WHERE batch_id/.test(sql)) return { rows: [{ status: lot.status }] };
      if (/SELECT [\s\S]*FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql)) return { rows: reports };
      if (/SELECT photos FROM pre_dispatch_inspection_reports WHERE report_id = \$1/.test(sql)) {
        return { rows: [{ photos: photosById[params[0]] || {} }] };
      }
      return { rows: [], rowCount: 0 };
    };
    mockClient.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql === 'COMMIT') { lot.status = lot.pendingStatus || lot.status; return {}; }
      if (/UPDATE pre_dispatch_inspection_reports[\s\S]*SET status = 'Completed'[\s\S]*WHERE batch_id/.test(sql)) {
        return { rows: [], rowCount: reports.length };
      }
      if (/UPDATE pdi_report_batches[\s\S]*SET status = 'Completed'[\s\S]*WHERE batch_id = \$1 AND status = 'Finalizing'/.test(sql)) {
        if (lot.status !== 'Finalizing') return { rowCount: 0 };
        lot.pendingStatus = 'Completed';
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected client query in test: ${sql}`);
    });
    return lot;
  }

  const inProgress = (over = {}) => ({ batch_id: 101, template_id: 'autonxt', pdi_no: 'PDI-2026-001', lot_quantity: 2, status: 'In Progress', ...over });
  const updateCalls = () => mockClient.query.mock.calls.filter(([sql]) => /UPDATE pre_dispatch_inspection_reports/.test(sql));

  it('flips the lot to Finalizing, renders one combined PDF, marks everything Completed, and emits per member', async () => {
    const lot = fakeLot({ batch: inProgress(), reports: [reportRow(1), reportRow(2)] });
    mockUpload.mockResolvedValue({ id: 'drive-batch-1' });
    const io = { emit: jest.fn() };
    await pdfCache.write(1001, Buffer.from('%PDF-1.4 stale single'));

    const result = await PdiReportBatches.finalizeBatch(101, io);

    expect(result.pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(result.payload.status).toBe('Completed');
    expect(lot.status).toBe('Completed');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(io.emit).toHaveBeenCalledWith('pdiReportUpdate', { report_id: 1001, status: 'Completed' });
    expect(io.emit).toHaveBeenCalledWith('pdiReportUpdate', { report_id: 1002, status: 'Completed' });
    // a member's old single-report PDF is cleared
    expect(await pdfCache.read(1001)).toBeNull();
    // no revert after a successful commit
    expect(mockQuery.mock.calls.some(([sql]) => /SET status = 'In Progress'/.test(sql))).toBe(false);
    await result.background;
    expect(await pdfCache.read(101, 'batch')).not.toBeNull();
  });

  it('loads photos one report at a time while rendering, not with the member list', async () => {
    fakeLot({ batch: inProgress(), reports: [reportRow(1), reportRow(2)], photosById: { 1001: { front: 'x' }, 1002: {} } });
    mockUpload.mockResolvedValue({ id: 'd' });
    const generateCombinedSpy = jest.spyOn(PDIGenerator, 'generateCombined');

    await PdiReportBatches.finalizeBatch(101);

    const [membersSql] = mockQuery.mock.calls.find(([sql]) => /FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql));
    expect(membersSql).not.toMatch(/photos/);
    const photoLoads = mockQuery.mock.calls.filter(([sql]) => /SELECT photos FROM pre_dispatch_inspection_reports WHERE report_id/.test(sql));
    expect(photoLoads.map(([, params]) => params[0])).toEqual([1001, 1002]);
    const entries = generateCombinedSpy.mock.calls[0][0];
    expect(typeof entries[0].loadPhotos).toBe('function');
    expect(await entries[0].loadPhotos()).toEqual({ front: 'x' });
    generateCombinedSpy.mockRestore();
  });

  it('refuses an already-Completed lot with BATCH_ALREADY_FINALIZED, rendering nothing', async () => {
    fakeLot({ batch: inProgress({ status: 'Completed' }), reports: [reportRow(1), reportRow(2)] });
    await expect(PdiReportBatches.finalizeBatch(101)).rejects.toMatchObject({ code: 'BATCH_ALREADY_FINALIZED' });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('refuses a lot that is already Finalizing with BATCH_FINALIZING and leaves it Finalizing', async () => {
    const lot = fakeLot({ batch: inProgress({ status: 'Finalizing' }), reports: [reportRow(1), reportRow(2)] });
    await expect(PdiReportBatches.finalizeBatch(101)).rejects.toMatchObject({ code: 'BATCH_FINALIZING', message: 'This lot is already being finalized.' });
    expect(lot.status).toBe('Finalizing');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('answers Batch not found for a missing lot, and for an id that is not 1-9 digits without querying', async () => {
    mockState.poolQueryImpl = async () => ({ rows: [], rowCount: 0 });
    await expect(PdiReportBatches.finalizeBatch(999)).rejects.toThrow('Batch not found');
    mockQuery.mockClear();
    for (const bad of ['abc', '12abc', '1234567890', '-1', '1.5', '']) {
      await expect(PdiReportBatches.finalizeBatch(bad)).rejects.toThrow('Batch not found');
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('throws BATCH_INCOMPLETE when the member count does not match lot_quantity, and reverts the lot', async () => {
    const lot = fakeLot({ batch: inProgress({ lot_quantity: 3 }), reports: [reportRow(1), reportRow(2)] });
    await expect(PdiReportBatches.finalizeBatch(101)).rejects.toMatchObject({ code: 'BATCH_INCOMPLETE' });
    expect(lot.status).toBe('In Progress');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('no longer requires a per-member pdi_no: the lot pdi_no is used instead', async () => {
    const lot = fakeLot({ batch: inProgress(), reports: [reportRow(1), reportRow(2, { data: { motor_sr_no: 'SR2' } })] });
    mockUpload.mockResolvedValue({ id: 'd' });
    const result = await PdiReportBatches.finalizeBatch(101);
    expect(result.payload.status).toBe('Completed');
    expect(lot.status).toBe('Completed');
  });

  it('checks every member before failing: lists each lot missing a motor serial (blank or whitespace), and reverts the lot', async () => {
    const lot = fakeLot({
      batch: inProgress({ lot_quantity: 3 }),
      reports: [
        reportRow(1),
        reportRow(2, { data: { pdi_no: 'PDI-2026-001' } }),
        reportRow(3, { data: { pdi_no: 'PDI-2026-001', motor_sr_no: '   ' } }),
      ],
    });
    await expect(PdiReportBatches.finalizeBatch(101)).rejects.toMatchObject({
      code: 'MOTOR_SR_NO_REQUIRED',
      lots: [2, 3],
      message: 'Enter a motor serial number for lot 2, 3 before finalizing.',
    });
    expect(updateCalls()).toHaveLength(0);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(lot.status).toBe('In Progress');
  });

  it('a Controller lot reports missing controller serials with CONTROLLER_SR_NO_REQUIRED', async () => {
    fakeLot({
      batch: inProgress({ template_id: 'autonxt_controller', lot_quantity: 5 }),
      reports: [1, 2, 3, 4, 5].map((n) => reportRow(n, {
        template_id: 'autonxt_controller',
        data: { pdi_no: 'PDI-2026-001', ...(n === 2 || n === 5 ? {} : { controller_sr_no: `C${n}` }) },
      })),
    });
    await expect(PdiReportBatches.finalizeBatch(101)).rejects.toMatchObject({
      code: 'CONTROLLER_SR_NO_REQUIRED',
      lots: [2, 5],
      message: 'Enter a controller serial number for lot 2, 5 before finalizing.',
    });
    expect(updateCalls()).toHaveLength(0);
  });

  it('a Controller lot with every controller_sr_no set does NOT require motor_sr_no', async () => {
    fakeLot({
      batch: inProgress({ template_id: 'autonxt_controller', lot_quantity: 1 }),
      reports: [reportRow(1, { template_id: 'autonxt_controller', template_version: 1, data: { pdi_no: 'PDI-2026-001', controller_sr_no: 'SR1' } })],
    });
    mockUpload.mockResolvedValue({ id: 'drive-file-1' });
    const result = await PdiReportBatches.finalizeBatch(101);
    expect(result.payload.status).toBe('Completed');
  });

  it('if rendering fails, no report status is touched and the lot goes back to In Progress', async () => {
    const lot = fakeLot({ batch: inProgress(), reports: [reportRow(1, { template_id: 'not-a-real-template' }), reportRow(2)] });
    await expect(PdiReportBatches.finalizeBatch(101)).rejects.toThrow(/Unknown PDI template/);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(lot.status).toBe('In Progress');
  });

  it('if the commit transaction fails, it rolls back and the lot goes back to In Progress', async () => {
    const lot = fakeLot({ batch: inProgress(), reports: [reportRow(1), reportRow(2)] });
    const original = mockClient.query.getMockImplementation();
    mockClient.query.mockImplementation(async (sql, params) => {
      if (/UPDATE pre_dispatch_inspection_reports/.test(sql)) throw new Error('simulated DB failure');
      return original(sql, params);
    });
    const io = { emit: jest.fn() };
    await expect(PdiReportBatches.finalizeBatch(101, io)).rejects.toThrow('simulated DB failure');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(lot.status).toBe('In Progress');
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('succeeds when one legacy member was already Completed before this lot finalize ran', async () => {
    fakeLot({ batch: inProgress(), reports: [reportRow(1, { status: 'Completed' }), reportRow(2)] });
    mockUpload.mockResolvedValue({ id: 'drive-batch-1' });
    const result = await PdiReportBatches.finalizeBatch(101);
    expect(result.payload.status).toBe('Completed');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.query).not.toHaveBeenCalledWith('ROLLBACK');
  });

  it("forces every rendered report data.pdi_no to the lot pdi_no, even when a report's own stored data.pdi_no differs", async () => {
    fakeLot({ batch: inProgress(), reports: [reportRow(1), reportRow(2, { data: { pdi_no: 'DRIFTED-NO', customer_name: 'Unit', motor_sr_no: 'SR2' } })] });
    mockUpload.mockResolvedValue({ id: 'drive-batch-1' });
    const generateCombinedSpy = jest.spyOn(PDIGenerator, 'generateCombined');

    await PdiReportBatches.finalizeBatch(101);

    const reportsData = generateCombinedSpy.mock.calls[0][0];
    expect(reportsData).toHaveLength(2);
    for (const r of reportsData) expect(r.data.pdi_no).toBe('PDI-2026-001');
    generateCombinedSpy.mockRestore();
  });

  it('overrides shared fields from the lot row when set, and leaves a report\'s own value for any the lot does not set', async () => {
    fakeLot({
      batch: inProgress({ customer_name: 'Autonxt', product_id: 'PMSM220_HV32384', product_specifications: null, drawing_no: null, controller_type: null }),
      reports: [
        reportRow(1, { data: { pdi_no: 'PDI-2026-001', customer_name: 'Drifted Co.', controller_type: 'CASHV38140', motor_sr_no: 'SR1' } }),
        reportRow(2, { data: { pdi_no: 'PDI-2026-001', controller_type: 'CASHV38140', motor_sr_no: 'SR2' } }),
      ],
    });
    mockUpload.mockResolvedValue({ id: 'drive-batch-1' });
    const generateCombinedSpy = jest.spyOn(PDIGenerator, 'generateCombined');

    await PdiReportBatches.finalizeBatch(101);

    for (const r of generateCombinedSpy.mock.calls[0][0]) {
      expect(r.data.customer_name).toBe('Autonxt');
      expect(r.data.product_id).toBe('PMSM220_HV32384');
      expect(r.data.controller_type).toBe('CASHV38140');
    }
    generateCombinedSpy.mockRestore();
  });
});

describe('listBatches', () => {
  it('returns newest-first lots with completed_count, filtered by template_id, default limit 20', async () => {
    const rows = [{ batch_id: 2, template_id: 'autonxt', pdi_no: 'P2', lot_quantity: 3, status: 'In Progress', customer_name: null, created_at: new Date(), completed_count: 0 }];
    mockState.poolQueryImpl = async () => ({ rows });

    const result = await PdiReportBatches.listBatches({ template_id: 'autonxt' });

    expect(result).toEqual(rows);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/completed_count/);
    expect(sql).toMatch(/ORDER BY b\.created_at DESC, b\.batch_id DESC/);
    expect(params).toEqual(['autonxt', 20]);
  });

  it('caps the limit at 100, floors it at 1, and passes no template filter when none is given', async () => {
    mockState.poolQueryImpl = async () => ({ rows: [] });
    await PdiReportBatches.listBatches({ limit: '500' });
    expect(mockQuery.mock.calls[0][1]).toEqual([null, 100]);
    await PdiReportBatches.listBatches({ limit: '0' });
    expect(mockQuery.mock.calls[1][1]).toEqual([null, 1]);
    await PdiReportBatches.listBatches({ limit: 'abc' });
    expect(mockQuery.mock.calls[2][1]).toEqual([null, 20]);
  });
});

describe('updateBatch', () => {
  function fakeUpdateTx({ template_id = 'autonxt', status = 'In Progress' } = {}) {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
      if (/SELECT template_id, status FROM pdi_report_batches WHERE batch_id = \$1 FOR UPDATE/.test(sql)) {
        return { rows: status ? [{ template_id, status }] : [] };
      }
      if (/UPDATE pdi_report_batches SET/.test(sql)) return { rowCount: 1 };
      if (/UPDATE pre_dispatch_inspection_reports/.test(sql)) return { rowCount: 2 };
      throw new Error(`Unexpected client query in test: ${sql}`);
    });
    mockState.poolQueryImpl = async (sql) => {
      if (/FROM pdi_report_batches WHERE batch_id/.test(sql)) return { rows: [{ batch_id: 101, template_id, pdi_no: 'NEW', lot_quantity: 2, status }] };
      if (/FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql)) return { rows: [] };
      return { rows: [] };
    };
  }

  it('trims strings, stores a cleared field as NULL on the lot and as "" in every member, in one transaction', async () => {
    fakeUpdateTx();
    const result = await PdiReportBatches.updateBatch(101, {
      pdi_no: '  NEW  ', customer_name: '  Acme ', drawing_no: '', product_id: null, controller_type: 42, ignored: 'x',
    });

    expect(result.batch_id).toBe(101);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    const [lotSql, lotParams] = mockClient.query.mock.calls.find(([sql]) => /UPDATE pdi_report_batches SET/.test(sql));
    expect(lotSql).toMatch(/pdi_no = \$2, customer_name = \$3, product_id = \$4, drawing_no = \$5/);
    expect(lotSql).not.toMatch(/controller_type/);
    expect(lotParams).toEqual([101, 'NEW', 'Acme', null, null]);
    const [memberSql, memberParams] = mockClient.query.mock.calls.find(([sql]) => /UPDATE pre_dispatch_inspection_reports/.test(sql));
    expect(memberSql).toMatch(/WHERE batch_id = \$1/);
    expect(memberSql).toMatch(/revision_no = revision_no \+ 1/);
    expect(JSON.parse(memberParams[1])).toEqual({ pdi_no: 'NEW', customer_name: 'Acme', product_id: '', drawing_no: '' });
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('refuses to empty pdi_no with PDI_NO_REQUIRED, before opening a connection', async () => {
    await expect(PdiReportBatches.updateBatch(101, { pdi_no: '   ' })).rejects.toMatchObject({ code: 'PDI_NO_REQUIRED' });
    await expect(PdiReportBatches.updateBatch(101, { pdi_no: null })).rejects.toMatchObject({ code: 'PDI_NO_REQUIRED' });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each(['Completed', 'Finalizing'])('refuses a %s lot with BATCH_ALREADY_FINALIZED and writes nothing', async (status) => {
    fakeUpdateTx({ status });
    await expect(PdiReportBatches.updateBatch(101, { customer_name: 'X' })).rejects.toMatchObject({ code: 'BATCH_ALREADY_FINALIZED' });
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query.mock.calls.some(([sql]) => /^\s*UPDATE/.test(sql))).toBe(false);
  });

  it('rejects an unknown controller_type on a Controller lot, but accepts a preset or an empty one', async () => {
    fakeUpdateTx({ template_id: 'autonxt_controller' });
    await expect(PdiReportBatches.updateBatch(101, { controller_type: 'NOPE' })).rejects.toMatchObject({ code: 'INVALID_CONTROLLER_TYPE' });
    await expect(PdiReportBatches.updateBatch(101, { controller_type: ' CASHV38140 ' })).resolves.toMatchObject({ batch_id: 101 });
    await expect(PdiReportBatches.updateBatch(101, { controller_type: '' })).resolves.toMatchObject({ batch_id: 101 });
  });

  it('lets a Motor lot keep a free-text controller_type', async () => {
    fakeUpdateTx({ template_id: 'autonxt' });
    await expect(PdiReportBatches.updateBatch(101, { controller_type: 'ANY-TEXT' })).resolves.toMatchObject({ batch_id: 101 });
  });

  it('answers Batch not found for a missing lot or a malformed id', async () => {
    fakeUpdateTx({ status: null });
    await expect(PdiReportBatches.updateBatch(101, { customer_name: 'X' })).rejects.toThrow('Batch not found');
    await expect(PdiReportBatches.updateBatch('1e3', {})).rejects.toThrow('Batch not found');
  });
});

describe('deleteBatch', () => {
  function fakeDeleteTx({ status = 'In Progress', members = [], batchDriveFileId = null } = {}) {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
      if (/SELECT status, drive_file_id FROM pdi_report_batches WHERE batch_id = \$1 FOR UPDATE/.test(sql)) {
        return { rows: status ? [{ status, drive_file_id: batchDriveFileId }] : [] };
      }
      if (/DELETE FROM pre_dispatch_inspection_reports WHERE batch_id = \$1/.test(sql)) return { rows: members, rowCount: members.length };
      if (/DELETE FROM pdi_report_batches WHERE batch_id = \$1/.test(sql)) return { rowCount: 1 };
      throw new Error(`Unexpected client query in test: ${sql}`);
    });
  }

  it('deletes members and the lot in one transaction, then clears caches and Drive files and emits Deleted per member', async () => {
    fakeDeleteTx({ members: [{ report_id: 1001, drive_file_id: 'd1' }, { report_id: 1002, drive_file_id: null }], batchDriveFileId: 'db' });
    await pdfCache.write(1001, Buffer.from('%PDF-1.4 a'));
    await pdfCache.write(101, Buffer.from('%PDF-1.4 lot'), 'batch');
    mockDeleteDrive.mockRejectedValueOnce(new Error('Drive down'));
    const io = { emit: jest.fn() };

    const result = await PdiReportBatches.deleteBatch(101, io);

    expect(result).toEqual({ deleted: true, batch_id: 101, report_ids: [1001, 1002] });
    const sqls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(sqls.findIndex((s) => /DELETE FROM pre_dispatch_inspection_reports/.test(s)))
      .toBeLessThan(sqls.findIndex((s) => /DELETE FROM pdi_report_batches/.test(s)));
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(await pdfCache.read(1001)).toBeNull();
    expect(await pdfCache.read(101, 'batch')).toBeNull();
    expect(mockDeleteDrive).toHaveBeenCalledWith('d1');
    expect(mockDeleteDrive).toHaveBeenCalledWith('db');
    expect(io.emit).toHaveBeenCalledWith('pdiReportUpdate', { report_id: 1001, status: 'Deleted' });
    expect(io.emit).toHaveBeenCalledWith('pdiReportUpdate', { report_id: 1002, status: 'Deleted' });
  });

  it.each(['Completed', 'Finalizing'])('refuses a %s lot with BATCH_ALREADY_FINALIZED and deletes nothing', async (status) => {
    fakeDeleteTx({ status });
    await expect(PdiReportBatches.deleteBatch(101)).rejects.toMatchObject({ code: 'BATCH_ALREADY_FINALIZED' });
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query.mock.calls.some(([sql]) => /DELETE/.test(sql))).toBe(false);
    expect(mockDeleteDrive).not.toHaveBeenCalled();
  });

  it('answers Batch not found for a missing lot or a malformed id', async () => {
    fakeDeleteTx({ status: null });
    await expect(PdiReportBatches.deleteBatch(101)).rejects.toThrow('Batch not found');
    await expect(PdiReportBatches.deleteBatch('101; DROP')).rejects.toThrow('Batch not found');
  });
});

describe('getBatchPdfForDownload', () => {
  it('returns 409 BATCH_NOT_READY when the batch has not been finalized', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT status, pdi_no[\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) return { rows: [{ status: 'In Progress', pdi_no: 'PDI-2026-001' }] };
      return { rows: [], rowCount: 0 };
    };
    await expect(PdiReportBatches.getBatchPdfForDownload(101)).rejects.toMatchObject({ code: 'BATCH_NOT_READY' });
  });

  it('serves the cached combined PDF for a Completed batch', async () => {
    await pdfCache.write(101, Buffer.from('%PDF-1.4 combined'), 'batch');
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT status, pdi_no[\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) return { rows: [{ status: 'Completed', pdi_no: 'PDI-2026-001' }] };
      return { rows: [], rowCount: 0 };
    };
    const { buffer, source, pdiNo } = await PdiReportBatches.getBatchPdfForDownload(101);
    expect(buffer.toString()).toBe('%PDF-1.4 combined');
    expect(source).toBe('cache');
    // the download filename is built from the lot's pdi_no
    expect(pdiNo).toBe('PDI-2026-001');
  });

  it('re-renders the combined PDF on a cache miss for a Completed batch, forcing every report data.pdi_no and any set shared field to the batch\'s own values', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT status, pdi_no[\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) {
        return { rows: [{ status: 'Completed', pdi_no: 'PDI-2026-001', customer_name: 'Autonxt', product_id: null }] };
      }
      if (/SELECT [\s\S]*FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql)) {
        return {
          rows: [
            reportRow(1),
            reportRow(2, { data: { pdi_no: 'SOME-OTHER-NO', customer_name: 'Unit', motor_sr_no: 'SR2' } }),
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    };
    const generateCombinedSpy = jest.spyOn(PDIGenerator, 'generateCombined');

    const { buffer, source } = await PdiReportBatches.getBatchPdfForDownload(101);

    expect(source).toBe('rendered');
    expect(buffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(generateCombinedSpy).toHaveBeenCalledTimes(1);
    const reportsData = generateCombinedSpy.mock.calls[0][0];
    expect(reportsData).toHaveLength(2);
    for (const r of reportsData) {
      expect(r.data.pdi_no).toBe('PDI-2026-001');
      // Set on the batch (customer_name) -> overrides; not set (product_id
      // is null on the batch) -> report 2's own value is left untouched.
      expect(r.data.customer_name).toBe('Autonxt');
    }
    expect(reportsData[1].data.motor_sr_no).toBe('SR2');

    // cache-miss render also writes the disk cache, same as the finalize path.
    expect(await pdfCache.read(101, 'batch')).not.toBeNull();

    generateCombinedSpy.mockRestore();
  });
});
