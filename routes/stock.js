const express = require('express');
const Stock = require('../models/stock');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

const validateStockInput = (req, res, next) => {
  const { productName, description, productCode, price, stockQuantity, qtyRequired } = req.body;
  if (
    !productName || typeof productName !== 'string' ||
    (description && typeof description !== 'string') ||
    !productCode || typeof productCode !== 'string' ||
    !price || typeof price !== 'number' || price < 0 ||
    (stockQuantity !== undefined && (typeof stockQuantity !== 'number' || stockQuantity < 0)) ||
    (qtyRequired !== undefined && (typeof qtyRequired !== 'number' || qtyRequired < 0))
  ) {
    logger.warn(`Invalid input data for ${req.method} ${req.path}: ${JSON.stringify(req.body)}`);
    return res.status(400).json({ error: 'Invalid input data', code: 'INVALID_INPUT' });
  }
  next();
};

const validateAdjustInput = (req, res, next) => {
  const { quantity, reason } = req.body;
  if (
    !quantity || typeof quantity !== 'number' ||
    (reason && typeof reason !== 'string')
  ) {
    logger.warn(`Invalid adjust input for ${req.method} ${req.path}: ${JSON.stringify(req.body)}`);
    return res.status(400).json({ error: 'Invalid adjustment data', code: 'INVALID_INPUT' });
  }
  next();
};

router.get('/', authenticateToken, checkPermission('Stock', 'can_read'), async (req, res) => {
  const { limit = 10, offset = 0 } = req.query;
  try {
    const stockData = await Stock.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
    logger.info(`Fetched stock data`);
    res.json(stockData);
  } catch (error) {
    logger.error(`Error fetching stock: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
});

router.post('/', authenticateToken, checkPermission('Stock', 'can_write'), validateStockInput, async (req, res) => {
  const { productName, description, productCode, price, stockQuantity, qtyRequired } = req.body;
  try {
    const stockItem = await Stock.create({
      productName,
      description,
      productCode,
      price,
      stockQuantity,
      qtyRequired
    });
    logger.info(`Created stock item ${stockItem.productId} by ${req.user.user_id}`);
    req.io.emit('stockUpdate', { product_id: stockItem.productId, stock_quantity: stockItem.stockQuantity });
    res.status(201).json(stockItem);
  } catch (error) {
    logger.error(`Error creating stock: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
});

router.put('/:productId', authenticateToken, checkPermission('Stock', 'can_write'), validateStockInput, async (req, res) => {
  const { productId } = req.params;
  const { productName, description, productCode, price, stockQuantity, qtyRequired } = req.body;
  try {
    const stockItem = await Stock.update(parseInt(productId), {
      productName,
      description,
      productCode,
      price,
      stockQuantity,
      qtyRequired
    });
    logger.info(`Updated stock item ${productId} by ${req.user.user_id}`);
    req.io.emit('stockUpdate', { product_id: parseInt(productId), stock_quantity: stockItem.stockQuantity });
    res.json(stockItem);
  } catch (error) {
    if (error.message === 'Stock item not found') {
      logger.warn(`Stock item ${productId} not found`);
      return res.status(404).json({ error: 'Stock item not found', code: 'NOT_FOUND' });
    }
    logger.error(`Error updating stock ${productId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
});

router.delete('/:productId', authenticateToken, checkPermission('Stock', 'can_delete'), async (req, res) => {
  const { productId } = req.params;
  try {
    await Stock.delete(parseInt(productId));
    logger.info(`Deleted stock item ${productId} by ${req.user.user_id}`);
    req.io.emit('stockUpdate', { product_id: parseInt(productId), status: 'Deleted' });
    res.status(204).send();
  } catch (error) {
    if (error.message === 'Stock item not found') {
      logger.warn(`Stock item ${productId} not found`);
      return res.status(404).json({ error: 'Stock item not found', code: 'NOT_FOUND' });
    }
    logger.error(`Error deleting stock ${productId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
});

router.post('/:productId/adjust', authenticateToken, checkPermission('Stock', 'can_write'), validateAdjustInput, async (req, res) => {
  const { productId } = req.params;
  const { quantity, reason } = req.body;
  try {
    const stockItem = await Stock.adjustStock({
      productId: parseInt(productId),
      quantity,
      reason,
      userId: req.user.user_id
    });
    logger.info(`Adjusted stock for product ${productId} by ${quantity} by ${req.user.user_id}`);
    req.io.emit('stockUpdate', { product_id: parseInt(productId), stock_quantity: stockItem.stockQuantity });
    res.json(stockItem);
  } catch (error) {
    if (error.message === 'Stock item not found') {
      logger.warn(`Stock item ${productId} not found`);
      return res.status(404).json({ error: 'Stock item not found', code: 'NOT_FOUND' });
    }
    logger.error(`Error adjusting stock ${productId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
});

module.exports = router;