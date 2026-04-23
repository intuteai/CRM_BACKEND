const Parts = require('../../models/manufacturing/parts');
const logger = require('../../utils/logger');

exports.getAll = async (req, res) => {
  const { limit = 10, offset = 0 } = req.query;
  try {
    const parts = await Parts.getAll({ limit: parseInt(limit, 10), offset: parseInt(offset, 10) });
    res.json(parts);
  } catch (error) {
    logger.error('Error fetching parts:', error.stack || error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.getPartTypes = async (req, res) => {
  try {
    const types = await Parts.getPartTypes();
    res.json(types);
  } catch (error) {
    logger.error('Error fetching part types:', error.stack || error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.previewNextCode = async (req, res) => {
  const partTypeId = parseInt(req.query.partTypeId, 10);
  if (isNaN(partTypeId)) return res.status(400).json({ error: 'Invalid partTypeId', code: 'INVALID_INPUT' });
  try {
    const preview = await Parts.previewNextCode(partTypeId);
    res.json(preview);
  } catch (error) {
    if (error.code === 'INVALID_PART_TYPE') return res.status(400).json({ error: 'Invalid part type', code: 'INVALID_PART_TYPE' });
    logger.error('Error previewing next part code:', error.stack || error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.create = async (req, res) => {
  const { partTypeId, name, description, drawingNo, customerPartNo, supplierPartNo } = req.body;
  try {
    const part = await Parts.create({ partTypeId, name, description, drawingNo, customerPartNo, supplierPartNo });
    logger.info(`Created part ${part.partCode} (id=${part.id}) by user ${req.user.user_id}`);
    res.status(201).json(part);
  } catch (error) {
    if (error.message === 'Invalid part type' || error.code === 'INVALID_PART_TYPE') return res.status(400).json({ error: 'Invalid part type', code: 'INVALID_PART_TYPE' });
    logger.error('Error creating part:', error.stack || error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.update = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid part id', code: 'INVALID_INPUT' });
  const { name, description, drawingNo, customerPartNo, supplierPartNo } = req.body;
  try {
    const part = await Parts.update(id, { name, description, drawingNo, customerPartNo, supplierPartNo });
    logger.info(`Updated part ${id} by user ${req.user.user_id}`);
    res.json(part);
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'Part not found', code: 'NOT_FOUND' });
    logger.error(`Error updating part ${id}:`, error.stack || error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.delete = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid part id', code: 'INVALID_INPUT' });
  try {
    await Parts.delete(id);
    logger.info(`Deleted part ${id} by user ${req.user.user_id}`);
    res.status(204).send();
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'Part not found', code: 'NOT_FOUND' });
    logger.error(`Error deleting part ${id}:`, error.stack || error);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};
