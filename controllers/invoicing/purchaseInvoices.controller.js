const PurchaseInvoice = require('../../models/invoicing/purchaseInvoice');
const redis = require('../../config/redis');
const logger = require('../../utils/logger');
const pool = require('../../config/db');

exports.getAll = async (req, res) => {
  const { limit = 10, offset = 0, force_refresh = false } = req.query;
  const cacheKey = `purchase_invoices_${limit}_${offset}`;
  try {
    if (force_refresh === 'true') await redis.del(cacheKey);
    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') { logger.info(`Cache hit for ${cacheKey}`); return res.json(JSON.parse(cached)); }
    const invoices = await PurchaseInvoice.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
    await redis.setEx(cacheKey, 300, JSON.stringify(invoices));
    res.json(invoices);
  } catch (error) {
    logger.error(`Error fetching invoices: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.create = async (req, res) => {
  const { supplierCode, supplierName, invoiceNumber, issueDate, description, unitPrice, quantity, linkPdf, productId } = req.body;
  try {
    const invoice = await PurchaseInvoice.create({ supplierCode, supplierName, invoiceNumber, issueDate, description, unitPrice, quantity, linkPdf, productId });
    const { rows } = await pool.query('SELECT stock_quantity FROM raw_materials WHERE product_id = $1', [productId]);
    logger.info(`Invoice ${invoice.invoiceId} created. Stock for product_id ${productId}: ${rows[0]?.stock_quantity || 'not found'}`);
    await redis.del('purchase_invoices_*');
    req.io.emit('invoiceUpdate', invoice);
    res.status(201).json(invoice);
  } catch (error) {
    logger.error(`Error creating invoice: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.update = async (req, res) => {
  const { invoiceId } = req.params;
  const { supplierCode, supplierName, invoiceNumber, issueDate, description, unitPrice, quantity, linkPdf, productId } = req.body;
  try {
    const invoice = await PurchaseInvoice.update(parseInt(invoiceId), { supplierCode, supplierName, invoiceNumber, issueDate, description, unitPrice, quantity, linkPdf, productId });
    const { rows } = await pool.query('SELECT stock_quantity FROM raw_materials WHERE product_id = $1', [productId]);
    logger.info(`Invoice ${invoiceId} updated. Stock for product_id ${productId}: ${rows[0]?.stock_quantity || 'not found'}`);
    await redis.del('purchase_invoices_*');
    req.io.emit('invoiceUpdate', invoice);
    res.json(invoice);
  } catch (error) {
    if (error.message === 'Purchase invoice not found') return res.status(404).json({ error: 'Purchase invoice not found' });
    logger.error(`Error updating invoice ${invoiceId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.delete = async (req, res) => {
  const { invoiceId } = req.params;
  try {
    const deleted = await PurchaseInvoice.delete(parseInt(invoiceId));
    const { rows } = await pool.query('SELECT stock_quantity FROM raw_materials WHERE product_id = $1', [deleted.productId]);
    logger.info(`Invoice ${invoiceId} deleted. Stock for product_id ${deleted.productId}: ${rows[0]?.stock_quantity || 'not found'}`);
    await redis.del('purchase_invoices_*');
    req.io.emit('invoiceUpdate', { invoiceId: parseInt(invoiceId), status: 'Deleted' });
    res.status(204).send();
  } catch (error) {
    if (error.message === 'Purchase invoice not found') return res.status(404).json({ error: 'Purchase invoice not found' });
    logger.error(`Error deleting invoice ${invoiceId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
