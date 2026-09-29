'use strict';

const pool = require('../../config/db');
const logger = require('../../utils/logger');
const PDIGenerator = require('./pdi_generator');
const PdiReports = require('./pdiReports');
const { uploadBufferToDrivePrivate, deleteDriveFile } = require('../../services/googleDrive');
const pdfCache = require('./pdi/pdfCache');

const MIN_LOT_QUANTITY = 1;
const MAX_LOT_QUANTITY = 50; // a technical safety cap, not a real business limit

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function invalidQuantityError() {
  const err = new Error('quantity must be a whole number between 1 and 50');
  err.code = 'INVALID_LOT_QUANTITY';
  return err;
}

class PdiReportBatches {
  // Atomic: one pdi_report_batches row + `quantity` linked report rows, in
  // one transaction -- either all of it lands or none of it does. Every
  // linked report is stamped with this batch's shared pdi_no up front (so
  // finalize's per-report pdi_no check is trivially satisfied later) and
  // starts 'Pending', same shape createReport already produces for a
  // standalone report.
  static async createBatch({ template_id, pdi_no, quantity, created_by }) {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < MIN_LOT_QUANTITY || qty > MAX_LOT_QUANTITY) {
      throw invalidQuantityError();
    }
    if (!pdi_no) {
      const err = new Error('pdi_no is required');
      err.code = 'PDI_NO_REQUIRED';
      throw err;
    }
    const { templateId, templateVersion } = await PdiReports.resolveTemplateVersion(template_id || 'autonxt');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const batchResult = await client.query(`
        INSERT INTO pdi_report_batches (template_id, pdi_no, lot_quantity, status, created_by)
        VALUES ($1, $2, $3, 'In Progress', $4)
        RETURNING batch_id, template_id, pdi_no, lot_quantity, status
      `, [templateId, pdi_no, qty, created_by || null]);
      const batch = batchResult.rows[0];

      const reports = [];
      for (let lotIndex = 1; lotIndex <= qty; lotIndex++) {
        const reportResult = await client.query(`
          INSERT INTO pre_dispatch_inspection_reports
            (status, template_id, template_version, data, photos, batch_id, lot_index)
          VALUES ('Pending', $1, $2, $3, '{}'::jsonb, $4, $5)
          RETURNING report_id, lot_index
        `, [templateId, templateVersion, JSON.stringify({ pdi_no }), batch.batch_id, lotIndex]);
        reports.push({ report_id: reportResult.rows[0].report_id, lot_index: reportResult.rows[0].lot_index, lot_quantity: qty });
      }

      await client.query('COMMIT');
      return { ...batch, reports };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getBatch(batchId) {
    const _id = Number(batchId);
    if (!Number.isFinite(_id)) throw new Error('Batch not found');

    const batchResult = await pool.query(
      `SELECT batch_id, template_id, pdi_no, lot_quantity, status FROM pdi_report_batches WHERE batch_id = $1`,
      [_id]
    );
    if (batchResult.rows.length === 0) throw new Error('Batch not found');

    const reportsResult = await pool.query(`
      SELECT report_id, lot_index, status, data->>'motor_sr_no' AS motor_sr_no, data->>'pdi_no' AS pdi_no
      FROM pre_dispatch_inspection_reports WHERE batch_id = $1
      ORDER BY lot_index ASC
    `, [_id]);

    return { ...batchResult.rows[0], reports: reportsResult.rows };
  }

  // See docs/superpowers/specs/2026-09-29-autonxt-batch-reports-design.md's
  // "Finalize flow" section for why this does NOT call the single-report
  // PdiReports.finalizeReport per linked report (that would render every
  // report twice -- once inside finalizeReport, once again to build the
  // combined PDF). Instead: validate everything, render the combined PDF
  // ONCE, and only THEN mark every report + the batch Completed together in
  // one transaction -- mirroring pdiReports.js's finalizeReport, which
  // renders first and only marks Completed after a successful render, so a
  // render failure (bad photo, unknown template, OOM on a big lot) never
  // leaves reports locked in a bad state with no clean recovery.
  static async finalizeBatch(batchId) {
    const _id = Number(batchId);
    if (!Number.isFinite(_id)) throw new Error('Batch not found');

    const batchResult = await pool.query(
      `SELECT batch_id, template_id, pdi_no, lot_quantity, status FROM pdi_report_batches WHERE batch_id = $1`,
      [_id]
    );
    if (batchResult.rows.length === 0) throw new Error('Batch not found');
    const batch = batchResult.rows[0];

    if (batch.status === 'Completed') {
      const err = new Error('This batch is already finalized.');
      err.code = 'BATCH_ALREADY_FINALIZED';
      throw err;
    }

    const reportsResult = await pool.query(`
      SELECT report_id, lot_index, status, template_id, template_version, data, photos
      FROM pre_dispatch_inspection_reports WHERE batch_id = $1
      ORDER BY lot_index ASC
    `, [_id]);
    const reports = reportsResult.rows;

    if (reports.length === 0 || reports.length !== batch.lot_quantity) {
      const err = new Error(`Batch ${_id} has ${reports.length} report(s) but expected ${batch.lot_quantity} -- one or more linked reports may have been deleted.`);
      err.code = 'BATCH_INCOMPLETE';
      throw err;
    }

    for (const report of reports) {
      if (!report.data?.pdi_no) {
        const err = new Error(`Report ${report.report_id} (lot ${report.lot_index}) is missing pdi_no.`);
        err.code = 'PDI_NO_REQUIRED';
        throw err;
      }
    }

    // Render before any status change -- a render failure must leave every
    // report and the batch exactly as they were, not locked Completed.
    const pdfBuffer = await bufferPdf(await PDIGenerator.generateCombined(
      reports.map((r) => ({
        templateId: r.template_id,
        templateVersion: r.template_version,
        data: { ...(r.data || {}), photos: r.photos || {} },
      }))
    ));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const reportIds = reports.map((r) => r.report_id);
      const updateReportsResult = await client.query(`
        UPDATE pre_dispatch_inspection_reports
        SET status = 'Completed'
        WHERE batch_id = $1 AND status <> 'Completed'
        RETURNING report_id
      `, [_id]);
      if (updateReportsResult.rows.length !== reportIds.length) {
        await client.query('ROLLBACK');
        const err = new Error(`Batch ${_id}: one or more linked reports were already finalized outside this batch (expected ${reportIds.length}, updated ${updateReportsResult.rows.length}).`);
        err.code = 'BATCH_REPORT_CONFLICT';
        throw err;
      }

      const updateBatchResult = await client.query(`
        UPDATE pdi_report_batches
        SET status = 'Completed'
        WHERE batch_id = $1 AND status <> 'Completed'
      `, [_id]);
      if (updateBatchResult.rowCount !== 1) {
        await client.query('ROLLBACK');
        const err = new Error('This batch is already finalized.');
        err.code = 'BATCH_ALREADY_FINALIZED';
        throw err;
      }

      await client.query('COMMIT');
    } catch (error) {
      if (!error.code) { try { await client.query('ROLLBACK'); } catch { /* connection may already be dead */ } }
      throw error;
    } finally {
      client.release();
    }

    const payload = { ...batch, status: 'Completed', reports: reports.map((r) => ({ report_id: r.report_id, lot_index: r.lot_index })) };

    const background = Promise.all([
      this.#backupPdfToDrive(_id, batch.pdi_no, pdfBuffer),
      pdfCache.write(_id, pdfBuffer, 'batch'),
    ]);

    return { payload, pdfBuffer, background };
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
    const _id = Number(batchId);
    if (!Number.isFinite(_id)) throw new Error('Batch not found');

    const meta = await pool.query(`SELECT status FROM pdi_report_batches WHERE batch_id = $1`, [_id]);
    if (meta.rows.length === 0) throw new Error('Batch not found');

    if (meta.rows[0].status !== 'Completed') {
      const err = new Error('This batch has not been finalized yet.');
      err.code = 'BATCH_NOT_READY';
      throw err;
    }

    const cached = await pdfCache.read(_id, 'batch');
    if (cached) return { buffer: cached, source: 'cache' };

    // Cache miss on a Completed batch (e.g. after a redeploy emptied the disk
    // cache) -- re-render the combined PDF from each report's stored data,
    // same fallback shape PdiReports.getPdfForDownload already has for a
    // single report.
    const reportsResult = await pool.query(`
      SELECT report_id, lot_index, template_id, template_version, data, photos
      FROM pre_dispatch_inspection_reports WHERE batch_id = $1
      ORDER BY lot_index ASC
    `, [_id]);
    const buffer = await bufferPdf(await PDIGenerator.generateCombined(
      reportsResult.rows.map((r) => ({
        templateId: r.template_id,
        templateVersion: r.template_version,
        data: { ...(r.data || {}), photos: r.photos || {} },
      }))
    ));
    await pdfCache.write(_id, buffer, 'batch');
    return { buffer, source: 'rendered' };
  }
}

module.exports = PdiReportBatches;
