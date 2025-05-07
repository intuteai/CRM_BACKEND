const express = require('express');
const Pdi = require('../models/pdi');
const redis = require('../config/redis');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

// POST /api/pdi - Create a new PDI report
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { customer_id, order_id, status, inspected_by, inspection_date, report_link } = req.body;

    if (!order_id) return res.status(400).json({ error: 'Order ID is required' });

    const report = await Pdi.create({
      customer_id,
      order_id,
      status,
      inspected_by: inspected_by || req.user.name,
      inspection_date,
      report_link
    }, req.io);

    // Clear cache for PDI listings
    const keys = await redis.keys('pdi_*');
    if (keys.length > 0) await redis.del(keys);

    logger.info(`PDI report created: ${report.report_id} by ${req.user.user_id}`);
    res.status(201).json(report);
  } catch (error) {
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Invalid customer_id or order_id' });
    }
    logger.error(`Error creating PDI report: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/pdi - Get all PDI reports
router.get('/', authenticateToken, async (req, res) => {
  const { limit = 10, cursor, force_refresh = 'false' } = req.query;
  const cacheKey = cursor ? `pdi_list_${limit}_${cursor}` : `pdi_list_${limit}`;

  try {
    if (force_refresh === 'true') await redis.del(cacheKey);

    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const pdi = await Pdi.getAll({ limit: parseInt(limit), cursor });
    await redis.setEx(cacheKey, 300, JSON.stringify(pdi)); // Cache for 5 minutes
    logger.info(`Fetched ${pdi.data.length} PDI reports`);
    res.json(pdi);
  } catch (error) {
    logger.error(`Error fetching PDI: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/pdi/:id - Get a single PDI report
router.get('/:id', authenticateToken, async (req, res) => {
  const cacheKey = `pdi_report_${req.params.id}`;

  try {
    if (req.query.force_refresh === 'true') await redis.del(cacheKey);

    const cached = await redis.get(cacheKey);
    if (cached && req.query.force_refresh !== 'true') {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const report = await Pdi.getById(req.params.id);
    await redis.setEx(cacheKey, 300, JSON.stringify(report));
    logger.info(`Fetched PDI report: ${report.report_id}`);
    res.json(report);
  } catch (error) {
    logger.error(`Error fetching PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Report not found' ? 404 : 500).json({ error: error.message });
  }
});

// PUT /api/pdi/:id - Update a PDI report
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { customer_id, order_id, status, inspected_by, inspection_date, report_link } = req.body;

    const report = await Pdi.update(req.params.id, {
      customer_id,
      order_id,
      status,
      inspected_by,
      inspection_date,
      report_link
    }, req.io);

    // Clear cache for PDI listings and single report
    const keys = await redis.keys('pdi_*');
    if (keys.length > 0) await redis.del(keys);

    logger.info(`PDI report updated: ${report.report_id} by ${req.user.user_id}`);
    res.json(report);
  } catch (error) {
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Invalid customer_id or order_id' });
    }
    logger.error(`Error updating PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Report not found' ? 404 : 500).json({ error: error.message });
  }
});

// DELETE /api/pdi/:id - Delete a PDI report
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const report = await Pdi.delete(req.params.id, req.io);

    // Clear cache for PDI listings and single report
    const keys = await redis.keys('pdi_*');
    if (keys.length > 0) await redis.del(keys);

    logger.info(`PDI report deleted: ${report.report_id} by ${req.user.user_id}`);
    res.json({ message: 'Report deleted successfully', report });
  } catch (error) {
    logger.error(`Error deleting PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Report not found' ? 404 : 500).json({ error: error.message });
  }
});

module.exports = router;