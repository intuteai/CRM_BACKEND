'use strict';

const pool = require('../../config/db');
const logger = require('../../utils/logger');
const PDIGenerator = require('./pdi_generator');
const PdiReports = require('./pdiReports');
const { uploadBufferToDrivePrivate, deleteDriveFile } = require('../../services/googleDrive');
const pdfCache = require('./pdi/pdfCache');
const { SHARED_FIELDS, pickSharedFields } = require('./pdi/batchOverrides');
const { CONTROLLER_TYPE_PRESETS } = require('./pdi/templates/autonxt_controller');

const MIN_LOT_QUANTITY = 1;
const MAX_LOT_QUANTITY = 50; // a technical safety cap, not a real business limit
const BATCHABLE_TEMPLATE_IDS = ['autonxt', 'autonxt_controller'];
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

const BATCH_COLUMNS = 'batch_id, template_id, pdi_no, lot_quantity, status, customer_name, product_id, product_specifications, drawing_no, controller_type';

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function codedError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function invalidQuantityError() {
  return codedError('quantity must be a whole number between 1 and 50', 'INVALID_LOT_QUANTITY');
}

function alreadyFinalizedError() {
  return codedError('This lot is already finalized.', 'BATCH_ALREADY_FINALIZED');
}

// Postgres integer ids top out at 2^31-1; anything that isn't 1-9 plain
// digits is treated as not found rather than reaching the database.
function parseBatchId(batchId) {
  const raw = String(batchId ?? '');
  if (!/^\d{1,9}$/.test(raw)) throw new Error('Batch not found');
  return Number(raw);
}

// Accepts a number, or a string of digits (after trimming). "2.5", "1e1",
// "" and true are all rejected rather than coerced.
function parseLotQuantity(quantity) {
  let qty;
  if (typeof quantity === 'number') qty = quantity;
  else if (typeof quantity === 'string' && /^\d+$/.test(quantity.trim())) qty = Number(quantity.trim());
  else throw invalidQuantityError();
  if (!Number.isInteger(qty) || qty < MIN_LOT_QUANTITY || qty > MAX_LOT_QUANTITY) throw invalidQuantityError();
  return qty;
}

function assertKnownControllerType(templateId, controllerType) {
  if (templateId !== 'autonxt_controller' || !controllerType) return;
  if (!Object.prototype.hasOwnProperty.call(CONTROLLER_TYPE_PRESETS, controllerType)) {
    throw codedError(
      `Unknown controller type "${controllerType}". Choose one of: ${Object.keys(CONTROLLER_TYPE_PRESETS).join(', ')}.`,
      'INVALID_CONTROLLER_TYPE',
    );
  }
}

function emitEach(io, reportIds, status) {
  if (!io?.emit) return;
  for (const reportId of reportIds) io.emit('pdiReportUpdate', { report_id: reportId, status });
}

class PdiReportBatches {
  // Atomic: one pdi_report_batches row + `quantity` linked report rows, in
  // one transaction -- either all of it lands or none of it does. Every
  // linked report is stamped with this batch's shared pdi_no up front and
  // starts 'Pending', same shape createReport already produces for a
  // standalone report.
  static async createBatch({
    template_id, pdi_no, quantity, created_by,
    customer_name, product_id, product_specifications, drawing_no, controller_type,
  }, io) {
    const requestedTemplate = template_id || 'autonxt';
    if (!BATCHABLE_TEMPLATE_IDS.includes(requestedTemplate)) {
      throw codedError(`Lots can only be created for AutoNXT Motor or AutoNXT Controller, not "${requestedTemplate}".`, 'TEMPLATE_NOT_BATCHABLE');
    }
    const qty = parseLotQuantity(quantity);
    const pdiNo = typeof pdi_no === 'string' ? pdi_no.trim() : '';
    if (!pdiNo) throw codedError('pdi_no is required', 'PDI_NO_REQUIRED');

    const rawShared = { customer_name, product_id, product_specifications, drawing_no, controller_type };
    const shared = {};
    for (const f of SHARED_FIELDS) {
      if (typeof rawShared[f] === 'string' && rawShared[f].trim()) shared[f] = rawShared[f].trim();
    }
    assertKnownControllerType(requestedTemplate, shared.controller_type);

    const { templateId, templateVersion } = await PdiReports.resolveTemplateVersion(requestedTemplate);

    const client = await pool.connect();
    let batch;
    const reports = [];
    try {
      await client.query('BEGIN');

      const batchResult = await client.query(`
        INSERT INTO pdi_report_batches
          (template_id, pdi_no, lot_quantity, status, created_by, customer_name, product_id, product_specifications, drawing_no, controller_type)
        VALUES ($1, $2, $3, 'In Progress', $4, $5, $6, $7, $8, $9)
        RETURNING ${BATCH_COLUMNS}
      `, [
        templateId, pdiNo, qty, created_by || null,
        shared.customer_name || null, shared.product_id || null, shared.product_specifications || null,
        shared.drawing_no || null, shared.controller_type || null,
      ]);
      batch = batchResult.rows[0];

      for (let lotIndex = 1; lotIndex <= qty; lotIndex++) {
        const reportResult = await client.query(`
          INSERT INTO pre_dispatch_inspection_reports
            (status, template_id, template_version, data, photos, batch_id, lot_index)
          VALUES ('Pending', $1, $2, $3, '{}'::jsonb, $4, $5)
          RETURNING report_id, lot_index
        `, [templateId, templateVersion, JSON.stringify({ pdi_no: pdiNo, ...shared }), batch.batch_id, lotIndex]);
        reports.push({ report_id: reportResult.rows[0].report_id, lot_index: reportResult.rows[0].lot_index, lot_quantity: qty });
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    emitEach(io, reports.map((r) => r.report_id), 'Pending');
    return { ...batch, reports };
  }

  // Newest first. completed_count is how many member reports are Completed.
  static async listBatches({ template_id = null, limit } = {}) {
    const parsedLimit = Number.parseInt(limit, 10);
    const _limit = Number.isNaN(parsedLimit) ? DEFAULT_LIST_LIMIT : Math.min(Math.max(parsedLimit, 1), MAX_LIST_LIMIT);
    const { rows } = await pool.query(`
      SELECT b.batch_id, b.template_id, b.pdi_no, b.lot_quantity, b.status, b.customer_name, b.created_at,
        (SELECT COUNT(*)::int FROM pre_dispatch_inspection_reports r
          WHERE r.batch_id = b.batch_id AND r.status = 'Completed') AS completed_count
      FROM pdi_report_batches b
      WHERE ($1::text IS NULL OR b.template_id = $1)
      ORDER BY b.created_at DESC, b.batch_id DESC
      LIMIT $2
    `, [template_id || null, _limit]);
    return rows;
  }

  static async getBatch(batchId) {
    const _id = parseBatchId(batchId);

    const batchResult = await pool.query(
      `SELECT ${BATCH_COLUMNS} FROM pdi_report_batches WHERE batch_id = $1`,
      [_id]
    );
    if (batchResult.rows.length === 0) throw new Error('Batch not found');

    const reportsResult = await pool.query(`
      SELECT report_id, lot_index, status,
             data->>'motor_sr_no' AS motor_sr_no, data->>'controller_sr_no' AS controller_sr_no,
             data->>'pdi_no' AS pdi_no
      FROM pre_dispatch_inspection_reports WHERE batch_id = $1
      ORDER BY lot_index ASC
    `, [_id]);

    return { ...batchResult.rows[0], reports: reportsResult.rows };
  }

  // Edits the lot's pdi_no and shared fields, and copies the change into
  // every member's data in the same transaction. A cleared field is NULL on
  // the lot and '' in member data (the forms treat '' as empty).
  static async updateBatch(batchId, body = {}) {
    const _id = parseBatchId(batchId);

    const changes = {};
    for (const f of ['pdi_no', ...SHARED_FIELDS]) {
      if (!Object.prototype.hasOwnProperty.call(body, f)) continue;
      const value = body[f];
      if (value === null) changes[f] = '';
      else if (typeof value === 'string') changes[f] = value.trim();
    }
    if (changes.pdi_no === '') throw codedError("pdi_no can't be empty", 'PDI_NO_REQUIRED');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        'SELECT template_id, status FROM pdi_report_batches WHERE batch_id = $1 FOR UPDATE',
        [_id]
      );
      if (locked.rows.length === 0) throw new Error('Batch not found');
      const { template_id: templateId, status } = locked.rows[0];
      if (status !== 'In Progress') throw alreadyFinalizedError();
      if (changes.controller_type !== undefined) assertKnownControllerType(templateId, changes.controller_type);

      const keys = Object.keys(changes);
      if (keys.length > 0) {
        const sets = keys.map((k, n) => `${k} = $${n + 2}`);
        await client.query(
          `UPDATE pdi_report_batches SET ${sets.join(', ')} WHERE batch_id = $1`,
          [_id, ...keys.map((k) => changes[k] || null)]
        );
        // revision_no moves too, so a form still holding the old values
        // gets a version conflict instead of silently writing them back.
        await client.query(`
          UPDATE pre_dispatch_inspection_reports
          SET data = (CASE WHEN jsonb_typeof(data) = 'object' THEN data ELSE '{}'::jsonb END) || $2::jsonb,
              revision_no = revision_no + 1
          WHERE batch_id = $1
        `, [_id, JSON.stringify(changes)]);
      }

      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* connection may already be dead */ }
      throw error;
    } finally {
      client.release();
    }

    return this.getBatch(_id);
  }

  // Deletes an unfinalized lot and all of its member reports in one
  // transaction (their revisions cascade). Cache and Drive cleanup happen
  // after the connection is released and never fail the delete.
  static async deleteBatch(batchId, io) {
    const _id = parseBatchId(batchId);

    const client = await pool.connect();
    let members;
    let batchDriveFileId;
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        'SELECT status, drive_file_id FROM pdi_report_batches WHERE batch_id = $1 FOR UPDATE',
        [_id]
      );
      if (locked.rows.length === 0) throw new Error('Batch not found');
      if (locked.rows[0].status !== 'In Progress') throw alreadyFinalizedError();
      batchDriveFileId = locked.rows[0].drive_file_id;

      const deleted = await client.query(
        'DELETE FROM pre_dispatch_inspection_reports WHERE batch_id = $1 RETURNING report_id, drive_file_id',
        [_id]
      );
      members = deleted.rows;
      await client.query('DELETE FROM pdi_report_batches WHERE batch_id = $1', [_id]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* connection may already be dead */ }
      throw error;
    } finally {
      client.release();
    }

    const reportIds = members.map((m) => m.report_id);
    await Promise.all([
      ...reportIds.map((id) => pdfCache.remove(id)),
      pdfCache.remove(_id, 'batch'),
    ]);
    const driveFileIds = [...members.map((m) => m.drive_file_id), batchDriveFileId].filter(Boolean);
    for (const fileId of driveFileIds) {
      try { await deleteDriveFile(fileId); }
      catch (e) { logger.warn(`Drive cleanup failed for deleted PDI lot ${_id} (file ${fileId}): ${e.message}`); }
    }

    emitEach(io, reportIds, 'Deleted');
    return { deleted: true, batch_id: _id, report_ids: reportIds };
  }

  // See docs/superpowers/specs/2026-09-29-autonxt-batch-reports-design.md's
  // "Finalize flow" section for why this does NOT call the single-report
  // PdiReports.finalizeReport per linked report (that would render every
  // report twice). The lot is first flipped In Progress -> Finalizing in one
  // guarded UPDATE, which both stops a second finalize and locks member
  // edits (see LOT_OPEN_GUARD in pdiReports.js). Then: validate, render the
  // combined PDF once, and only then mark every report + the lot Completed
  // in one transaction. Any failure after the flip puts the lot back to
  // In Progress, so a bad photo or an OOM never leaves it stuck.
  static async finalizeBatch(batchId, io) {
    const _id = parseBatchId(batchId);

    const flipped = await pool.query(`
      UPDATE pdi_report_batches SET status = 'Finalizing'
      WHERE batch_id = $1 AND status = 'In Progress'
      RETURNING ${BATCH_COLUMNS}
    `, [_id]);
    if (flipped.rows.length === 0) {
      const current = await pool.query('SELECT status FROM pdi_report_batches WHERE batch_id = $1', [_id]);
      if (current.rows.length === 0) throw new Error('Batch not found');
      if (current.rows[0].status === 'Finalizing') {
        throw codedError('This lot is already being finalized.', 'BATCH_FINALIZING');
      }
      throw alreadyFinalizedError();
    }
    const batch = flipped.rows[0];

    let committed = false;
    try {
      // No photos here -- they are loaded one report at a time while rendering.
      const reportsResult = await pool.query(`
        SELECT report_id, lot_index, status, template_id, template_version, data
        FROM pre_dispatch_inspection_reports WHERE batch_id = $1
        ORDER BY lot_index ASC
      `, [_id]);
      const reports = reportsResult.rows;

      if (reports.length === 0 || reports.length !== batch.lot_quantity) {
        throw codedError(
          `Lot ${_id} has ${reports.length} report(s) but expected ${batch.lot_quantity} -- one or more linked reports may have been deleted.`,
          'BATCH_INCOMPLETE',
        );
      }

      // A lot is homogeneous -- createBatch stamps every linked report with
      // the same template_id -- so the serial-number field is decided once.
      // Per-member pdi_no isn't checked: the lot's pdi_no overrides it below.
      const isController = batch.template_id === 'autonxt_controller';
      const srNoField = isController ? 'controller_sr_no' : 'motor_sr_no';
      const missingLots = reports
        .filter((r) => !String(r.data?.[srNoField] ?? '').trim())
        .map((r) => r.lot_index);
      if (missingLots.length > 0) {
        throw codedError(
          `Enter a ${isController ? 'controller' : 'motor'} serial number for lot ${missingLots.join(', ')} before finalizing.`,
          isController ? 'CONTROLLER_SR_NO_REQUIRED' : 'MOTOR_SR_NO_REQUIRED',
          { lots: missingLots },
        );
      }

      // batch.pdi_no and any set shared field are authoritative over
      // whatever an individual report's own drifted data holds.
      const overrides = pickSharedFields(batch);
      const pdfBuffer = await bufferPdf(await PDIGenerator.generateCombined(
        reports.map((r) => ({
          templateId: r.template_id,
          templateVersion: r.template_version,
          data: { ...(r.data || {}), pdi_no: batch.pdi_no, ...overrides },
          loadPhotos: () => this.#loadPhotos(r.report_id),
        }))
      ));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // A row already Completed (a legacy member finalized on its own
        // before single-report finalize refused lot members) is skipped by
        // the WHERE clause -- it's already in the desired end state.
        await client.query(`
          UPDATE pre_dispatch_inspection_reports
          SET status = 'Completed'
          WHERE batch_id = $1 AND status <> 'Completed'
        `, [_id]);

        const updateBatchResult = await client.query(`
          UPDATE pdi_report_batches
          SET status = 'Completed'
          WHERE batch_id = $1 AND status = 'Finalizing'
        `, [_id]);
        if (updateBatchResult.rowCount !== 1) throw alreadyFinalizedError();

        await client.query('COMMIT');
        committed = true;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* connection may already be dead */ }
        throw error;
      } finally {
        client.release();
      }

      const reportIds = reports.map((r) => r.report_id);
      // A member's single-report PDF from before it joined the finalized
      // lot no longer has the lot's authoritative fields.
      await Promise.all(reportIds.map((id) => pdfCache.remove(id)));
      emitEach(io, reportIds, 'Completed');

      const payload = { ...batch, status: 'Completed', reports: reports.map((r) => ({ report_id: r.report_id, lot_index: r.lot_index })) };

      const background = Promise.all([
        this.#backupPdfToDrive(_id, batch.pdi_no, pdfBuffer),
        pdfCache.write(_id, pdfBuffer, 'batch'),
      ]);

      return { payload, pdfBuffer, background };
    } finally {
      if (!committed) {
        await pool.query(
          `UPDATE pdi_report_batches SET status = 'In Progress' WHERE batch_id = $1 AND status = 'Finalizing'`,
          [_id]
        ).catch((e) => logger.error(`Failed to revert PDI lot ${_id} from Finalizing: ${e.message}`));
      }
    }
  }

  static async #loadPhotos(reportId) {
    const { rows } = await pool.query('SELECT photos FROM pre_dispatch_inspection_reports WHERE report_id = $1', [reportId]);
    return rows[0]?.photos || {};
  }

  static async #backupPdfToDrive(batchId, pdiNo, pdfBuffer) {
    const startedAt = Date.now();
    try {
      const safeNo = String(pdiNo || batchId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const uploaded = await uploadBufferToDrivePrivate(pdfBuffer, 'application/pdf', `PDI_BATCH_${safeNo}.pdf`);
      const res = await pool.query('UPDATE pdi_report_batches SET drive_file_id = $1 WHERE batch_id = $2', [uploaded.id, batchId]);
      if (res.rowCount === 0) {
        await deleteDriveFile(uploaded.id).catch((e) => logger.warn(`Drive cleanup failed for deleted PDI batch ${batchId}: ${e.message}`));
        return;
      }
      logger.info(`PDI batch Drive backup: batch ${batchId}, ${Date.now() - startedAt}ms, ${pdfBuffer.length} bytes`);
    } catch (e) {
      logger.warn(`Drive backup failed for PDI batch ${batchId}: ${e.message}`);
    }
  }

  static async getBatchPdfForDownload(batchId) {
    const _id = parseBatchId(batchId);

    const meta = await pool.query(
      `SELECT status, pdi_no, customer_name, product_id, product_specifications, drawing_no, controller_type FROM pdi_report_batches WHERE batch_id = $1`,
      [_id]
    );
    if (meta.rows.length === 0) throw new Error('Batch not found');
    const pdiNo = meta.rows[0].pdi_no;

    if (meta.rows[0].status !== 'Completed') {
      throw codedError('This lot has not been finalized yet.', 'BATCH_NOT_READY');
    }

    const cached = await pdfCache.read(_id, 'batch');
    if (cached) return { buffer: cached, source: 'cache', pdiNo };

    // Cache miss on a Completed batch (e.g. after a redeploy emptied the disk
    // cache) -- re-render the combined PDF from each report's stored data,
    // same fallback shape PdiReports.getPdfForDownload already has for a
    // single report. Same shared-field override and per-report photo
    // loading as finalizeBatch.
    const overrides = pickSharedFields(meta.rows[0]);
    const reportsResult = await pool.query(`
      SELECT report_id, lot_index, template_id, template_version, data
      FROM pre_dispatch_inspection_reports WHERE batch_id = $1
      ORDER BY lot_index ASC
    `, [_id]);
    const buffer = await bufferPdf(await PDIGenerator.generateCombined(
      reportsResult.rows.map((r) => ({
        templateId: r.template_id,
        templateVersion: r.template_version,
        data: { ...(r.data || {}), pdi_no: pdiNo, ...overrides },
        loadPhotos: () => this.#loadPhotos(r.report_id),
      }))
    ));
    await pdfCache.write(_id, buffer, 'batch');
    return { buffer, source: 'rendered', pdiNo };
  }
}

module.exports = PdiReportBatches;
