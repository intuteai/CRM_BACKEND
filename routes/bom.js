const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const BOM = require('../models/bom');
const redis = require('../config/redis');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const pool = require('../config/db');
const router = express.Router({ mergeParams: true });

// Middleware to ensure admin access
const ensureAdmin = (req, res, next) => {
  if (req.user.role_id !== 1) {
    logger.warn(`Unauthorized BOM access by user_id: ${req.user.user_id}`, {
      path: req.path,
      method: req.method,
    });
    return res.status(403).json({ error: 'Access restricted to admin only' });
  }
  next();
};

// Validation middleware
const validateBOM = [
  body('productId')
    .isInt({ min: 1 })
    .withMessage('Product ID must be a positive integer'),
  body('materials')
    .isArray({ min: 1 })
    .withMessage('Materials must be a non-empty array'),
  body('materials.*.materialId')
    .isInt({ min: 1 })
    .withMessage('Material ID must be a positive integer'),
  body('materials.*.quantityPerUnit')
    .isFloat({ gt: 0 })
    .withMessage('Quantity per unit must be a positive number'),
];

const validateId = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('BOM ID must be a positive integer'),
];

const validateQuery = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  query('offset')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Offset must be a non-negative integer'),
];

// Invalidate BOM cache
const invalidateBOMCache = async () => {
  try {
    const keys = await redis.keys('bom_list_*');
    if (keys.length > 0) {
      await redis.del(keys);
      logger.info(`Invalidated ${keys.length} BOM cache keys`, { keys });
    }
  } catch (error) {
    logger.error(`Failed to invalidate BOM cache: ${error.message}`, {
      stack: error.stack,
    });
  }
};

// Get all BOMs
router.get(
  '/',
  authenticateToken,
  ensureAdmin,
  validateQuery,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Validation errors in GET /bom', { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { limit = 10, offset = 0, force_refresh = false } = req.query;
    const cacheKey = `bom_list_${limit}_${offset}`;

    logger.info(`Fetching BOMs`, { limit, offset, cacheKey });

    try {
      if (force_refresh === 'true') {
        await invalidateBOMCache();
      }

      const cached = await redis.get(cacheKey);
      if (cached && force_refresh !== 'true') {
        logger.info(`Cache hit for ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }

      const boms = await BOM.getAll({ limit: parseInt(limit), offset: parseInt(offset) });

      const countQuery = 'SELECT COUNT(*) AS total FROM bill_of_materials';
      const { rows } = await pool.query(countQuery);
      const total = parseInt(rows[0].total);

      const response = { data: boms, total };

      await redis.setEx(cacheKey, 300, JSON.stringify(response));
      logger.info(`Cache set for ${cacheKey}`);
      res.json(response);
    } catch (error) {
      logger.error(`Error fetching BOMs: ${error.message}`, {
        stack: error.stack,
        query: req.query,
      });
      res.status(500).json({ error: 'Failed to fetch BOMs' });
    }
  }
);

// Get a single BOM by ID
router.get(
  '/:id',
  authenticateToken,
  ensureAdmin,
  validateId,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn(`Validation errors in GET /bom/:id`, { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    logger.info(`Fetching BOM ${id}`);

    try {
      const bom = await BOM.getById(id);
      if (!bom) {
        logger.info(`BOM ${id} not found`);
        return res.status(404).json({ error: 'BOM not found' });
      }
      res.json(bom);
    } catch (error) {
      logger.error(`Error fetching BOM ${id}: ${error.message}`, {
        stack: error.stack,
      });
      res.status(500).json({ error: 'Failed to fetch BOM' });
    }
  }
);

// Create a new BOM
router.post(
  '/',
  authenticateToken,
  ensureAdmin,
  validateBOM,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn(`Validation errors in POST /bom`, { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { productId, materials } = req.body;
    logger.info(`Creating BOM`, { productId, materialCount: materials.length });

    try {
      const bom = await BOM.create({ productId, materials });
      await invalidateBOMCache();
      req.io.emit('bom:created', {
        ...bom,
        triggeredBy: req.user.user_id || 'unknown',
      });
      logger.info(`BOM ${bom.bomId} created`, { bomId: bom.bomId, userId: req.user.user_id });
      res.status(201).json(bom);
    } catch (error) {
      logger.error(`Error creating BOM: ${error.message}`, {
        stack: error.stack,
        body: req.body,
      });
      if (
        error.message.includes('foreign key constraint') ||
        error.message.includes('No price found')
      ) {
        res.status(400).json({ error: 'Invalid productId or materialId' });
      } else {
        res.status(500).json({ error: 'Failed to create BOM' });
      }
    }
  }
);

// Update a BOM
router.put(
  '/:id',
  authenticateToken,
  ensureAdmin,
  validateId,
  validateBOM,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn(`Validation errors in PUT /bom/:id`, { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { productId, materials } = req.body;
    logger.info(`Updating BOM ${id}`, { productId, materialCount: materials.length });

    try {
      const bom = await BOM.update(id, { productId, materials });
      if (!bom) {
        logger.info(`BOM ${id} not found`);
        return res.status(404).json({ error: 'BOM not found' });
      }
      await invalidateBOMCache();
      req.io.emit('bom:updated', {
        ...bom,
        triggeredBy: req.user.user_id || 'unknown',
      });
      logger.info(`BOM ${id} updated`, { bomId: bom.bomId, userId: req.user.user_id });
      res.json(bom);
    } catch (error) {
      logger.error(`Error updating BOM ${id}: ${error.message}`, {
        stack: error.stack,
        body: req.body,
      });
      if (
        error.message.includes('foreign key constraint') ||
        error.message.includes('No price found')
      ) {
        res.status(400).json({ error: 'Invalid productId or materialId' });
      } else {
        res.status(500).json({ error: 'Failed to update BOM' });
      }
    }
  }
);

// Delete a BOM
router.delete(
  '/:id',
  authenticateToken,
  ensureAdmin,
  validateId,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn(`Validation errors in DELETE /bom/:id`, { errors: errors.array() });
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    logger.info(`Deleting BOM ${id}`);

    try {
      const bom = await BOM.delete(id);
      if (!bom) {
        logger.info(`BOM ${id} not found`);
        return res.status(404).json({ error: 'BOM not found' });
      }
      await invalidateBOMCache();
      req.io.emit('bom:deleted', {
        bomId: bom.bomId,
        triggeredBy: req.user.user_id || 'unknown',
      });
      logger.info(`BOM ${id} deleted`, { bomId: bom.bomId, userId: req.user.user_id });
      res.json({ message: 'BOM deleted successfully', bomId: bom.bomId });
    } catch (error) {
      logger.error(`Error deleting BOM ${id}: ${error.message}`, {
        stack: error.stack,
      });
      res.status(500).json({ error: 'Failed to delete BOM' });
    }
  }
);

module.exports = router;