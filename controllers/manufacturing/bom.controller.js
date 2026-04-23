const BOM = require('../../models/manufacturing/bom');
const redis = require('../../config/redis');
const logger = require('../../utils/logger');
const pool = require('../../config/db');
const { validationResult } = require('express-validator');

async function invalidateBOMCache() {
  try {
    const keys = await redis.keys('bom_list_*');
    if (keys.length > 0) { await redis.del(keys); logger.info(`Invalidated ${keys.length} BOM cache keys`); }
  } catch (error) {
    logger.error(`Failed to invalidate BOM cache: ${error.message}`, { stack: error.stack });
  }
}

exports.getAll = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { limit = 10, offset = 0, force_refresh = false } = req.query;
  const cacheKey = `bom_list_${limit}_${offset}`;
  try {
    if (force_refresh === 'true') await invalidateBOMCache();
    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') { logger.info(`Cache hit for ${cacheKey}`); return res.json(JSON.parse(cached)); }
    const boms = await BOM.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
    const { rows } = await pool.query('SELECT COUNT(*) AS total FROM bill_of_materials');
    const response = { data: boms, total: parseInt(rows[0].total) };
    await redis.setEx(cacheKey, 300, JSON.stringify(response));
    res.json(response);
  } catch (error) {
    logger.error(`Error fetching BOMs: ${error.message}`, { stack: error.stack });
    res.status(500).json({ error: 'Failed to fetch BOMs' });
  }
};

exports.getOne = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const bom = await BOM.getById(req.params.id);
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    res.json(bom);
  } catch (error) {
    logger.error(`Error fetching BOM ${req.params.id}: ${error.message}`, { stack: error.stack });
    res.status(500).json({ error: 'Failed to fetch BOM' });
  }
};

exports.create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { productId, materials } = req.body;
  try {
    const bom = await BOM.create({ productId, materials });
    await invalidateBOMCache();
    req.io.emit('bom:created', { ...bom, triggeredBy: req.user.user_id || 'unknown' });
    res.status(201).json(bom);
  } catch (error) {
    logger.error(`Error creating BOM: ${error.message}`, { stack: error.stack });
    if (error.message.includes('foreign key constraint') || error.message.includes('No price found')) {
      return res.status(400).json({ error: 'Invalid productId or materialId' });
    }
    res.status(500).json({ error: 'Failed to create BOM' });
  }
};

exports.update = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { id } = req.params;
  const { productId, materials } = req.body;
  try {
    const bom = await BOM.update(id, { productId, materials });
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    await invalidateBOMCache();
    req.io.emit('bom:updated', { ...bom, triggeredBy: req.user.user_id || 'unknown' });
    res.json(bom);
  } catch (error) {
    logger.error(`Error updating BOM ${id}: ${error.message}`, { stack: error.stack });
    if (error.message.includes('foreign key constraint') || error.message.includes('No price found')) {
      return res.status(400).json({ error: 'Invalid productId or materialId' });
    }
    res.status(500).json({ error: 'Failed to update BOM' });
  }
};

exports.delete = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { id } = req.params;
  try {
    const bom = await BOM.delete(id);
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    await invalidateBOMCache();
    req.io.emit('bom:deleted', { bomId: bom.bomId, triggeredBy: req.user.user_id || 'unknown' });
    res.json({ message: 'BOM deleted successfully', bomId: bom.bomId });
  } catch (error) {
    logger.error(`Error deleting BOM ${id}: ${error.message}`, { stack: error.stack });
    res.status(500).json({ error: 'Failed to delete BOM' });
  }
};
