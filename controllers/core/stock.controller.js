const Stock = require('../../models/core/stock');
const pool = require('../../config/db');
const logger = require('../../utils/logger');
const { uploadBufferToDrive } = require('../../services/googleDrive');

exports.getAll = async (req, res) => {
  const { limit = 10, offset = 0 } = req.query;
  try {
    const stockData = await Stock.getAll({ limit: parseInt(limit, 10), offset: parseInt(offset, 10) });
    res.json(stockData);
  } catch (error) {
    logger.error(`Error fetching stock: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.create = async (req, res) => {
  const { productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl } = req.body;
  try {
    const stockItem = await Stock.create({ productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl });
    logger.info(`Created stock item ${stockItem.productId} by ${req.user.user_id}`);
    req.io?.emit('stockUpdate', { product_id: stockItem.productId, stock_quantity: stockItem.stockQuantity, location: stockItem.location, image_url: stockItem.imageUrl || null });
    res.status(201).json(stockItem);
  } catch (error) {
    logger.error(`Error creating stock: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.update = async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  const { productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl } = req.body;
  try {
    const stockItem = await Stock.update(productId, { productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl });
    logger.info(`Updated stock item ${productId} by ${req.user.user_id}`);
    req.io?.emit('stockUpdate', { product_id: productId, stock_quantity: stockItem.stockQuantity, location: stockItem.location, image_url: stockItem.imageUrl || null });
    res.json(stockItem);
  } catch (error) {
    if (error.message === 'Stock item not found') return res.status(404).json({ error: 'Stock item not found', code: 'NOT_FOUND' });
    logger.error(`Error updating stock ${productId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.uploadPhoto = async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (isNaN(productId)) return res.status(400).json({ success: false, message: 'Invalid product ID' });
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(req.file.mimetype)) return res.status(400).json({ success: false, message: 'Invalid file type. Allowed: JPEG, PNG, WebP, GIF' });
    const ext = req.file.mimetype.includes('png') ? 'png' : req.file.mimetype.includes('webp') ? 'webp' : req.file.mimetype.includes('gif') ? 'gif' : 'jpg';
    const filename = `raw_${productId}_${Date.now()}.${ext}`;
    const { directUrl, id: fileId } = await uploadBufferToDrive(req.file.buffer, req.file.mimetype, filename);
    const { rows } = await pool.query(
      'UPDATE raw_materials SET image_url = $1 WHERE product_id = $2 RETURNING product_id AS "productId", stock_quantity AS "stockQuantity", location AS "location", image_url AS "imageUrl"',
      [directUrl, productId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Product not found' });
    const updated = rows[0];
    req.io?.emit('stockUpdate', { product_id: updated.productId, stock_quantity: updated.stockQuantity, location: updated.location, image_url: updated.imageUrl });
    return res.json({ success: true, message: 'Photo uploaded successfully', ...updated, fileId });
  } catch (err) {
    logger.error(`Photo upload failed for product ${productId}:`, err.stack || err);
    return res.status(500).json({ success: false, message: 'Upload failed', detail: err.message });
  }
};

exports.delete = async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  try {
    await Stock.delete(productId);
    logger.info(`Deleted stock item ${productId} by ${req.user.user_id}`);
    req.io?.emit('stockUpdate', { product_id: productId, status: 'deleted' });
    res.status(204).send();
  } catch (error) {
    if (error.message === 'Stock item not found') return res.status(404).json({ error: 'Stock item not found', code: 'NOT_FOUND' });
    logger.error(`Error deleting stock ${productId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.adjust = async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  const { quantity, reason } = req.body;
  try {
    const stockItem = await Stock.adjustStock({ productId, quantity, reason, userId: req.user.user_id });
    logger.info(`Adjusted stock for product ${productId} by ${quantity} (by ${req.user.user_id})`);
    req.io?.emit('stockUpdate', { product_id: productId, stock_quantity: stockItem.stockQuantity });
    res.json(stockItem);
  } catch (error) {
    if (error.message === 'Stock item not found') return res.status(404).json({ error: 'Stock item not found', code: 'NOT_FOUND' });
    logger.error(`Error adjusting stock ${productId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};
