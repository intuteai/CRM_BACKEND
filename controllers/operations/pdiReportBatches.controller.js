const PdiReportBatches = require('../../models/operations/pdiReportBatches');
const redis = require('../../config/redis');
const logger = require('../../utils/logger');

// Same helper as controllers/operations/pdiReports.controller.js (duplicated,
// not shared, matching this codebase's convention for small cross-controller
// helpers) -- the legacy pdi.controller.js dashboard reads the same pdi_list_*/
// pdi_report_* Redis keys, and createBatch/finalizeBatch insert into and update
// the same pre_dispatch_inspection_reports table those keys cache, so they need
// the same invalidation the single-report controller already does.
async function invalidateCache() {
  if (!redis.isReady) return;
  try {
    const keys = await redis.keys('pdi_*');
    if (keys.length > 0) await redis.del(keys);
  } catch (err) {
    logger.warn(`PDI report cache invalidation failed: ${err.message}`);
  }
}

// Every lot error goes out as { error, code } (plus `lots` for a missing
// serial number), so a client can show `error` as-is.
const ERROR_STATUS = {
  INVALID_LOT_QUANTITY: 400,
  PDI_NO_REQUIRED: 400,
  TEMPLATE_NOT_BATCHABLE: 400,
  INVALID_CONTROLLER_TYPE: 400,
  MOTOR_SR_NO_REQUIRED: 400,
  CONTROLLER_SR_NO_REQUIRED: 400,
  BATCH_ALREADY_FINALIZED: 409,
  BATCH_FINALIZING: 409,
  BATCH_INCOMPLETE: 409,
  BATCH_NOT_READY: 409,
};

// true when the error was a known one and a response has been sent.
function sendKnownError(res, error) {
  if (error.message === 'Batch not found') {
    res.status(404).json({ error: error.message, code: 'BATCH_NOT_FOUND' });
    return true;
  }
  if (error.message && error.message.startsWith('Unknown PDI template')) {
    res.status(400).json({ error: error.message, code: 'UNKNOWN_TEMPLATE' });
    return true;
  }
  const status = ERROR_STATUS[error.code];
  if (!status) return false;
  const body = { error: error.message, code: error.code };
  if (Array.isArray(error.lots)) body.lots = error.lots;
  res.status(status).json(body);
  return true;
}

function sendInternalError(res) {
  res.status(500).json({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' });
}

const safeFileName = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '_');

exports.listBatches = async (req, res) => {
  try {
    const { template_id, limit } = req.query;
    res.json(await PdiReportBatches.listBatches({ template_id, limit }));
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error listing PDI report batches: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};

exports.createBatch = async (req, res) => {
  try {
    const {
      template_id, pdi_no, quantity,
      customer_name, product_id, product_specifications, drawing_no, controller_type,
    } = req.body || {};
    const batch = await PdiReportBatches.createBatch({
      template_id, pdi_no, quantity, created_by: req.user.user_id,
      customer_name, product_id, product_specifications, drawing_no, controller_type,
    }, req.io);
    await invalidateCache();
    logger.info(`PDI report batch created: ${batch.batch_id} (${batch.lot_quantity} reports) by ${req.user.user_id}`);
    res.status(201).json(batch);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error creating PDI report batch: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};

exports.getBatch = async (req, res) => {
  try {
    const batch = await PdiReportBatches.getBatch(req.params.batchId);
    res.json(batch);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error fetching PDI report batch ${req.params.batchId}: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};

exports.updateBatch = async (req, res) => {
  try {
    const batch = await PdiReportBatches.updateBatch(req.params.batchId, req.body || {});
    await invalidateCache();
    logger.info(`PDI report batch updated: ${batch.batch_id} by ${req.user.user_id}`);
    res.json(batch);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error updating PDI report batch ${req.params.batchId}: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};

exports.deleteBatch = async (req, res) => {
  try {
    const result = await PdiReportBatches.deleteBatch(req.params.batchId, req.io);
    await invalidateCache();
    logger.info(`PDI report batch deleted: ${result.batch_id} (${result.report_ids.length} reports) by ${req.user.user_id}`);
    res.json(result);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error deleting PDI report batch ${req.params.batchId}: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};

exports.finalizeBatch = async (req, res) => {
  try {
    // The model flips the lot to Finalizing, renders the combined PDF, then
    // commits every linked report's and the lot's status change in one
    // transaction -- see pdiReportBatches.js's finalizeBatch comment.
    // `background` (Drive backup + disk-cache write) is deliberately left
    // unawaited here, same fire-and-forget pattern as finalizeReport.
    const { payload, pdfBuffer } = await PdiReportBatches.finalizeBatch(req.params.batchId, req.io);
    await invalidateCache();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_BATCH_${safeFileName(payload.pdi_no || payload.batch_id)}.pdf"`);
    logger.info(`PDI report batch finalized: ${payload.batch_id} (${payload.reports.length} reports) by ${req.user.user_id}, pdfBytes ${pdfBuffer.length}`);
    res.send(pdfBuffer);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error finalizing PDI report batch ${req.params.batchId}: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};

exports.downloadBatchPdf = async (req, res) => {
  try {
    // `source` ('cache' or 'rendered') is the same cache-hit-vs-rebuilt signal
    // the single-report downloadPdf logs via logPdfTiming -- worth logging
    // here too, since a batch re-render can mean rendering up to 50 reports.
    const { buffer, source, pdiNo } = await PdiReportBatches.getBatchPdfForDownload(req.params.batchId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_BATCH_${safeFileName(pdiNo || req.params.batchId)}.pdf"`);
    logger.info(`PDI batch pdf (${source}): batch ${req.params.batchId}, pdfBytes ${buffer.length}, requestId ${req.get('x-request-id') || '-'}`);
    res.send(buffer);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error generating PDI batch PDF ${req.params.batchId}: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};
