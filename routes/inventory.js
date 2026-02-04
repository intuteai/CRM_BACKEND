const express = require('express');
const Inventory = require('../models/inventory');
const Activity = require('../models/activity');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const sanitizeHtml = require('sanitize-html');
const rateLimit = require('express-rate-limit');
const router = express.Router({ mergeParams: true });

// Rate limiting: 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});

router.use(limiter);

const sanitizeInput = (input) =>
  sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {}
  });

// --------------------------------------------------
// POST /api/inventory - CREATE PRODUCT
// --------------------------------------------------
router.post(
  '/',
  authenticateToken,
  checkPermission('Inventory', 'can_write'),
  async (req, res, next) => {
    try {
      const {
        product_name,
        stock_quantity,
        price,
        description,
        product_code,
        returnable_qty = 0
      } = req.body;

      if (!product_name) {
        return res.status(400).json({ error: 'Product name is required' });
      }
      if (!product_code || product_code.length !== 10) {
        return res.status(400).json({ error: 'Product code must be exactly 10 characters' });
      }
      if (stock_quantity < 0) {
        return res.status(400).json({ error: 'Stock quantity cannot be negative' });
      }
      if (returnable_qty < 0) {
        return res.status(400).json({ error: 'Returnable quantity cannot be negative' });
      }

      const sanitizedData = {
        product_name: sanitizeInput(product_name),
        stock_quantity: stock_quantity || 0,
        price: price || null,
        description: description ? sanitizeInput(description) : null,
        product_code: sanitizeInput(product_code),
        returnable_qty: returnable_qty || 0
      };

      const product = await Inventory.create(sanitizedData, req.io);

      await Activity.log(
        req.user.user_id,
        'CREATE_PRODUCT',
        `Product ${product.product_id} created`
      );

      const keys = await redis.keys('inventory_*');
      if (keys.length > 0) await redis.del(keys);
      await redis.del(`price_list_*`);

      logger.info(`Product added: ${product.product_name} by ${req.user.user_id}`);
      res.status(201).json(product);
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'unique_product_code') {
        return res.status(400).json({ error: 'Product code must be unique' });
      }
      logger.error(`Error creating inventory: ${error.message}`, error.stack);
      next(error);
    }
  }
);

// --------------------------------------------------
// GET /api/inventory/available - WITH HOLDS
// --------------------------------------------------
router.get('/available', authenticateToken, async (req, res, next) => {
  const { limit = 1000, offset = 0, force_refresh } = req.query;
  try {
    const cacheKey = `inventory_availability_${limit}_${offset}`;

    if (force_refresh !== 'true') {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info(`Cache hit for ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }
    }

    const items = await Inventory.getInventoryWithAvailability({
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    const result = {
      data: items.map((item) => ({
        ...item,
        available: (item.available_quantity || 0) > 0
      })),
      total: items.length
    };

    await redis.setEx(cacheKey, 3600, JSON.stringify(result));
    logger.info(`Fetched ${items.length} inventory items with availability`);
    res.json(result);
  } catch (error) {
    logger.error(`Error in GET /api/inventory/available: ${error.message}`, error.stack);
    next(error);
  }
});

// --------------------------------------------------
// GET /api/inventory - RAW INVENTORY (ADMIN VIEW)
// --------------------------------------------------
router.get(
  '/',
  authenticateToken,
  checkPermission('Inventory', 'can_read'),
  async (req, res, next) => {
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

      const inventory = await Inventory.getAll({
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
      await redis.setEx(cacheKey, 3600, JSON.stringify(inventory));
      logger.info(`Fetched ${inventory.data.length} inventory items`);
      res.json(inventory);
    } catch (error) {
      logger.error(`Error in GET /api/inventory: ${error.message}`, error.stack);
      next(error);
    }
  }
);

// --------------------------------------------------
// PUT /api/inventory/:id - UPDATE (CRITICAL FIX)
// --------------------------------------------------
router.put(
  '/:id',
  authenticateToken,
  checkPermission('Inventory', 'can_write'),
  async (req, res, next) => {
    try {
      const productId = req.params.id;

      logger.info(`🔧 UPDATE request for product ${productId} by user ${req.user.user_id}`);
      logger.info(`🔧 Request body:`, JSON.stringify(req.body));

      const {
        product_name,
        price,
        description,
        product_code,
        stock_quantity,
        returnable_qty
      } = req.body;

      // Basic validation
      if (!product_name) {
        return res.status(400).json({ error: 'Product name is required' });
      }
      if (price !== undefined && price < 0) {
        return res.status(400).json({ error: 'Price must be >= 0' });
      }
      if (!product_code || product_code.length !== 10) {
        return res.status(400).json({ error: 'Product code must be exactly 10 characters' });
      }

      // Prepare update data - ALL fields can be updated by anyone with write permission
      const updateData = {
        product_name: sanitizeInput(product_name),
        price: price !== undefined ? parseFloat(price) : null,
        description: description ? sanitizeInput(description) : null,
        product_code: sanitizeInput(product_code)
      };

      // Stock quantities - parse and validate
      if (stock_quantity !== undefined) {
        const parsedQty = parseInt(stock_quantity);
        if (isNaN(parsedQty)) {
          return res.status(400).json({ error: 'Stock quantity must be a number' });
        }
        updateData.stock_quantity = parsedQty;
        logger.info(`🔧 Updating stock_quantity to ${parsedQty}`);
      }
      
      if (returnable_qty !== undefined) {
        const parsedReturnable = parseInt(returnable_qty);
        if (isNaN(parsedReturnable) || parsedReturnable < 0) {
          return res.status(400).json({ error: 'Returnable quantity must be a non-negative integer' });
        }
        updateData.returnable_qty = parsedReturnable;
        logger.info(`🔧 Updating returnable_qty to ${parsedReturnable}`);
      }

      logger.info(`🔧 Final update data:`, JSON.stringify(updateData));

      // Execute update - always pass isAdmin=true since we're using permission-based auth
      const updatedProduct = await Inventory.update(productId, updateData, true);

      // Sync price with price_list if changed
      if (price !== undefined) {
        await Inventory.syncPriceWithPriceList(productId, price);
      }

      // Emit socket event if stock changed
      if (stock_quantity !== undefined || returnable_qty !== undefined) {
        if (req.io) {
          req.io.emit('stockUpdate', {
            product_id: updatedProduct.product_id,
            stock_quantity: updatedProduct.stock_quantity,
            returnable_qty: updatedProduct.returnable_qty,
          });
          logger.info(`📡 Emitted stockUpdate event for product ${productId}`);
        }
      }

      await Activity.log(
        req.user.user_id,
        'UPDATE_PRODUCT',
        `Product ${productId} updated${stock_quantity !== undefined || returnable_qty !== undefined ? ' (stock override)' : ''}`
      );

      // Invalidate caches
      const keys = await redis.keys('inventory_*');
      if (keys.length > 0) await redis.del(keys);
      await redis.del(`price_list_*`);

      logger.info(`✅ Product updated successfully: ${updatedProduct.product_name}`);
      res.json(updatedProduct);
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'unique_product_code') {
        return res.status(400).json({ error: 'Product code must be unique' });
      }
      logger.error(`❌ Error updating inventory ${req.params.id}: ${error.message}`, error.stack);
      next(error);
    }
  }
);

// --------------------------------------------------
// DELETE /api/inventory/:id - GUARDED DELETE
// --------------------------------------------------
router.delete(
  '/:id',
  authenticateToken,
  checkPermission('Inventory', 'can_write'),
  async (req, res, next) => {
    try {
      const productId = req.params.id;
      const deletedProduct = await Inventory.delete(productId, req.io);

      await Activity.log(
        req.user.user_id,
        'DELETE_PRODUCT',
        `Product ${productId} deleted`
      );

      const keys = await redis.keys('inventory_*');
      if (keys.length > 0) await redis.del(keys);
      await redis.del(`price_list_*`);

      logger.info(`Product deleted: ${deletedProduct.product_name} by ${req.user.user_id}`);
      res.json({
        message: 'Product deleted successfully',
        product: deletedProduct
      });
    } catch (error) {
      if (error.message.includes('active inventory holds')) {
        return res.status(400).json({
          error: 'Cannot delete product with active holds',
          details: error.message
        });
      }
      if (error.message.includes('non-zero stock')) {
        return res.status(400).json({
          error: 'Cannot delete product with remaining stock',
          details: error.message
        });
      }
      logger.error(`Error deleting inventory ${req.params.id}: ${error.message}`, error.stack);
      next(error);
    }
  }
);

// --------------------------------------------------
// POST /api/inventory/:id/hold - CREATE HOLD
// --------------------------------------------------
router.post(
  '/:id/hold',
  authenticateToken,
  checkPermission('Inventory', 'can_write'),
  async (req, res, next) => {
    try {
      const productId = req.params.id;
      const { quantity, reason, reference_type, reference_value } = req.body;

      if (!quantity || quantity <= 0) {
        return res.status(400).json({ error: 'Quantity must be greater than 0' });
      }
      if (!reason) {
        return res.status(400).json({ error: 'Reason is required' });
      }

      const hold = await Inventory.createHold({
        product_id: productId,
        quantity: parseInt(quantity),
        reason: sanitizeInput(reason),
        reference_type: reference_type || null,
        reference_value: reference_value || null,
        created_by: req.user.user_id
      });

      await Activity.log(
        req.user.user_id,
        'CREATE_HOLD',
        `Hold created for product ${productId}: ${quantity} units`
      );

      const keys = await redis.keys('inventory_availability_*');
      if (keys.length > 0) await redis.del(keys);

      logger.info(`Hold created: ${quantity} units of product ${productId} by ${req.user.user_id}`);
      res.status(201).json(hold);
    } catch (error) {
      logger.error(`Error creating hold for product ${req.params.id}: ${error.message}`, error.stack);
      next(error);
    }
  }
);

// --------------------------------------------------
// POST /api/inventory/hold/:hold_id/release
// --------------------------------------------------
router.post(
  '/hold/:hold_id/release',
  authenticateToken,
  checkPermission('Inventory', 'can_write'),
  async (req, res, next) => {
    try {
      const holdId = req.params.hold_id;
      const releasedHold = await Inventory.releaseHold(holdId);

      await Activity.log(
        req.user.user_id,
        'RELEASE_HOLD',
        `Hold ${holdId} released for product ${releasedHold.product_id}`
      );

      const keys = await redis.keys('inventory_availability_*');
      if (keys.length > 0) await redis.del(keys);

      logger.info(`Hold released: ${holdId} by ${req.user.user_id}`);
      res.json(releasedHold);
    } catch (error) {
      if (error.message.includes('not found or already released')) {
        return res.status(404).json({
          error: 'Hold not found or already released',
          details: error.message
        });
      }
      logger.error(`Error releasing hold ${req.params.hold_id}: ${error.message}`, error.stack);
      next(error);
    }
  }
);

// --------------------------------------------------
// GET /api/inventory/:id/holds - VIEW ACTIVE HOLDS
// --------------------------------------------------
router.get(
  '/:id/holds',
  authenticateToken,
  checkPermission('Inventory', 'can_read'),
  async (req, res, next) => {
    try {
      const productId = req.params.id;
      const holds = await Inventory.getActiveHoldsByProduct(productId);
      logger.info(`Fetched ${holds.length} active holds for product ${productId}`);
      res.json({ data: holds, total: holds.length });
    } catch (error) {
      logger.error(`Error fetching holds for product ${req.params.id}: ${error.message}`, error.stack);
      next(error);
    }
  }
);

module.exports = router;