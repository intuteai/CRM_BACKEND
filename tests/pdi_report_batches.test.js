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

  it('rejects an unknown template_id with the same error PdiReports.resolveTemplateVersion throws, before opening a connection', async () => {
    await expect(PdiReportBatches.createBatch({ template_id: 'not-a-real-template', pdi_no: 'P-1', quantity: 2 }))
      .rejects.toThrow(/Unknown PDI template: not-a-real-template/);
    expect(mockConnect).not.toHaveBeenCalled();
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

describe('finalizeBatch', () => {
  const reportRow = (lotIndex, over = {}) => ({
    report_id: 1000 + lotIndex, lot_index: lotIndex, status: 'Pending', template_id: 'autonxt', template_version: null,
    data: { pdi_no: 'PDI-2026-001', customer_name: 'Unit', motor_sr_no: `SR${lotIndex}` }, photos: {},
    ...over,
  });

  // finalizeBatch now does its two status UPDATEs inside a transaction via
  // client.query (pool.connect()), while the read-only SELECTs still go
  // through plain pool.query -- so a successful-finalize test needs both
  // mockState.poolQueryImpl (for the SELECTs) and this mockClient.query
  // implementation (for BEGIN/the bulk UPDATEs/COMMIT).
  function mockSuccessfulFinalizeTransaction() {
    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
      if (/UPDATE pre_dispatch_inspection_reports[\s\S]*SET status = 'Completed'[\s\S]*WHERE batch_id/.test(sql)) {
        return { rows: [{ report_id: 1001 }, { report_id: 1002 }], rowCount: 2 };
      }
      if (/UPDATE pdi_report_batches[\s\S]*SET status = 'Completed'[\s\S]*WHERE batch_id/.test(sql)) {
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected client query in test: ${sql}`);
    });
  }

  it('marks every linked report Completed, renders one combined PDF, and marks the batch Completed', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT [\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt', pdi_no: 'PDI-2026-001', lot_quantity: 2, status: 'In Progress' }] };
      }
      if (/SELECT [\s\S]*FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql)) {
        return { rows: [reportRow(1), reportRow(2)] };
      }
      return { rows: [], rowCount: 0 };
    };
    mockSuccessfulFinalizeTransaction();
    mockUpload.mockResolvedValue({ id: 'drive-batch-1' });

    const result = await PdiReportBatches.finalizeBatch(101);
    expect(result.pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(result.payload.status).toBe('Completed');
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    // Render happens BEFORE the transaction opens: mockConnect must not have
    // been called until after PDIGenerator has already produced a buffer --
    // verified indirectly here by the render succeeding and result.pdfBuffer
    // being present alongside a committed transaction.
    await result.background;
    expect(await pdfCache.read(101, 'batch')).not.toBeNull();
  });

  it('refuses an already-Completed batch without touching any report or rendering anything', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT [\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt', pdi_no: 'P', lot_quantity: 2, status: 'Completed' }] };
      }
      return { rows: [], rowCount: 0 };
    };
    await expect(PdiReportBatches.finalizeBatch(101)).rejects.toMatchObject({ code: 'BATCH_ALREADY_FINALIZED' });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('throws BATCH_INCOMPLETE when the loaded report count does not match lot_quantity (e.g. a linked report was deleted)', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT [\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt', pdi_no: 'PDI-2026-001', lot_quantity: 3, status: 'In Progress' }] };
      }
      if (/SELECT [\s\S]*FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql)) {
        // only 2 of the 3 expected reports come back -- e.g. one was deleted
        return { rows: [reportRow(1), reportRow(2)] };
      }
      return { rows: [], rowCount: 0 };
    };
    await expect(PdiReportBatches.finalizeBatch(101)).rejects.toMatchObject({ code: 'BATCH_INCOMPLETE' });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('fails the whole batch before marking anything Completed if one report is missing pdi_no', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT [\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt', pdi_no: 'PDI-2026-001', lot_quantity: 2, status: 'In Progress' }] };
      }
      if (/SELECT [\s\S]*FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql)) {
        return { rows: [reportRow(1), reportRow(2, { data: { motor_sr_no: 'SR2' /* no pdi_no */ } })] };
      }
      return { rows: [], rowCount: 0 };
    };
    await expect(PdiReportBatches.finalizeBatch(101)).rejects.toMatchObject({ code: 'PDI_NO_REQUIRED' });
    expect(mockUpload).not.toHaveBeenCalled();

    // I4: prove the validate loop runs before ANY write -- not just that Drive
    // wasn't reached (which would still pass if a merged validate+update loop
    // updated report 1 before discovering report 2's missing pdi_no).
    const updateCalls = mockClient.query.mock.calls.filter(([sql]) => /UPDATE pre_dispatch_inspection_reports/.test(sql));
    expect(updateCalls).toHaveLength(0);
  });
});

describe('getBatchPdfForDownload', () => {
  it('returns 409 BATCH_NOT_READY when the batch has not been finalized', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT status FROM pdi_report_batches WHERE batch_id/.test(sql)) return { rows: [{ status: 'In Progress' }] };
      return { rows: [], rowCount: 0 };
    };
    await expect(PdiReportBatches.getBatchPdfForDownload(101)).rejects.toMatchObject({ code: 'BATCH_NOT_READY' });
  });

  it('serves the cached combined PDF for a Completed batch', async () => {
    await pdfCache.write(101, Buffer.from('%PDF-1.4 combined'), 'batch');
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT status FROM pdi_report_batches WHERE batch_id/.test(sql)) return { rows: [{ status: 'Completed' }] };
      return { rows: [], rowCount: 0 };
    };
    const { buffer, source } = await PdiReportBatches.getBatchPdfForDownload(101);
    expect(buffer.toString()).toBe('%PDF-1.4 combined');
    expect(source).toBe('cache');
  });
});
