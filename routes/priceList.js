const express = require('express');
const PriceList = require('../models/priceList');
const redis = require('../config/redis');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

const ensureAdmin = (req, res, next) => {
  if (req.user.role_id !== 1) {
    return res.status(403).json({ error: 'Access restricted to admin only' });
  }
  next();
};

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

// GET all price list items
router.get('/', authenticateToken, ensureAdmin, async (req, res) => {
  const { limit = 10, offset = 0, force_refresh = false } = req.query;
  const cacheKey = `price_list_${limit}_${offset}`;

  try {
    // Handle force refresh by completely bypassing cache
    if (force_refresh === 'true') {
      await redis.del(cacheKey);
      logger.info(`Cache invalidated for ${cacheKey} due to force refresh`);
      
      const priceList = await PriceList.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
      await redis.setEx(cacheKey, 300, JSON.stringify(priceList));
      logger.info(`Fresh data cached for ${cacheKey}`);
      return res.json(priceList);
    }

    // Try to get from cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    // Cache miss - fetch from database
    logger.info(`Cache miss for ${cacheKey}, fetching from database`);
    const priceList = await PriceList.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
    await redis.setEx(cacheKey, 300, JSON.stringify(priceList));
    res.json(priceList);
  } catch (error) {
    logger.error(`Error fetching price list: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST a new price list item
router.post('/', authenticateToken, ensureAdmin, async (req, res) => {
  const { item_description, price, product_id } = req.body;
  try {
    const newPrice = await PriceList.create({ item_description, price, product_id });
    
    // Invalidate all price list and inventory related caches
    await deleteByPattern('price_list_*');
    await deleteByPattern('inventory_*');
    
    // Emit socket event only after cache is invalidated
    req.io.emit('priceListUpdate', { 
      type: 'CREATE', 
      item: newPrice,
      timestamp: new Date().toISOString()
    });
    
    res.status(201).json(newPrice);
  } catch (error) {
    logger.error(`Error creating price list item: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message });
  }
});

// PUT update an existing price list item
router.put('/:priceId', authenticateToken, ensureAdmin, async (req, res) => {
  const { priceId } = req.params;
  const { item_description, price, product_id } = req.body;
  
  // Create update object with only provided fields
  const updateData = {};
  if (item_description !== undefined) updateData.item_description = item_description;
  if (price !== undefined) updateData.price = price;
  if (product_id !== undefined) updateData.product_id = product_id;
  
  try {
    const updatedPrice = await PriceList.update(priceId, updateData);
    
    // Invalidate caches
    await deleteByPattern('price_list_*');
    await deleteByPattern('inventory_*');
    
    // Emit socket event after cache invalidation
    req.io.emit('priceListUpdate', { 
      type: 'UPDATE', 
      item: updatedPrice,
      timestamp: new Date().toISOString()
    });
    
    res.json(updatedPrice);
  } catch (error) {
    logger.error(`Error updating price list item: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message });
  }
});

// DELETE a price list item
router.delete('/:priceId', authenticateToken, ensureAdmin, async (req, res) => {
  const { priceId } = req.params;
  try {
    const deletedItem = await PriceList.delete(priceId);
    
    // Invalidate caches
    await deleteByPattern('price_list_*');
    await deleteByPattern('inventory_*');
    
    // Emit socket event after cache invalidation
    req.io.emit('priceListUpdate', { 
      type: 'DELETE', 
      itemId: priceId,
      timestamp: new Date().toISOString()
    });
    
    res.status(200).json({ message: 'Price list item deleted successfully', deletedItem });
  } catch (error) {
    logger.error(`Error deleting price list item: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;