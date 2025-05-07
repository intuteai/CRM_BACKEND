const express = require('express');
const PriceList = require('../models/priceList');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

const deleteByPattern = async (pattern) => {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(keys);
    logger.info(`Invalidated ${keys.length} cache keys matching pattern: ${pattern}`);
    return keys.length;
  }
  return 0;
};

router.get('/', authenticateToken, checkPermission('PriceList', 'can_read'), async (req, res) => {
  const { limit = 10, offset = 0, force_refresh = false } = req.query;
  const cacheKey = `price_list_${limit}_${offset}`;

  try {
    if (force_refresh === 'true') {
      await redis.del(cacheKey);
      logger.info(`Cache invalidated for ${cacheKey} due to force refresh`);
      
      const priceList = await PriceList.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
      await redis.setEx(cacheKey, 300, JSON.stringify(priceList));
      logger.info(`Fresh data cached for ${cacheKey}`);
      return res.json(priceList);
    }

    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    logger.info(`Cache miss for ${cacheKey}, fetching from database`);
    const priceList = await PriceList.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
    await redis.setEx(cacheKey, 300, JSON.stringify(priceList));
    res.json(priceList);
  } catch (error) {
    logger.error(`Error fetching price list: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
});

router.post('/', authenticateToken, checkPermission('PriceList', 'can_write'), async (req, res) => {
  const { item_description, price, product_id } = req.body;
  try {
    const newPrice = await PriceList.create({ item_description, price, product_id });
    
    await deleteByPattern('price_list_*');
    await deleteByPattern('inventory_*');
    
    req.io.emit('priceListUpdate', { 
      type: 'CREATE', 
      item: newPrice,
      timestamp: new Date().toISOString()
    });
    
    res.status(201).json(newPrice);
  } catch (error) {
    logger.error(`Error creating price list item: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message, code: 'INVALID_INPUT' });
  }
});

router.put('/:priceId', authenticateToken, checkPermission('PriceList', 'can_write'), async (req, res) => {
  const { priceId } = req.params;
  const { item_description, price, product_id } = req.body;
  
  const updateData = {};
  if (item_description !== undefined) updateData.item_description = item_description;
  if (price !== undefined) updateData.price = price;
  if (product_id !== undefined) updateData.product_id = product_id;
  
  try {
    const updatedPrice = await PriceList.update(priceId, updateData);
    
    await deleteByPattern('price_list_*');
    await deleteByPattern('inventory_*');
    
    req.io.emit('priceListUpdate', { 
      type: 'UPDATE', 
      item: updatedPrice,
      timestamp: new Date().toISOString()
    });
    
    res.json(updatedPrice);
  } catch (error) {
    logger.error(`Error updating price list item: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message, code: 'INVALID_INPUT' });
  }
});

router.delete('/:priceId', authenticateToken, checkPermission('PriceList', 'can_delete'), async (req, res) => {
  const { priceId } = req.params;
  try {
    const deletedItem = await PriceList.delete(priceId);
    
    await deleteByPattern('price_list_*');
    await deleteByPattern('inventory_*');
    
    req.io.emit('priceListUpdate', { 
      type: 'DELETE', 
      itemId: priceId,
      timestamp: new Date().toISOString()
    });
    
    res.status(200).json({ message: 'Price list item deleted successfully', deletedItem });
  } catch (error) {
    logger.error(`Error deleting price list item: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message, code: 'INVALID_INPUT' });
  }
});

module.exports = router;