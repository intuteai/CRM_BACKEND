const PdiReportBatches = require('../../models/operations/pdiReportBatches');
const logger = require('../../utils/logger');

exports.createBatch = async (req, res) => {
  try {
    const { template_id, pdi_no, quantity } = req.body || {};
    const batch = await PdiReportBatches.createBatch({ template_id, pdi_no, quantity, created_by: req.user.user_id });
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
    const { payload, pdfBuffer } = await PdiReportBatches.finalizeBatch(req.params.batchId);
    const safeName = String(payload.pdi_no || payload.batch_id).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_BATCH_${safeName}.pdf"`);
    logger.info(`PDI report batch finalized: ${payload.batch_id} by ${req.user.user_id}`);
    res.send(pdfBuffer);
  } catch (error) {
    if (error.message === 'Batch not found') return res.status(404).json({ error: error.message });
    if (error.code === 'PDI_NO_REQUIRED') return res.status(400).json({ error: error.message, code: error.code });
    if (error.code === 'BATCH_ALREADY_FINALIZED') return res.status(409).json({ error: error.message, code: error.code });
    if (error.code === 'BATCH_INCOMPLETE') return res.status(409).json({ error: error.message, code: error.code });
    if (error.code === 'BATCH_REPORT_CONFLICT') return res.status(409).json({ error: error.message, code: error.code });
    logger.error(`Error finalizing PDI report batch ${req.params.batchId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.downloadBatchPdf = async (req, res) => {
  try {
    const { buffer } = await PdiReportBatches.getBatchPdfForDownload(req.params.batchId);
    const safeName = String(req.params.batchId).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_BATCH_${safeName}.pdf"`);
    res.send(buffer);
  } catch (error) {
    if (error.message === 'Batch not found') return res.status(404).json({ error: error.message });
    if (error.code === 'BATCH_NOT_READY') return res.status(409).json({ error: error.message, code: error.code });
    logger.error(`Error generating PDI batch PDF ${req.params.batchId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
