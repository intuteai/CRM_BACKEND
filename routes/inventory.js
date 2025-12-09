const express = require('express');
const Inventory = require('../models/inventory');
const Activity = require('../models/activity');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const pool = require('../config/db');
const sanitizeHtml = require('sanitize-html');
const rateLimit = require('express-rate-limit');
const router = express.Router({ mergeParams: true });

// Rate limiting: 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

// Apply rate limiting to all routes
router.use(limiter);

const sanitizeInput = (input) => sanitizeHtml(input, {
  allowedTags: [], // Strip all HTML tags
  allowedAttributes: {}
});

// POST /api/inventory
router.post('/', authenticateToken, checkPermission('Inventory', 'can_write'), async (req, res, next) => {
  try {
    const { product_name, stock_quantity, price, description, product_code } = req.body;
    
    if (!product_name) return res.status(400).json({ error: 'Product name is required' });
    if (!product_code || product_code.length !== 10) return res.status(400).json({ error: 'Product code must be exactly 10 characters' });

    const sanitizedData = {
      product_name: sanitizeInput(product_name),
      stock_quantity,
      price,
      description: description ? sanitizeInput(description) : null,
      product_code: sanitizeInput(product_code)
    };

    const product = await Inventory.create(sanitizedData, req.io);
    
    await Activity.log(req.user.user_id, 'CREATE_PRODUCT', `Product ${product.product_id} created`);
    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    await redis.del(`price_list_*`); // Invalidate price_list cache
    await redis.del('inventory_stock'); // Invalidate stock cache
    logger.info(`Product added: ${product.product_name} by ${req.user.user_id}`);
    res.status(201).json(product);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'unique_product_code') {
      return res.status(400).json({ error: 'Product code must be unique' });
    }
    logger.error(`Error creating inventory: ${error.message}`, error.stack);
    next(error);
  }
});

// GET /api/inventory/available
router.get('/available', authenticateToken, async (req, res, next) => {
  const { limit = 1000, offset = 0 } = req.query; // Increased limit for all products
  try {
    const cacheKey = `inventory_available_${limit}_${offset}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const query = `
      SELECT product_id, product_name, stock_quantity, price, created_at, description, product_code
      FROM inventory LIMIT $1 OFFSET $2
    `;
    const countQuery = `SELECT COUNT(*) FROM inventory`;
    const [itemsResult, countResult] = await Promise.all([
      pool.query(query, [parseInt(limit), parseInt(offset)]),
      pool.query(countQuery),
    ]);
    const result = { 
      data: itemsResult.rows.map(item => ({
        ...item,
        available: item.stock_quantity > 0 // Add flag for frontend
      })), 
      total: parseInt(countResult.rows[0].count) 
    };

    await redis.setEx(cacheKey, 3600, JSON.stringify(result));
    logger.info(`Fetched ${itemsResult.rows.length} inventory items`);
    res.json(result);
  } catch (error) {
    logger.error(`Error in GET /api/inventory/available: ${error.message}`, error.stack);
    next(error);
  }
});

// GET /api/inventory
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
    logger.error(`Error in GET /api/inventory: ${error.message}`, error.stack);
    next(error);
  }
});

// GET /api/inventory/stock
router.get('/stock', authenticateToken, async (req, res, next) => {
  const { force_refresh } = req.query;
  try {
    const cacheKey = `inventory_stock`;
    if (force_refresh !== 'true') {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info(`Cache hit for ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }
    }

    const query = `
      SELECT product_id, product_name, stock_quantity, price, description, product_code
      FROM inventory
    `;
    const { rows } = await pool.query(query);

    await redis.setEx(cacheKey, 3600, JSON.stringify(rows));
    logger.info(`Fetched ${rows.length} stock items`);
    res.json(rows);
  } catch (error) {
    logger.error(`Error in GET /api/inventory/stock: ${error.message}`, error.stack);
    next(error);
  }
});


// GET /api/inventory/stock
router.get('/stock', authenticateToken, async (req, res, next) => {
  const { force_refresh } = req.query;
  try {
    const cacheKey = `inventory_stock`;
    if (force_refresh !== 'true') {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info(`Cache hit for ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }
    }

    const query = `
      SELECT product_id, product_name, stock_quantity, description, product_code
      FROM inventory
    `;
    const { rows } = await pool.query(query);
    await redis.setEx(cacheKey, 3600, JSON.stringify(rows));
    logger.info(`Fetched ${rows.length} stock items`);
    res.json(rows);
  } catch (error) {
    logger.error(`Error in GET /api/inventory/stock: ${error.message}`, error.stack);
    next(error);
  }
});

// PUT /api/inventory/:id
router.put('/:id', authenticateToken, checkPermission('Inventory', 'can_write'), async (req, res, next) => {
  try {
    const { product_name, stock_quantity, price, description, product_code } = req.body;
    const productId = req.params.id;

    if (!product_name) return res.status(400).json({ error: 'Product name is required' });
    if (stock_quantity < 0 || price < 0) return res.status(400).json({ error: 'Stock quantity and price must be >= 0' });
    if (!product_code || product_code.length !== 10) return res.status(400).json({ error: 'Product code must be exactly 10 characters' });

    const sanitizedData = {
      product_name: sanitizeInput(product_name),
      stock_quantity: stock_quantity || 0,
      price: price || null,
      description: description ? sanitizeInput(description) : null,
      product_code: sanitizeInput(product_code)
    };

    const updatedProduct = await Inventory.update(productId, sanitizedData);
    if (price !== undefined) {
      await Inventory.syncPriceWithPriceList(productId, price); // Sync with price_list
    }

    req.io.emit('stockUpdate', { product_id: updatedProduct.product_id, stock_quantity: updatedProduct.stock_quantity });
    await Activity.log(req.user.user_id, 'UPDATE_PRODUCT', `Product ${productId} updated`);
    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    await redis.del(`price_list_*`); // Invalidate price_list cache
    await redis.del('inventory_stock'); // Invalidate stock cache
    logger.info(`Product updated: ${updatedProduct.product_name} by ${req.user.user_id}`);
    res.json(updatedProduct);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'unique_product_code') {
      return res.status(400).json({ error: 'Product code must be unique' });
    }
    logger.error(`Error updating inventory ${req.params.id}: ${error.message}`, error.stack);
    next(error);
  }
});

// DELETE /api/inventory/:id
router.delete('/:id', authenticateToken, checkPermission('Inventory', 'can_write'), async (req, res, next) => {
  try {
    const productId = req.params.id;
    const deletedProduct = await Inventory.delete(productId, req.io);
    
    await Activity.log(req.user.user_id, 'DELETE_PRODUCT', `Product ${productId} deleted`);
    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    await redis.del(`price_list_*`); // Invalidate price_list cache
    await redis.del('inventory_stock'); // Invalidate stock cache
    logger.info(`Product deleted: ${deletedProduct.product_name} by ${req.user.user_id}`);
    res.json({ message: 'Product deleted successfully', product: deletedProduct });
  } catch (error) {
    logger.error(`Error deleting inventory ${req.params.id}: ${error.message}`, error.stack);
    next(error);
  }
});

module.exports = router;