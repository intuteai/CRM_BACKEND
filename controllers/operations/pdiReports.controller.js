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

// Every PDI error goes out as { error, code } so a client can show `error`
// as-is and branch on `code`.
const ERROR_STATUS = {
  INVALID_STATUS: 400,
  INVALID_INSPECTION_DATE: 400,
  INVALID_DATA_PAYLOAD: 400,
  PDI_NO_REQUIRED: 400,
  FINALIZED_REPORT_FORBIDDEN: 403,
  INVALID_PHOTO_REF: 400,
  INVALID_PHOTO_UPLOAD_STEP: 400,
  PHOTO_REF_NOT_FOUND: 409,
  REPORT_LOCKED: 409,
  REPORT_VERSION_CONFLICT: 409,
  BATCH_MEMBER_LOCKED: 409,
  BATCH_MEMBER_USE_LOT: 409,
};

// true when the error was a known one and a response has been sent.
function sendKnownError(res, error) {
  if (error.message === 'Report not found') {
    res.status(404).json({ error: error.message, code: 'REPORT_NOT_FOUND' });
    return true;
  }
  if (error.message && error.message.startsWith('Unknown PDI template')) {
    res.status(400).json({ error: error.message, code: 'UNKNOWN_TEMPLATE' });
    return true;
  }
  const status = ERROR_STATUS[error.code];
  if (!status) return false;
  res.status(status).json({ error: error.message, code: error.code });
  return true;
}

function sendInternalError(res) {
  res.status(500).json({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' });
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
    }, req.io, { photoHashes: wantsPhotoHashes(req) });

    await invalidateCache();

    logger.info(`PDI report draft created: ${report.report_id} by ${req.user.user_id}`);
    res.status(201).json(report);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error creating PDI report: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};

exports.duplicateReport = async (req, res) => {
  try {
    const report = await PdiReports.duplicateReport(req.params.id, req.user.name, req.io);
    await invalidateCache();
    logger.info(`PDI report duplicated: ${req.params.id} -> ${report.report_id} by ${req.user.user_id}`);
    res.status(201).json(report);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error duplicating PDI report ${req.params.id}: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};

// `?photos=summary` -- answer with [{ id, label, image_count }] instead of every
// photo's Base64 (opt-in; app 1.0.8 and older still get the full report).
const wantsPhotosSummary = (req) => req.query.photos === 'summary';
// `?hashes=1` -- add `photo_hashes` to the response, so the client can send
// 'ref:sha256:<hash>' instead of re-uploading a stored photo (pdi/photoRefs.js).
const wantsPhotoHashes = (req) => req.query.hashes === '1';

exports.getReport = async (req, res) => {
  try {
    const report = await PdiReports.getById(req.params.id, { photosSummary: wantsPhotosSummary(req), photoHashes: wantsPhotoHashes(req) });
    res.json(report);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error fetching PDI report ${req.params.id}: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};

exports.patchReport = async (req, res) => {
  // Saves carry the whole report including base64 photos, so size and duration
  // are the first things needed to diagnose a failed or slow save.
  const started = Date.now();
  const bytes = req.headers['content-length'] || 'unknown';
  try {
    const report = await PdiReports.patchReport(req.params.id, req.body || {}, req.io, {
      photosSummary: wantsPhotosSummary(req),
      photoHashes: wantsPhotoHashes(req),
      // Only meaningful when editing an already-Completed report. role_id
      // drives the permission check; edited_by (a different id space --
      // the actual user, not their role) is who the audit snapshot
      // attributes the edit to. Don't collapse these into one field.
      role_id: req.user.role_id,
      edited_by: req.user.user_id,
      expected_revision: req.body?.expected_revision,
    });
    await invalidateCache();
    const ms = Date.now() - started;
    if (ms > 5000) logger.warn(`Slow PDI report save: report ${req.params.id}, ${ms}ms, ${bytes} bytes`);
    res.json(report);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error updating PDI report ${req.params.id} (${Date.now() - started}ms, ${bytes} bytes): ${error.message}`, error.stack);
    sendInternalError(res);
  }
};

exports.getRevisions = async (req, res) => {
  try {
    const revisions = await PdiReports.getRevisions(req.params.id);
    res.json(revisions);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error fetching PDI report revisions ${req.params.id}: ${error.message}`, error.stack);
    sendInternalError(res);
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
    if (sendKnownError(res, error)) return;
    logger.error(`Error finalizing PDI report ${req.params.id}: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};

exports.listReports = async (req, res) => {
  try {
    const { limit = 10, cursor, offset, status, template_id, search, sortBy, sortDir } = req.query;
    const result = await PdiReports.listReports({ limit, cursor, offset, status, template_id, search, sortBy, sortDir });
    res.json(result);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error listing PDI reports: ${error.message}`, error.stack);
    sendInternalError(res);
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
    if (sendKnownError(res, error)) return;
    logger.error(`Error generating PDI PDF ${req.params.id}: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};

exports.deleteReport = async (req, res) => {
  try {
    const result = await PdiReports.deleteReport(req.params.id, req.io, { role_id: req.user.role_id });
    await invalidateCache();
    res.json(result);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    logger.error(`Error deleting PDI report ${req.params.id}: ${error.message}`, error.stack);
    sendInternalError(res);
  }
};
