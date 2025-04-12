const express = require('express');
const Stock = require('../models/stock');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

const ensureAdmin = (req, res, next) => {
  logger.info(`Checking admin access for user ${req.user.id} with role_id ${req.user.role_id}`);
  if (req.user.role_id !== 1) {
    logger.warn(`Unauthorized access attempt by user ${req.user.id} to ${req.path}`);
    return res.status(403).json({ error: 'Access restricted to admin only' });
  }
  next();
};

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
    return res.status(400).json({ error: 'Invalid input data' });
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
    return res.status(400).json({ error: 'Invalid adjustment data' });
  }
  next();
};

router.get('/', authenticateToken, ensureAdmin, async (req, res) => {
  const { limit = 10, offset = 0 } = req.query;
  try {
    const stockData = await Stock.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
    logger.info('Stock data fetched successfully');
    res.json(stockData);
  } catch (error) {
    logger.error(`Error fetching stock: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/', authenticateToken, ensureAdmin, validateStockInput, async (req, res) => {
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
    logger.info(`Created stock item ${stockItem.productId}`);
    req.io.emit('stockUpdate', { product_id: stockItem.productId, stock_quantity: stockItem.stockQuantity });
    res.status(201).json(stockItem);
  } catch (error) {
    logger.error(`Error creating stock: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.put('/:productId', authenticateToken, ensureAdmin, validateStockInput, async (req, res) => {
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
    logger.info(`Updated stock item ${productId}`);
    req.io.emit('stockUpdate', { product_id: parseInt(productId), stock_quantity: stockItem.stockQuantity });
    res.json(stockItem);
  } catch (error) {
    if (error.message === 'Stock item not found') {
      logger.warn(`Stock item ${productId} not found`);
      return res.status(404).json({ error: 'Stock item not found' });
    }
    logger.error(`Error updating stock ${productId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.delete('/:productId', authenticateToken, ensureAdmin, async (req, res) => {
  const { productId } = req.params;
  try {
    await Stock.delete(parseInt(productId));
    logger.info(`Deleted stock item ${productId}`);
    req.io.emit('stockUpdate', { product_id: parseInt(productId), status: 'Deleted' });
    res.status(204).send();
  } catch (error) {
    if (error.message === 'Stock item not found') {
      logger.warn(`Stock item ${productId} not found`);
      return res.status(404).json({ error: 'Stock item not found' });
    }
    logger.error(`Error deleting stock ${productId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/:productId/adjust', authenticateToken, ensureAdmin, validateAdjustInput, async (req, res) => {
  const { productId } = req.params;
  const { quantity, reason } = req.body;
  try {
    const stockItem = await Stock.adjustStock({
      productId: parseInt(productId),
      quantity,
      reason,
      userId: req.user.id
    });
    logger.info(`Adjusted stock for product ${productId} by ${quantity}`);
    req.io.emit('stockUpdate', { product_id: parseInt(productId), stock_quantity: stockItem.stockQuantity });
    res.json(stockItem);
  } catch (error) {
    if (error.message === 'Stock item not found') {
      logger.warn(`Stock item ${productId} not found`);
      return res.status(404).json({ error: 'Stock item not found' });
    }
    logger.error(`Error adjusting stock ${productId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;