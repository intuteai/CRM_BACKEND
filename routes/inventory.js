const express = require('express');
const Inventory = require('../models/inventory');
const Activity = require('../models/activity');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const pool = require('../config/db');
const router = express.Router({ mergeParams: true });

// POST /api/inventory - Create a new inventory item
router.post('/', authenticateToken, checkPermission('Inventory', 'can_write'), async (req, res, next) => {
  try {
    const product = await Inventory.create(req.body, req.io);
    await Activity.log(req.user.user_id, 'CREATE_PRODUCT', `Product ${product.product_id} created`);
    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    logger.info(`Product added: ${product.product_name} by ${req.user.user_id}`);
    res.status(201).json(product);
  } catch (error) {
    next(error);
  }
});

// GET /api/inventory/available - Fetch available inventory items
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
      SELECT product_id, product_name, stock_quantity, price, created_at
      FROM inventory
      WHERE stock_quantity > 0
      LIMIT $1 OFFSET $2
    `;
    const countQuery = `SELECT COUNT(*) FROM inventory WHERE stock_quantity > 0`;
    const [itemsResult, countResult] = await Promise.all([
      pool.query(query, [parseInt(limit), parseInt(offset)]),
      pool.query(countQuery),
    ]);
    const result = { data: itemsResult.rows, total: parseInt(countResult.rows[0].count) };

    await redis.setEx(cacheKey, 3600, JSON.stringify(result));
    logger.info(`Fetched ${itemsResult.rows.length} available inventory items`);
    res.json(result);
  } catch (error) {
    logger.error(`Error in GET /api/inventory/available: ${error.message}`, error.stack);
    next(error);
  }
});

// GET /api/inventory - Fetch all inventory items
router.get('/', authenticateToken, checkPermission('Inventory', 'can_read'), async (req, res, next) => {
  const { limit = 10, offset = 0, force_refresh } = req.query;
  try {
    const cacheKey = `inventory_${limit}_${offset}`;
    if (force_refresh !== 'true') {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info(`Cache hit for ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }
    }

    const inventory = await Inventory.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
    await redis.setEx(cacheKey, 3600, JSON.stringify(inventory));
    logger.info(`Fetched ${inventory.data.length} inventory items`);
    res.json(inventory);
  } catch (error) {
    next(error);
  }
});

// GET /api/inventory/stock - Fetch real-time stock data
router.get('/stock', authenticateToken, async (req, res, next) => {
  try {
    const query = `
      SELECT product_id, product_name, stock_quantity
      FROM inventory
      WHERE stock_quantity > 0
    `;
    const { rows } = await pool.query(query);
    logger.info(`Fetched ${rows.length} available stock items`);
    res.json(rows);
  } catch (error) {
    logger.error(`Error in GET /api/inventory/stock: ${error.message}`, { stack: error.stack });
    next(error);
  }
});

// PUT /api/inventory/:id - Update an inventory item
router.put('/:id', authenticateToken, checkPermission('Inventory', 'can_write'), async (req, res, next) => {
  try {
    const { product_name, stock_quantity, price } = req.body;
    const productId = req.params.id;

    if (!product_name) {
      return res.status(400).json({ error: 'Product name is required' });
    }
    if (stock_quantity < 0 || price < 0) {
      return res.status(400).json({ error: 'Stock quantity and price must be >= 0' });
    }

    const query = `
      UPDATE inventory
      SET product_name = $1, stock_quantity = $2, price = $3
      WHERE product_id = $4
      RETURNING product_id, product_name, stock_quantity, price, created_at
    `;
    const { rows } = await pool.query(query, [product_name, stock_quantity || 0, price || null, productId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const updatedProduct = rows[0];

    req.io.emit('stockUpdate', { product_id: updatedProduct.product_id, stock_quantity: updatedProduct.stock_quantity });
    await Activity.log(req.user.user_id, 'UPDATE_PRODUCT', `Product ${productId} updated`);
    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    logger.info(`Product updated: ${updatedProduct.product_name} by ${req.user.user_id}`);
    res.json(updatedProduct);
  } catch (error) {
    logger.error(`Error updating inventory ${req.params.id}: ${error.message}`, error.stack);
    next(error);
  }
});

module.exports = router;