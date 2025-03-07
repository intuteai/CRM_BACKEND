// routes/inventory.js
const express = require('express');
const Inventory = require('../models/inventory');
const Activity = require('../models/activity');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const pool = require('../config/db'); // Import pool directly
const router = express.Router({ mergeParams: true });

router.post('/', authenticateToken, checkPermission('Inventory', 'can_write'), async (req, res, next) => {
  try {
    const product = await Inventory.create(req.body, req.io);
    await Activity.log(req.user.user_id, 'CREATE_PRODUCT', `Product ${product.product_id} created`);
    await redis.del('inventory_*');
    logger.info(`Product added: ${product.product_name} by ${req.user.user_id}`);
    res.status(201).json(product);
  } catch (error) {
    next(error);
  }
});

router.get('/available', authenticateToken, async (req, res, next) => {
  const { limit = 10, offset = 0 } = req.query;
  try {
    const cacheKey = `inventory_available_${limit}_${offset}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const query = `
      SELECT product_id, product_name, stock_quantity 
      FROM inventory 
      WHERE stock_quantity > 0 
      LIMIT $1 OFFSET $2
    `;
    const { rows } = await pool.query(query, [parseInt(limit), parseInt(offset)]);
    const result = { data: rows, total: rows.length };
    await redis.setEx(cacheKey, 3600, JSON.stringify(result));
    logger.info(`Fetched ${rows.length} available inventory items`);
    res.json(result);
  } catch (error) {
    logger.error(`Error in GET /api/inventory/available: ${error.message}`, error.stack);
    next(error);
  }
});

router.get('/', authenticateToken, checkPermission('Inventory', 'can_read'), async (req, res, next) => {
  const { limit = 10, offset = 0 } = req.query;
  try {
    const cacheKey = `inventory_${limit}_${offset}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const inventory = await Inventory.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
    await redis.setEx(cacheKey, 3600, JSON.stringify(inventory));
    res.json(inventory);
  } catch (error) {
    next(error);
  }
});

module.exports = router;