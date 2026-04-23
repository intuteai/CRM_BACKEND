const PartDrawingsRaw = require('../../models/manufacturing/partDrawingsRaw');
const redis = require('../../config/redis');
const logger = require('../../utils/logger');

async function deleteByPattern(pattern) {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) { await redis.del(keys); logger.info(`Invalidated ${keys.length} cache keys matching: ${pattern}`); }
}

(async () => {
  await deleteByPattern('part_drawings_raw_*');
  await deleteByPattern('raw_materials_*');
  logger.info('Cleared all part_drawings_raw and raw_materials caches');
})();

exports.getAll = async (req, res) => {
  const { limit = 10, offset = 0, force_refresh = false, search = '' } = req.query;
  const cacheKey = `part_drawings_raw_${limit}_${offset}_${search}`;
  try {
    if (force_refresh === 'true') {
      await redis.del(cacheKey);
      const result = await PartDrawingsRaw.getAll({ limit: parseInt(limit), offset: parseInt(offset), search });
      await redis.setEx(cacheKey, 300, JSON.stringify(result));
      return res.json(result);
    }
    const cached = await redis.get(cacheKey);
    if (cached) { logger.info(`Cache hit for ${cacheKey}`); return res.json(JSON.parse(cached)); }
    const result = await PartDrawingsRaw.getAll({ limit: parseInt(limit), offset: parseInt(offset), search });
    await redis.setEx(cacheKey, 300, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    logger.error(`Error fetching raw part drawings: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.create = async (req, res) => {
  const { drawing_link, product_id } = req.body;
  try {
    const newDrawing = await PartDrawingsRaw.create({ drawing_link, product_id });
    await deleteByPattern('part_drawings_raw_*');
    await deleteByPattern('raw_materials_*');
    req.io.emit('partDrawingsRawUpdate', { type: 'CREATE', item: newDrawing, timestamp: new Date().toISOString() });
    res.status(201).json(newDrawing);
  } catch (error) {
    logger.error(`Error creating raw part drawing: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message });
  }
};

exports.update = async (req, res) => {
  const { srNo } = req.params;
  const { drawing_link, product_id } = req.body;
  const updateData = {};
  if (drawing_link !== undefined) updateData.drawing_link = drawing_link;
  if (product_id !== undefined) updateData.product_id = product_id;
  try {
    const updatedDrawing = await PartDrawingsRaw.update(srNo, updateData);
    await deleteByPattern('part_drawings_raw_*');
    await deleteByPattern('raw_materials_*');
    req.io.emit('partDrawingsRawUpdate', { type: 'UPDATE', item: updatedDrawing, timestamp: new Date().toISOString() });
    res.json(updatedDrawing);
  } catch (error) {
    logger.error(`Error updating raw part drawing: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message });
  }
};

exports.delete = async (req, res) => {
  const { srNo } = req.params;
  try {
    const deletedItem = await PartDrawingsRaw.delete(srNo);
    await deleteByPattern('part_drawings_raw_*');
    await deleteByPattern('raw_materials_*');
    req.io.emit('partDrawingsRawUpdate', { type: 'DELETE', itemId: srNo, timestamp: new Date().toISOString() });
    res.status(200).json({ message: 'Raw part drawing deleted successfully', deletedItem });
  } catch (error) {
    logger.error(`Error deleting raw part drawing: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message });
  }
};
