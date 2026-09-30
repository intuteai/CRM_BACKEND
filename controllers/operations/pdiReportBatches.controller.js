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

exports.createBatch = async (req, res) => {
  try {
    const { template_id, pdi_no, quantity } = req.body || {};
    const batch = await PdiReportBatches.createBatch({ template_id, pdi_no, quantity, created_by: req.user.user_id });
    await invalidateCache();
    logger.info(`PDI report batch created: ${batch.batch_id} (${batch.lot_quantity} reports) by ${req.user.user_id}`);
    res.status(201).json(batch);
  } catch (error) {
    if (error.code === 'INVALID_LOT_QUANTITY') return res.status(400).json({ error: error.message, code: error.code });
    if (error.code === 'PDI_NO_REQUIRED') return res.status(400).json({ error: error.message, code: error.code });
    if (error.message && error.message.startsWith('Unknown PDI template')) return res.status(400).json({ error: error.message });
    logger.error(`Error creating PDI report batch: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getBatch = async (req, res) => {
  try {
    const batch = await PdiReportBatches.getBatch(req.params.batchId);
    res.json(batch);
  } catch (error) {
    if (error.message === 'Batch not found') return res.status(404).json({ error: error.message });
    logger.error(`Error fetching PDI report batch ${req.params.batchId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.finalizeBatch = async (req, res) => {
  try {
    // The model renders the combined PDF before marking anything Completed
    // (so a render failure never leaves a report stuck locked -- see
    // pdiReportBatches.js's finalizeBatch comment), then commits every linked
    // report's and the batch's status change in one transaction. `background`
    // (Drive backup + disk-cache write) is deliberately left unawaited here,
    // same fire-and-forget pattern as the single-report finalizeReport.
    const { payload, pdfBuffer } = await PdiReportBatches.finalizeBatch(req.params.batchId);
    await invalidateCache();
    const safeName = String(payload.pdi_no || payload.batch_id).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_BATCH_${safeName}.pdf"`);
    logger.info(`PDI report batch finalized: ${payload.batch_id} (${payload.reports.length} reports) by ${req.user.user_id}, pdfBytes ${pdfBuffer.length}`);
    res.send(pdfBuffer);
  } catch (error) {
    if (error.message === 'Batch not found') return res.status(404).json({ error: error.message });
    if (error.code === 'PDI_NO_REQUIRED') return res.status(400).json({ error: error.message, code: error.code });
    if (error.code === 'BATCH_ALREADY_FINALIZED') return res.status(409).json({ error: error.message, code: error.code });
    if (error.code === 'BATCH_INCOMPLETE') return res.status(409).json({ error: error.message, code: error.code });
    logger.error(`Error finalizing PDI report batch ${req.params.batchId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.downloadBatchPdf = async (req, res) => {
  try {
    // `source` ('cache' or 'rendered') is the same cache-hit-vs-rebuilt signal
    // the single-report downloadPdf logs via logPdfTiming -- worth logging
    // here too, since a batch re-render can mean rendering up to 50 reports.
    const { buffer, source } = await PdiReportBatches.getBatchPdfForDownload(req.params.batchId);
    const safeName = String(req.params.batchId).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_BATCH_${safeName}.pdf"`);
    logger.info(`PDI batch pdf (${source}): batch ${req.params.batchId}, pdfBytes ${buffer.length}, requestId ${req.get('x-request-id') || '-'}`);
    res.send(buffer);
  } catch (error) {
    if (error.message === 'Batch not found') return res.status(404).json({ error: error.message });
    if (error.code === 'BATCH_NOT_READY') return res.status(409).json({ error: error.message, code: error.code });
    logger.error(`Error generating PDI batch PDF ${req.params.batchId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
