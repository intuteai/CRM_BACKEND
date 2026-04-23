const PriceList = require('../../models/sales/priceList');
const redis = require('../../config/redis');
const logger = require('../../utils/logger');

async function deleteByPattern(pattern) {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) { await redis.del(keys); logger.info(`Invalidated ${keys.length} cache keys matching: ${pattern}`); }
}

exports.getAll = async (req, res) => {
  const { limit = 10, offset = 0, search = '', force_refresh = false } = req.query;
  const cacheKey = `price_list_${limit}_${offset}_${search}`;
  try {
    if (force_refresh === 'true') {
      await redis.del(cacheKey);
      const priceList = await PriceList.getAll({ limit: parseInt(limit), offset: parseInt(offset), search });
      await redis.setEx(cacheKey, 300, JSON.stringify(priceList));
      return res.json(priceList);
    }
    const cached = await redis.get(cacheKey);
    if (cached) { logger.info(`Cache hit for ${cacheKey}`); return res.json(JSON.parse(cached)); }
    const priceList = await PriceList.getAll({ limit: parseInt(limit), offset: parseInt(offset), search });
    await redis.setEx(cacheKey, 300, JSON.stringify(priceList));
    res.json(priceList);
  } catch (error) {
    logger.error(`Error fetching price list: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.create = async (req, res) => {
  const { item_description, price, product_id } = req.body;
  try {
    const newPrice = await PriceList.create({ item_description, price, product_id });
    await deleteByPattern('price_list_*');
    await deleteByPattern('inventory_*');
    req.io.emit('priceListUpdate', { type: 'CREATE', item: newPrice, timestamp: new Date().toISOString() });
    res.status(201).json(newPrice);
  } catch (error) {
    logger.error(`Error creating price list item: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message, code: 'INVALID_INPUT' });
  }
};

exports.update = async (req, res) => {
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
    req.io.emit('priceListUpdate', { type: 'UPDATE', item: updatedPrice, timestamp: new Date().toISOString() });
    res.json(updatedPrice);
  } catch (error) {
    logger.error(`Error updating price list item: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message, code: 'INVALID_INPUT' });
  }
};

exports.delete = async (req, res) => {
  const { priceId } = req.params;
  try {
    const deletedItem = await PriceList.delete(priceId);
    await deleteByPattern('price_list_*');
    await deleteByPattern('inventory_*');
    req.io.emit('priceListUpdate', { type: 'DELETE', itemId: priceId, timestamp: new Date().toISOString() });
    res.status(200).json({ message: 'Price list item deleted successfully', deletedItem });
  } catch (error) {
    logger.error(`Error deleting price list item: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message, code: 'INVALID_INPUT' });
  }
};
