const PdiReports = require('../../models/operations/pdiReports');
const templates = require('../../models/operations/pdi/templates');
const AuthoredTemplates = require('../../models/operations/pdi/authoredTemplates');
const redis = require('../../config/redis');
const logger = require('../../utils/logger');

// Shared with the legacy pdi.controller.js cache keys (pdi_list_*, pdi_report_*)
// so a report created/changed here doesn't leave the legacy dashboard's cache stale.
// Best-effort: skip when the client isn't connected (node-redis v4 queues commands
// indefinitely while offline rather than rejecting, so a downed redis would otherwise
// hang the request forever) and never let a cache failure fail report creation.
async function invalidateCache() {
  if (!redis.isReady) return;
  try {
    const keys = await redis.keys('pdi_*');
    if (keys.length > 0) await redis.del(keys);
  } catch (err) {
    logger.warn(`PDI report cache invalidation failed: ${err.message}`);
  }
}

exports.createReport = async (req, res) => {
  try {
    const { customer_id, order_id, inspected_by, inspection_date, data, photos, template_id } = req.body || {};
    const resolvedTemplateId = template_id || 'general';
    let templateVersion = null;
    if (!templates[resolvedTemplateId]) {
      const active = await AuthoredTemplates.getActive(resolvedTemplateId);
      if (!active) return res.status(400).json({ error: `Unknown PDI template: ${resolvedTemplateId}` });
      templateVersion = active.version;
    }
    const report = await PdiReports.createReport({
      customer_id, order_id, inspected_by: inspected_by || req.user.name, inspection_date, data, photos,
      template_id: resolvedTemplateId, template_version: templateVersion,
    }, req.io);

    await invalidateCache();

    logger.info(`PDI report draft created: ${report.report_id} by ${req.user.user_id}`);
    res.status(201).json(report);
  } catch (error) {
    logger.error(`Error creating PDI report: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getReport = async (req, res) => {
  try {
    const report = await PdiReports.getById(req.params.id);
    res.json(report);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error fetching PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.patchReport = async (req, res) => {
  try {
    const report = await PdiReports.patchReport(req.params.id, req.body || {}, req.io);
    await invalidateCache();
    res.json(report);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error updating PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.finalizeReport = async (req, res) => {
  try {
    const existing = await PdiReports.getById(req.params.id);
    if (!existing.data?.pdi_no) return res.status(400).json({ error: 'pdi_no required before finalizing' });

    const { payload, pdfBuffer } = await PdiReports.finalizeReport(req.params.id, req.io);
    await invalidateCache();

    const safeName = String(payload.data?.pdi_no || payload.report_id).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_${safeName}.pdf"`);
    logger.info(`PDI report finalized: ${payload.report_id} by ${req.user.user_id}`);
    res.send(pdfBuffer);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error finalizing PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.listReports = async (req, res) => {
  try {
    const { limit = 10, cursor, status } = req.query;
    const result = await PdiReports.listReports({ limit, cursor, status });
    res.json(result);
  } catch (error) {
    logger.error(`Error listing PDI reports: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.downloadPdf = async (req, res) => {
  try {
    const report = await PdiReports.getById(req.params.id);
    if (!report.data?.pdi_no) return res.status(400).json({ error: 'pdi_no required to generate a PDF' });

    const pdfBuffer = await PdiReports.getPdfBuffer(req.params.id);
    const safeName = String(report.data.pdi_no).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_${safeName}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error generating PDI PDF ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.deleteReport = async (req, res) => {
  try {
    const result = await PdiReports.deleteReport(req.params.id, req.io);
    await invalidateCache();
    res.json(result);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error deleting PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
