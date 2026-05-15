const Pdi = require('../../models/operations/pdi');
const PDIGenerator = require('../../models/operations/pdi_generator');
const redis = require('../../config/redis');
const logger = require('../../utils/logger');

exports.generate = async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.pdi_no) return res.status(400).json({ error: 'pdi_no required' });
    const safeName = String(data.pdi_no).replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filename = `PDI_${safeName}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const pdfStream = PDIGenerator.generate(data);
    pdfStream.on('error', (streamErr) => {
      logger.error('PDI stream error:', streamErr);
      if (!res.headersSent) res.status(500).json({ error: 'PDF stream failed' });
      else res.destroy();
    });
    pdfStream.pipe(res);
    logger.info(`PDI generated: ${filename} by ${req.user?.user_id}`);
  } catch (err) {
    logger.error('PDI generate error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDI PDF' });
  }
};

exports.create = async (req, res) => {
  try {
    const { customer_id, order_id, status, inspected_by, inspection_date, report_link } = req.body;
    if (!order_id) return res.status(400).json({ error: 'Order ID is required' });
    const report = await Pdi.create({ customer_id, order_id, status, inspected_by: inspected_by || req.user.name, inspection_date, report_link }, req.io);
    const keys = await redis.keys('pdi_*');
    if (keys.length > 0) await redis.del(keys);
    logger.info(`PDI report created: ${report.report_id} by ${req.user.user_id}`);
    res.status(201).json(report);
  } catch (error) {
    if (error.code === '23503') return res.status(400).json({ error: 'Invalid customer_id or order_id' });
    logger.error(`Error creating PDI report: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getAll = async (req, res) => {
  const { limit = 10, cursor, force_refresh = 'false' } = req.query;
  const cacheKey = cursor ? `pdi_list_${limit}_${cursor}` : `pdi_list_${limit}`;
  try {
    if (force_refresh === 'true') await redis.del(cacheKey);
    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') { logger.info(`Cache hit for ${cacheKey}`); return res.json(JSON.parse(cached)); }
    const pdi = await Pdi.getAll({ limit: parseInt(limit), cursor });
    await redis.setEx(cacheKey, 300, JSON.stringify(pdi));
    res.json(pdi);
  } catch (error) {
    logger.error(`Error fetching PDI: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getOne = async (req, res) => {
  const cacheKey = `pdi_report_${req.params.id}`;
  try {
    if (req.query.force_refresh === 'true') await redis.del(cacheKey);
    const cached = await redis.get(cacheKey);
    if (cached && req.query.force_refresh !== 'true') { logger.info(`Cache hit for ${cacheKey}`); return res.json(JSON.parse(cached)); }
    const report = await Pdi.getById(req.params.id);
    await redis.setEx(cacheKey, 300, JSON.stringify(report));
    res.json(report);
  } catch (error) {
    logger.error(`Error fetching PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Report not found' ? 404 : 500).json({ error: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const { customer_id, order_id, status, inspected_by, inspection_date, report_link } = req.body;
    const report = await Pdi.update(req.params.id, { customer_id, order_id, status, inspected_by, inspection_date, report_link }, req.io);
    const keys = await redis.keys('pdi_*');
    if (keys.length > 0) await redis.del(keys);
    logger.info(`PDI report updated: ${report.report_id} by ${req.user.user_id}`);
    res.json(report);
  } catch (error) {
    if (error.code === '23503') return res.status(400).json({ error: 'Invalid customer_id or order_id' });
    logger.error(`Error updating PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Report not found' ? 404 : 500).json({ error: error.message });
  }
};

exports.delete = async (req, res) => {
  try {
    const report = await Pdi.delete(req.params.id, req.io);
    const keys = await redis.keys('pdi_*');
    if (keys.length > 0) await redis.del(keys);
    logger.info(`PDI report deleted: ${report.report_id} by ${req.user.user_id}`);
    res.json({ message: 'Report deleted successfully', report });
  } catch (error) {
    logger.error(`Error deleting PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Report not found' ? 404 : 500).json({ error: error.message });
  }
};
