const EnquiryRequirements = require('../../models/sales/enquiryRequirements');
const logger = require('../../utils/logger');

exports.getAll = async (req, res) => {
  const { limit = 10, offset = 0, enquiryId, status, priority, assigneeId } = req.query;
  try {
    const data = await EnquiryRequirements.getAll({ limit: parseInt(limit, 10), offset: parseInt(offset, 10), enquiryId: enquiryId !== undefined ? parseInt(enquiryId, 10) : undefined, status, priority, assigneeId: assigneeId !== undefined ? parseInt(assigneeId, 10) : undefined });
    res.json(data);
  } catch (err) {
    logger.error('Error fetching enquiry requirements:', err.stack || err);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.getOne = async (req, res) => {
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
};

exports.create = async (req, res) => {
  const payload = { enquiryId: req.body.enquiryId, title: req.body.title, description: req.body.description, requirementType: req.body.requirementType, priority: req.body.priority, status: req.body.status, assigneeId: req.body.assigneeId, dueDate: req.body.dueDate, attachments: req.body.attachments || [], metadata: req.body.metadata || {}, createdBy: req.user.user_id, motors: req.body.motors || [] };
  try {
    const created = await EnquiryRequirements.create(payload);
    logger.info(`Created enquiry requirement ${created.id} by ${req.user.user_id}`);
    req.io?.emit('enquiryRequirement:created', created);
    res.status(201).json(created);
  } catch (err) {
    logger.error('Error creating enquiry requirement:', err.stack || err);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.update = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_INPUT' });
  const patch = { title: req.body.title, description: req.body.description, requirementType: req.body.requirementType, priority: req.body.priority, status: req.body.status, assigneeId: req.body.assigneeId, dueDate: req.body.dueDate, attachments: req.body.attachments, metadata: req.body.metadata, updatedBy: req.user.user_id, motors: req.body.motors };
  try {
    const updated = await EnquiryRequirements.update(id, patch);
    logger.info(`Updated enquiry requirement ${id} by ${req.user.user_id}`);
    req.io?.emit('enquiryRequirement:updated', updated);
    res.json(updated);
  } catch (err) {
    if (err.message === 'Enquiry requirement not found') return res.status(404).json({ error: 'Enquiry requirement not found', code: 'NOT_FOUND' });
    logger.error(`Error updating enquiry requirement ${id}:`, err.stack || err);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.delete = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_INPUT' });
  try {
    await EnquiryRequirements.delete(id);
    logger.info(`Deleted enquiry requirement ${id} by ${req.user.user_id}`);
    req.io?.emit('enquiryRequirement:deleted', { id });
    res.status(204).send();
  } catch (err) {
    if (err.message === 'Enquiry requirement not found') return res.status(404).json({ error: 'Enquiry requirement not found', code: 'NOT_FOUND' });
    logger.error(`Error deleting enquiry requirement ${id}:`, err.stack || err);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.listMotors = async (req, res) => {
  const requirementId = parseInt(req.params.requirementId, 10);
  if (isNaN(requirementId)) return res.status(400).json({ error: 'Invalid requirement id', code: 'INVALID_INPUT' });
  try {
    const motors = await EnquiryRequirements.listMotors(requirementId);
    res.json(motors);
  } catch (err) {
    logger.error(`Error listing motors for requirement ${requirementId}:`, err.stack || err);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.addMotor = async (req, res) => {
  const requirementId = parseInt(req.params.requirementId, 10);
  if (isNaN(requirementId)) return res.status(400).json({ error: 'Invalid requirement id', code: 'INVALID_INPUT' });
  try {
    const motor = await EnquiryRequirements.addMotor(requirementId, req.body);
    logger.info(`Added motor ${motor.id} to requirement ${requirementId} by ${req.user.user_id}`);
    req.io?.emit('enquiryRequirement:motors:added', { requirementId, motor });
    res.status(201).json(motor);
  } catch (err) {
    logger.error(`Error adding motor to requirement ${requirementId}:`, err.stack || err);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.updateMotor = async (req, res) => {
  const motorId = parseInt(req.params.motorId, 10);
  if (isNaN(motorId)) return res.status(400).json({ error: 'Invalid motor id', code: 'INVALID_INPUT' });
  try {
    const updated = await EnquiryRequirements.updateMotor(motorId, req.body);
    logger.info(`Updated motor ${motorId} by ${req.user.user_id}`);
    req.io?.emit('enquiryRequirement:motors:updated', updated);
    res.json(updated);
  } catch (err) {
    if (err.message === 'Motor not found') return res.status(404).json({ error: 'Motor not found', code: 'NOT_FOUND' });
    logger.error(`Error updating motor ${motorId}:`, err.stack || err);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.deleteMotor = async (req, res) => {
  const motorId = parseInt(req.params.motorId, 10);
  if (isNaN(motorId)) return res.status(400).json({ error: 'Invalid motor id', code: 'INVALID_INPUT' });
  try {
    await EnquiryRequirements.deleteMotor(motorId);
    logger.info(`Deleted motor ${motorId} by ${req.user.user_id}`);
    req.io?.emit('enquiryRequirement:motors:deleted', { motorId });
    res.status(204).send();
  } catch (err) {
    if (err.message === 'Motor not found') return res.status(404).json({ error: 'Motor not found', code: 'NOT_FOUND' });
    logger.error(`Error deleting motor ${motorId}:`, err.stack || err);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};
