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

exports.createReport = async (req, res) => {
  try {
    const { customer_id, order_id, inspected_by, inspection_date, data, photos } = req.body || {};
    const report = await PdiReports.createReport({
      customer_id, order_id, inspected_by: inspected_by || req.user.name, inspection_date, data, photos,
    }, req.io);

    await invalidateCache();

    logger.info(`PDI report draft created: ${report.report_id} by ${req.user.user_id}`);
    res.status(201).json(report);
  } catch (error) {
    logger.error(`Error creating PDI report: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
