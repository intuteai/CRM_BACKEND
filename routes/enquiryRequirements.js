// routes/enquiryRequirements.js
const express = require('express');
const EnquiryRequirements = require('../models/enquiryRequirements');
const pool = require('../config/db');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

// --------------------------------------------------------------
// SIMPLE VALIDATION MIDDLEWARE (lightweight, similar style to routes/stock.js)
// --------------------------------------------------------------
const validateRequirementInput = (req, res, next) => {
  const {
    enquiryId, title, description, requirementType, priority,
    status, assigneeId, dueDate, attachments, metadata, motors
  } = req.body;

  if (
    (enquiryId === undefined || typeof enquiryId !== 'number') ||
    !title || typeof title !== 'string' ||
    (description !== undefined && description !== null && typeof description !== 'string') ||
    (requirementType !== undefined && typeof requirementType !== 'string') ||
    (priority !== undefined && typeof priority !== 'string') ||
    (status !== undefined && typeof status !== 'string') ||
    (assigneeId !== undefined && assigneeId !== null && typeof assigneeId !== 'number') ||
    (dueDate !== undefined && dueDate !== null && typeof dueDate !== 'string') || // expect ISO date string
    (attachments !== undefined && !Array.isArray(attachments)) ||
    (metadata !== undefined && typeof metadata !== 'object')
  ) {
    logger.warn(`Invalid input data for ${req.method} ${req.path}: ${JSON.stringify(req.body)}`);
    return res.status(400).json({ error: 'Invalid input data', code: 'INVALID_INPUT' });
  }

  // Optional: basic motors validation if provided
  if (motors !== undefined) {
    if (!Array.isArray(motors)) {
      logger.warn('motors must be an array');
      return res.status(400).json({ error: 'motors must be an array', code: 'INVALID_INPUT' });
    }
    // lightweight item check
    for (const m of motors) {
      if (m.power_rating !== undefined && typeof m.power_rating !== 'object') {
        return res.status(400).json({ error: 'power_rating must be JSON/object', code: 'INVALID_INPUT' });
      }
      if (m.motor_type !== undefined && m.motor_type !== null && !['BLDC','PMSM'].includes(m.motor_type)) {
        return res.status(400).json({ error: 'motor_type must be BLDC or PMSM', code: 'INVALID_INPUT' });
      }
    }
  }

  next();
};

// --------------------------------------------------------------
// LIST / PAGINATE (GET /api/enquiry-requirements)
// Query params: limit, offset, enquiryId, status, priority, assigneeId
// --------------------------------------------------------------
router.get(
  '/',
  authenticateToken,
  checkPermission('EnquiryRequirements', 'can_read'),
  async (req, res) => {
    const { limit = 10, offset = 0, enquiryId, status, priority, assigneeId } = req.query;

    try {
      const data = await EnquiryRequirements.getAll({
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
        enquiryId: enquiryId !== undefined ? parseInt(enquiryId, 10) : undefined,
        status,
        priority,
        assigneeId: assigneeId !== undefined ? parseInt(assigneeId, 10) : undefined
      });

      logger.info('Fetched enquiry requirements list');
      res.json(data);
    } catch (err) {
      logger.error('Error fetching enquiry requirements:', err.stack || err);
      res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// --------------------------------------------------------------
// GET single (GET /api/enquiry-requirements/:id?includeMotors=true)
// --------------------------------------------------------------
router.get(
  '/:id',
  authenticateToken,
  checkPermission('EnquiryRequirements', 'can_read'),
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const includeMotors = req.query.includeMotors === 'true';

    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_INPUT' });

    try {
      const item = await EnquiryRequirements.getById(id, { includeMotors });
      if (!item) return res.status(404).json({ error: 'Enquiry requirement not found', code: 'NOT_FOUND' });

      res.json(item);
    } catch (err) {
      logger.error(`Error getting enquiry requirement ${id}:`, err.stack || err);
      res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// --------------------------------------------------------------
// CREATE (POST /api/enquiry-requirements)
// Body may include motors: []
// --------------------------------------------------------------
router.post(
  '/',
  authenticateToken,
  checkPermission('EnquiryRequirements', 'can_write'),
  validateRequirementInput,
  async (req, res) => {
    const payload = {
      enquiryId: req.body.enquiryId,
      title: req.body.title,
      description: req.body.description,
      requirementType: req.body.requirementType,
      priority: req.body.priority,
      status: req.body.status,
      assigneeId: req.body.assigneeId,
      dueDate: req.body.dueDate,
      attachments: req.body.attachments || [],
      metadata: req.body.metadata || {},
      createdBy: req.user.user_id,
      motors: req.body.motors || []
    };

    try {
      const created = await EnquiryRequirements.create(payload);

      logger.info(`Created enquiry requirement ${created.id} by ${req.user.user_id}`);
      req.io?.emit('enquiryRequirement:created', created);

      res.status(201).json(created);
    } catch (err) {
      logger.error('Error creating enquiry requirement:', err.stack || err);
      res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// --------------------------------------------------------------
// UPDATE (PUT /api/enquiry-requirements/:id)
// If `motors` provided, existing motors will be replaced by model logic
// --------------------------------------------------------------
router.put(
  '/:id',
  authenticateToken,
  checkPermission('EnquiryRequirements', 'can_write'),
  validateRequirementInput,
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_INPUT' });

    const patch = {
      title: req.body.title,
      description: req.body.description,
      requirementType: req.body.requirementType,
      priority: req.body.priority,
      status: req.body.status,
      assigneeId: req.body.assigneeId,
      dueDate: req.body.dueDate,
      attachments: req.body.attachments,
      metadata: req.body.metadata,
      updatedBy: req.user.user_id,
      motors: req.body.motors // optional
    };

    try {
      const updated = await EnquiryRequirements.update(id, patch);
      logger.info(`Updated enquiry requirement ${id} by ${req.user.user_id}`);
      req.io?.emit('enquiryRequirement:updated', updated);
      res.json(updated);
    } catch (err) {
      if (err.message === 'Enquiry requirement not found') {
        return res.status(404).json({ error: 'Enquiry requirement not found', code: 'NOT_FOUND' });
      }
      logger.error(`Error updating enquiry requirement ${id}:`, err.stack || err);
      res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// --------------------------------------------------------------
// DELETE (DELETE /api/enquiry-requirements/:id)
// --------------------------------------------------------------
router.delete(
  '/:id',
  authenticateToken,
  checkPermission('EnquiryRequirements', 'can_delete'),
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_INPUT' });

    try {
      await EnquiryRequirements.delete(id);
      logger.info(`Deleted enquiry requirement ${id} by ${req.user.user_id}`);
      req.io?.emit('enquiryRequirement:deleted', { id });
      res.status(204).send();
    } catch (err) {
      if (err.message === 'Enquiry requirement not found') {
        return res.status(404).json({ error: 'Enquiry requirement not found', code: 'NOT_FOUND' });
      }
      logger.error(`Error deleting enquiry requirement ${id}:`, err.stack || err);
      res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// --------------------------------------------------------------
// MOTORS: granular endpoints
// - GET /:requirementId/motors
// - POST /:requirementId/motors
// - PUT /motors/:motorId
// - DELETE /motors/:motorId
// --------------------------------------------------------------
router.get(
  '/:requirementId/motors',
  authenticateToken,
  checkPermission('EnquiryRequirements', 'can_read'),
  async (req, res) => {
    const requirementId = parseInt(req.params.requirementId, 10);
    if (isNaN(requirementId)) return res.status(400).json({ error: 'Invalid requirement id', code: 'INVALID_INPUT' });

    try {
      const motors = await EnquiryRequirements.listMotors(requirementId);
      res.json(motors);
    } catch (err) {
      logger.error(`Error listing motors for requirement ${requirementId}:`, err.stack || err);
      res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

router.post(
  '/:requirementId/motors',
  authenticateToken,
  checkPermission('EnquiryRequirements', 'can_write'),
  async (req, res) => {
    const requirementId = parseInt(req.params.requirementId, 10);
    const m = req.body; // expect one motor object
    if (isNaN(requirementId)) return res.status(400).json({ error: 'Invalid requirement id', code: 'INVALID_INPUT' });

    // Basic motor validation
    if (m.motor_type !== undefined && m.motor_type !== null && !['BLDC','PMSM'].includes(m.motor_type)) {
      return res.status(400).json({ error: 'motor_type must be BLDC or PMSM', code: 'INVALID_INPUT' });
    }

    try {
      const motor = await EnquiryRequirements.addMotor(requirementId, m);
      logger.info(`Added motor ${motor.id} to requirement ${requirementId} by ${req.user.user_id}`);
      req.io?.emit('enquiryRequirement:motors:added', { requirementId, motor });
      res.status(201).json(motor);
    } catch (err) {
      logger.error(`Error adding motor to requirement ${requirementId}:`, err.stack || err);
      res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

router.put(
  '/motors/:motorId',
  authenticateToken,
  checkPermission('EnquiryRequirements', 'can_write'),
  async (req, res) => {
    const motorId = parseInt(req.params.motorId, 10);
    const m = req.body;
    if (isNaN(motorId)) return res.status(400).json({ error: 'Invalid motor id', code: 'INVALID_INPUT' });

    // Basic motor validation
    if (m.motor_type !== undefined && m.motor_type !== null && !['BLDC','PMSM'].includes(m.motor_type)) {
      return res.status(400).json({ error: 'motor_type must be BLDC or PMSM', code: 'INVALID_INPUT' });
    }

    try {
      const updated = await EnquiryRequirements.updateMotor(motorId, m);
      logger.info(`Updated motor ${motorId} by ${req.user.user_id}`);
      req.io?.emit('enquiryRequirement:motors:updated', updated);
      res.json(updated);
    } catch (err) {
      if (err.message === 'Motor not found') {
        return res.status(404).json({ error: 'Motor not found', code: 'NOT_FOUND' });
      }
      logger.error(`Error updating motor ${motorId}:`, err.stack || err);
      res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

router.delete(
  '/motors/:motorId',
  authenticateToken,
  checkPermission('EnquiryRequirements', 'can_delete'),
  async (req, res) => {
    const motorId = parseInt(req.params.motorId, 10);
    if (isNaN(motorId)) return res.status(400).json({ error: 'Invalid motor id', code: 'INVALID_INPUT' });

    try {
      await EnquiryRequirements.deleteMotor(motorId);
      logger.info(`Deleted motor ${motorId} by ${req.user.user_id}`);
      req.io?.emit('enquiryRequirement:motors:deleted', { motorId });
      res.status(204).send();
    } catch (err) {
      if (err.message === 'Motor not found') {
        return res.status(404).json({ error: 'Motor not found', code: 'NOT_FOUND' });
      }
      logger.error(`Error deleting motor ${motorId}:`, err.stack || err);
      res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

module.exports = router;
