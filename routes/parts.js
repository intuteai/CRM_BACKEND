// routes/parts.js
const express = require('express');
const Parts = require('../models/parts');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

// --------------------------------------------------------------
// VALIDATION
// --------------------------------------------------------------
const validateCreateOrUpdate = (req, res, next) => {
  const {
    partTypeId,
    name,
    description,
    drawingNo,
    customerPartNo,
    supplierPartNo,
  } = req.body;

  // For update, partTypeId may be undefined (we don't allow changing type)
  if (req.method === 'POST') {
    if (!partTypeId || typeof partTypeId !== 'number') {
      return res.status(400).json({
        error: 'Invalid or missing partTypeId',
        code: 'INVALID_INPUT',
      });
    }
  }

  if (!name || typeof name !== 'string') {
    return res.status(400).json({
      error: 'Invalid or missing name',
      code: 'INVALID_INPUT',
    });
  }

  if (!description || typeof description !== 'string') {
    return res.status(400).json({
      error: 'Invalid or missing description',
      code: 'INVALID_INPUT',
    });
  }

  if (!drawingNo || typeof drawingNo !== 'string') {
    return res.status(400).json({
      error: 'Invalid or missing drawingNo',
      code: 'INVALID_INPUT',
    });
  }

  if (customerPartNo && typeof customerPartNo !== 'string') {
    return res.status(400).json({
      error: 'Invalid customerPartNo',
      code: 'INVALID_INPUT',
    });
  }

  if (supplierPartNo && typeof supplierPartNo !== 'string') {
    return res.status(400).json({
      error: 'Invalid supplierPartNo',
      code: 'INVALID_INPUT',
    });
  }

  next();
};

// --------------------------------------------------------------
// GET: ALL PARTS (ADMIN ONLY FOR NOW)
// --------------------------------------------------------------
router.get(
  '/',
  authenticateToken,
  checkPermission('Parts', 'can_read'),
  async (req, res) => {
    const { limit = 10, offset = 0 } = req.query;

    try {
      const parts = await Parts.getAll({
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      });

      logger.info(`Fetched parts list (limit=${limit}, offset=${offset})`);
      res.json(parts);
    } catch (error) {
      logger.error('Error fetching parts:', error.stack || error);
      res
        .status(500)
        .json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// --------------------------------------------------------------
// GET: PART TYPES
// Used to populate dropdown in UI
// --------------------------------------------------------------
router.get(
  '/types',
  authenticateToken,
  checkPermission('Parts', 'can_read'),
  async (req, res) => {
    try {
      const types = await Parts.getPartTypes();
      res.json(types);
    } catch (error) {
      logger.error('Error fetching part types:', error.stack || error);
      res
        .status(500)
        .json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// --------------------------------------------------------------
// GET: PREVIEW NEXT CODE (no DB update)
// /api/parts/next-code?partTypeId=1
// --------------------------------------------------------------
router.get(
  '/next-code',
  authenticateToken,
  checkPermission('Parts', 'can_write'),
  async (req, res) => {
    const partTypeId = parseInt(req.query.partTypeId, 10);

    if (isNaN(partTypeId)) {
      return res.status(400).json({
        error: 'Invalid partTypeId',
        code: 'INVALID_INPUT',
      });
    }

    try {
      const preview = await Parts.previewNextCode(partTypeId);
      res.json(preview);
    } catch (error) {
      if (error.code === 'INVALID_PART_TYPE') {
        return res.status(400).json({
          error: 'Invalid part type',
          code: 'INVALID_PART_TYPE',
        });
      }
      logger.error('Error previewing next part code:', error.stack || error);
      res
        .status(500)
        .json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// --------------------------------------------------------------
// CREATE PART
// --------------------------------------------------------------
router.post(
  '/',
  authenticateToken,
  checkPermission('Parts', 'can_write'),
  validateCreateOrUpdate,
  async (req, res) => {
    const {
      partTypeId,
      name,
      description,
      drawingNo,
      customerPartNo,
      supplierPartNo,
    } = req.body;

    try {
      const part = await Parts.create({
        partTypeId,
        name,
        description,
        drawingNo,
        customerPartNo,
        supplierPartNo,
      });

      logger.info(
        `Created part ${part.partCode} (id=${part.id}) by user ${req.user.user_id}`
      );

      res.status(201).json(part);
    } catch (error) {
      if (error.message === 'Invalid part type' || error.code === 'INVALID_PART_TYPE') {
        return res.status(400).json({
          error: 'Invalid part type',
          code: 'INVALID_PART_TYPE',
        });
      }

      logger.error('Error creating part:', error.stack || error);
      res
        .status(500)
        .json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// --------------------------------------------------------------
// UPDATE PART (no partType or partCode change)
// --------------------------------------------------------------
router.put(
  '/:id',
  authenticateToken,
  checkPermission('Parts', 'can_write'),
  validateCreateOrUpdate,
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const {
      name,
      description,
      drawingNo,
      customerPartNo,
      supplierPartNo,
    } = req.body;

    if (isNaN(id)) {
      return res.status(400).json({
        error: 'Invalid part id',
        code: 'INVALID_INPUT',
      });
    }

    try {
      const part = await Parts.update(id, {
        name,
        description,
        drawingNo,
        customerPartNo,
        supplierPartNo,
      });

      logger.info(`Updated part ${id} by user ${req.user.user_id}`);
      res.json(part);
    } catch (error) {
      if (error.code === 'NOT_FOUND') {
        return res
          .status(404)
          .json({ error: 'Part not found', code: 'NOT_FOUND' });
      }
      logger.error(`Error updating part ${id}:`, error.stack || error);
      res
        .status(500)
        .json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// --------------------------------------------------------------
// DELETE PART (hard delete for now)
// --------------------------------------------------------------
router.delete(
  '/:id',
  authenticateToken,
  checkPermission('Parts', 'can_delete'),
  async (req, res) => {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({
        error: 'Invalid part id',
        code: 'INVALID_INPUT',
      });
    }

    try {
      await Parts.delete(id);
      logger.info(`Deleted part ${id} by user ${req.user.user_id}`);
      res.status(204).send();
    } catch (error) {
      if (error.code === 'NOT_FOUND') {
        return res
          .status(404)
          .json({ error: 'Part not found', code: 'NOT_FOUND' });
      }
      logger.error(`Error deleting part ${id}:`, error.stack || error);
      res
        .status(500)
        .json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

module.exports = router;
