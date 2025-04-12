const express = require('express');
const PurchaseInvoice = require('../models/purchaseInvoice');
const redis = require('../config/redis');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const pool = require('../config/db');
const router = express.Router({ mergeParams: true });

// Admin middleware
const ensureAdmin = (req, res, next) => {
  logger.info(`Checking admin access for user ${req.user.id} with role_id ${req.user.role_id}`);
  if (req.user.role_id !== 1) {
    logger.warn(`Unauthorized access attempt by user ${req.user.id} to ${req.path}`);
    return res.status(403).json({ error: 'Access restricted to admin only' });
  }
  next();
};

// Validate input
const validateInvoiceInput = (req, res, next) => {
  const { supplierCode, supplierName, invoiceNumber, issueDate, description, unitPrice, quantity, linkPdf, productId } = req.body;
  if (
    !supplierCode || typeof supplierCode !== 'string' ||
    !supplierName || typeof supplierName !== 'string' ||
    !invoiceNumber || typeof invoiceNumber !== 'string' ||
    !issueDate || isNaN(Date.parse(issueDate)) ||
    !description || typeof description !== 'string' ||
    !unitPrice || typeof unitPrice !== 'number' || unitPrice < 0 ||
    !quantity || typeof quantity !== 'number' || quantity < 0 ||
    (linkPdf && typeof linkPdf !== 'string') ||
    !productId || typeof productId !== 'number' || productId < 1
  ) {
    logger.warn(`Invalid input data for ${req.method} ${req.path}: ${JSON.stringify(req.body)}`);
    return res.status(400).json({ error: 'Invalid input data' });
  }
  next();
};

// GET all invoices
router.get('/', authenticateToken, ensureAdmin, async (req, res) => {
  const { limit = 10, offset = 0, force_refresh = false } = req.query;
  const cacheKey = `purchase_invoices_${limit}_${offset}`;
  logger.info(`GET /api/purchase-invoices called with limit=${limit}, offset=${offset}`);
  try {
    if (force_refresh === 'true') {
      await redis.del(cacheKey);
    }
    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }
    const invoices = await PurchaseInvoice.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
    await redis.setEx(cacheKey, 300, JSON.stringify(invoices));
    res.json(invoices);
  } catch (error) {
    logger.error(`Error fetching invoices: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST new invoice
router.post('/', authenticateToken, ensureAdmin, validateInvoiceInput, async (req, res) => {
  const { supplierCode, supplierName, invoiceNumber, issueDate, description, unitPrice, quantity, linkPdf, productId } = req.body;
  try {
    const invoice = await PurchaseInvoice.create({
      supplierCode,
      supplierName,
      invoiceNumber,
      issueDate,
      description,
      unitPrice,
      quantity,
      linkPdf,
      productId
    });
    const stockQuery = 'SELECT stock_quantity FROM raw_materials WHERE product_id = $1';
    const { rows } = await pool.query(stockQuery, [productId]);
    logger.info(`Invoice ${invoice.invoiceId} created. Stock for product_id ${productId}: ${rows[0]?.stock_quantity || 'not found'}`);
    await redis.del(`purchase_invoices_*`);
    req.io.emit('invoiceUpdate', invoice);
    res.status(201).json(invoice);
  } catch (error) {
    logger.error(`Error creating invoice: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PUT update invoice
router.put('/:invoiceId', authenticateToken, ensureAdmin, validateInvoiceInput, async (req, res) => {
  const { invoiceId } = req.params;
  const { supplierCode, supplierName, invoiceNumber, issueDate, description, unitPrice, quantity, linkPdf, productId } = req.body;
  try {
    const invoice = await PurchaseInvoice.update(parseInt(invoiceId), {
      supplierCode,
      supplierName,
      invoiceNumber,
      issueDate,
      description,
      unitPrice,
      quantity,
      linkPdf,
      productId
    });
    const stockQuery = 'SELECT stock_quantity FROM raw_materials WHERE product_id = $1';
    const { rows } = await pool.query(stockQuery, [productId]);
    logger.info(`Invoice ${invoiceId} updated. Stock for product_id ${productId}: ${rows[0]?.stock_quantity || 'not found'}`);
    await redis.del(`purchase_invoices_*`);
    req.io.emit('invoiceUpdate', invoice);
    res.json(invoice);
  } catch (error) {
    if (error.message === 'Purchase invoice not found') {
      return res.status(404).json({ error: 'Purchase invoice not found' });
    }
    logger.error(`Error updating invoice ${invoiceId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE invoice
router.delete('/:invoiceId', authenticateToken, ensureAdmin, async (req, res) => {
  const { invoiceId } = req.params;
  try {
    const deleted = await PurchaseInvoice.delete(parseInt(invoiceId));
    const stockQuery = 'SELECT stock_quantity FROM raw_materials WHERE product_id = $1';
    const { rows } = await pool.query(stockQuery, [deleted.productId]);
    logger.info(`Invoice ${invoiceId} deleted. Stock for product_id ${deleted.productId}: ${rows[0]?.stock_quantity || 'not found'}`);
    await redis.del(`purchase_invoices_*`);
    req.io.emit('invoiceUpdate', { invoiceId: parseInt(invoiceId), status: 'Deleted' });
    res.status(204).send();
  } catch (error) {
    if (error.message === 'Purchase invoice not found') {
      return res.status(404).json({ error: 'Purchase invoice not found' });
    }
    logger.error(`Error deleting invoice ${invoiceId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;