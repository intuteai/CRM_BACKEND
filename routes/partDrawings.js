const express = require('express');
const PartDrawings = require('../models/partDrawings');
const redis = require('../config/redis');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

// Helper function for Redis pattern-based deletion
const deleteByPattern = async (pattern) => {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(keys);
    logger.info(`Invalidated ${keys.length} cache keys matching pattern: ${pattern}`);
    return keys.length;
  }
  return 0;
};

// Clear all caches on startup
const clearAllCaches = async () => {
  await deleteByPattern('part_drawings_*');
  await deleteByPattern('inventory_*');
  logger.info('Cleared all part_drawings and inventory caches');
};

// Execute cache clearing on startup
clearAllCaches();

// GET all part drawings
router.get('/', authenticateToken, async (req, res) => {
  const { limit = 10, offset = 0, force_refresh = false, search = '' } = req.query;
  const cacheKey = `part_drawings_${limit}_${offset}_${search}`;

  try {
    // Handle force refresh
    if (force_refresh === 'true') {
      await redis.del(cacheKey);
      logger.info(`Cache invalidated for ${cacheKey} due to force refresh`);
      
      const result = await PartDrawings.getAll({ limit: parseInt(limit), offset: parseInt(offset), search });
      await redis.setEx(cacheKey, 300, JSON.stringify(result));
      logger.info(`Fresh data cached for ${cacheKey}`);
      return res.json(result);
    }

    // Try cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    // Cache miss
    logger.info(`Cache miss for ${cacheKey}, fetching from database`);
    const result = await PartDrawings.getAll({ limit: parseInt(limit), offset: parseInt(offset), search });
    await redis.setEx(cacheKey, 300, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    logger.error(`Error fetching part drawings: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST a new part drawing
router.post('/', authenticateToken, async (req, res) => {
  const { drawing_link, product_id } = req.body;
  try {
    const newDrawing = await PartDrawings.create({ drawing_link, product_id });
    
    // Invalidate caches
    await deleteByPattern('part_drawings_*');
    await deleteByPattern('inventory_*');
    
    // Emit socket event
    req.io.emit('partDrawingsUpdate', { 
      type: 'CREATE', 
      item: newDrawing,
      timestamp: new Date().toISOString()
    });
    
    res.status(201).json(newDrawing);
  } catch (error) {
    logger.error(`Error creating part drawing: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message });
  }
});

// PUT update an existing part drawing
router.put('/:srNo', authenticateToken, async (req, res) => {
  const { srNo } = req.params;
  const { drawing_link, product_id } = req.body;
  
  // Create update object with only provided fields
  const updateData = {};
  if (drawing_link !== undefined) updateData.drawing_link = drawing_link;
  if (product_id !== undefined) updateData.product_id = product_id;
  
  try {
    const updatedDrawing = await PartDrawings.update(srNo, updateData);
    
    // Invalidate caches
    await deleteByPattern('part_drawings_*');
    await deleteByPattern('inventory_*');
    
    // Emit socket event
    req.io.emit('partDrawingsUpdate', { 
      type: 'UPDATE', 
      item: updatedDrawing,
      timestamp: new Date().toISOString()
    });
    
    res.json(updatedDrawing);
  } catch (error) {
    logger.error(`Error updating part drawing: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message });
  }
});

// DELETE a part drawing
router.delete('/:srNo', authenticateToken, async (req, res) => {
  const { srNo } = req.params;
  try {
    const deletedItem = await PartDrawings.delete(srNo);
    
    // Invalidate caches
    await deleteByPattern('part_drawings_*');
    await deleteByPattern('inventory_*');
    
    // Emit socket event
    req.io.emit('partDrawingsUpdate', { 
      type: 'DELETE', 
      itemId: srNo,
      timestamp: new Date().toISOString()
    });
    
    res.status(200).json({ message: 'Part drawing deleted successfully', deletedItem });
  } catch (error) {
    logger.error(`Error deleting part drawing: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;