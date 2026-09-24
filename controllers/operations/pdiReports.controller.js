const PdiReports = require('../../models/operations/pdiReports');
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

// One line per finalize / PDF request so a slow phone can be matched to what
// the server actually spent: how long the report took to load, the photo
// downscale, the whole render, and the size of the PDF that went out.
// X-Request-ID is whatever the proxy forwarded (nginx sets one), when present.
function logPdfTiming(kind, req, reportId, t = {}, totalMs) {
  const mb = (bytes) => (bytes / 1048576).toFixed(1);
  const optimize = t.optimize && t.optimize.photos
    ? ` (downscale ${t.optimize.ms}ms: ${t.optimize.photos} photos, ${mb(t.optimize.bytesBefore)}MB -> ${mb(t.optimize.bytesAfter)}MB)`
    : '';
  const parts = [
    t.photos !== undefined ? `photos ${t.photos}` : null,
    t.loadMs !== undefined ? `loadMs ${t.loadMs}` : null,
    t.renderMs !== undefined ? `renderMs ${t.renderMs}${optimize}` : null,
    t.updateMs !== undefined ? `updateMs ${t.updateMs}` : null,
    t.pdfBytes !== undefined ? `pdfBytes ${t.pdfBytes}` : null,
  ].filter(Boolean).join(', ');
  logger.info(`PDI ${kind} timing: report ${reportId}, ${parts ? `${parts}, ` : ''}totalMs ${totalMs}, requestId ${req.get('x-request-id') || '-'}`);
}

exports.createReport = async (req, res) => {
  try {
    const { customer_id, order_id, inspected_by, inspection_date, data, photos, template_id } = req.body || {};
    const report = await PdiReports.createReport({
      customer_id, order_id, inspected_by: inspected_by || req.user.name, inspection_date, data, photos, template_id,
    }, req.io);

    await invalidateCache();

    logger.info(`PDI report draft created: ${report.report_id} by ${req.user.user_id}`);
    res.status(201).json(report);
  } catch (error) {
    if (error.message.startsWith('Unknown PDI template')) return res.status(400).json({ error: error.message });
    if (error.code === 'INVALID_INSPECTION_DATE') return res.status(400).json({ error: error.message, code: error.code });
    logger.error(`Error creating PDI report: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.duplicateReport = async (req, res) => {
  try {
    const report = await PdiReports.duplicateReport(req.params.id, req.user.name, req.io);
    await invalidateCache();
    logger.info(`PDI report duplicated: ${req.params.id} -> ${report.report_id} by ${req.user.user_id}`);
    res.status(201).json(report);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error duplicating PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// `?photos=summary` -- answer with [{ id, label, image_count }] instead of every
// photo's Base64 (opt-in; app 1.0.8 and older still get the full report).
const wantsPhotosSummary = (req) => req.query.photos === 'summary';

exports.getReport = async (req, res) => {
  try {
    const report = await PdiReports.getById(req.params.id, { photosSummary: wantsPhotosSummary(req) });
    res.json(report);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error fetching PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.patchReport = async (req, res) => {
  // Saves carry the whole report including base64 photos, so size and duration
  // are the first things needed to diagnose a failed or slow save.
  const started = Date.now();
  const bytes = req.headers['content-length'] || 'unknown';
  try {
    const report = await PdiReports.patchReport(req.params.id, req.body || {}, req.io, { photosSummary: wantsPhotosSummary(req) });
    await invalidateCache();
    const ms = Date.now() - started;
    if (ms > 5000) logger.warn(`Slow PDI report save: report ${req.params.id}, ${ms}ms, ${bytes} bytes`);
    res.json(report);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    if (error.code === 'REPORT_LOCKED') return res.status(409).json({ error: error.message, code: error.code });
    if (error.code === 'INVALID_INSPECTION_DATE') return res.status(400).json({ error: error.message, code: error.code });
    logger.error(`Error updating PDI report ${req.params.id} (${Date.now() - started}ms, ${bytes} bytes): ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.finalizeReport = async (req, res) => {
  const started = Date.now();
  try {
    // The pdi_no check lives inside finalizeReport (which loads the report
    // anyway). Checking it here first meant loading the whole report -- every
    // photo -- twice per finalize.
    const { payload, pdfBuffer, timings } = await PdiReports.finalizeReport(req.params.id, req.io);
    await invalidateCache();
    logPdfTiming('finalize', req, payload.report_id, timings, Date.now() - started);

    const safeName = String(payload.data?.pdi_no || payload.report_id).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_${safeName}.pdf"`);
    logger.info(`PDI report finalized: ${payload.report_id} by ${req.user.user_id}`);
    res.send(pdfBuffer);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    if (error.code === 'PDI_NO_REQUIRED') return res.status(400).json({ error: error.message });
    if (error.code === 'REPORT_LOCKED') return res.status(409).json({ error: error.message, code: error.code });
    logger.error(`Error finalizing PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.listReports = async (req, res) => {
  try {
    const { limit = 10, cursor, offset, status, template_id, search, sortBy, sortDir } = req.query;
    const result = await PdiReports.listReports({ limit, cursor, offset, status, template_id, search, sortBy, sortDir });
    res.json(result);
  } catch (error) {
    logger.error(`Error listing PDI reports: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.downloadPdf = async (req, res) => {
  const started = Date.now();
  try {
    const { buffer, pdiNo, source, timings } = await PdiReports.getPdfForDownload(req.params.id);
    logPdfTiming(`pdf (${source})`, req, req.params.id, timings, Date.now() - started);

    const safeName = String(pdiNo).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_${safeName}.pdf"`);
    res.send(buffer);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    if (error.code === 'PDI_NO_REQUIRED') return res.status(400).json({ error: error.message });
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
