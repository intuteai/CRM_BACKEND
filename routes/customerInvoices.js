const express = require('express');
const { CustomerInvoice } = require('../models/customerInvoice');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

router.post('/', authenticateToken, checkPermission('CustomerInvoices', 'can_write'), async (req, res) => {
  try {
    const { customer_id, order_id, invoice_number, issue_date, total_value, link_pdf } = req.body;

    if (!invoice_number) {
      return res.status(400).json({ error: 'Invoice number is required', code: 'INVALID_INPUT' });
    }

    const invoice = await CustomerInvoice.create({
      customer_id,
      order_id,
      invoice_number,
      issue_date,
      total_value,
      link_pdf
    }, req.io);

    const keys = await redis.keys('invoice_*');
    if (keys.length > 0) await redis.del(keys);

    logger.info(`Customer invoice created: ${invoice.invoice_id} by ${req.user.user_id}`);
    res.status(201).json(invoice);
  } catch (error) {
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Invalid customer_id or order_id', code: 'FOREIGN_KEY_VIOLATION' });
    }
    logger.error(`Error creating customer invoice: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
});

router.get('/', authenticateToken, checkPermission('CustomerInvoices', 'can_read'), async (req, res) => {
  const { limit = 10, cursor, force_refresh = 'false' } = req.query;
  const cacheKey = cursor ? `invoice_list_${limit}_${cursor}` : `invoice_list_${limit}`;

  try {
    if (force_refresh === 'true') await redis.del(cacheKey);

    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const invoices = await CustomerInvoice.getAll({ limit: parseInt(limit), cursor });
    await redis.setEx(cacheKey, 300, JSON.stringify(invoices));
    logger.info(`Fetched ${invoices.data.length} customer invoices`);
    res.json(invoices);
  } catch (error) {
    logger.error(`Error fetching customer invoices: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
});

router.get('/:id', authenticateToken, checkPermission('CustomerInvoices', 'can_read'), async (req, res) => {
  const cacheKey = `invoice_${req.params.id}`;

  try {
    if (req.query.force_refresh === 'true') await redis.del(cacheKey);

    const cached = await redis.get(cacheKey);
    if (cached && req.query.force_refresh !== 'true') {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const invoice = await CustomerInvoice.getById(req.params.id);
    await redis.setEx(cacheKey, 300, JSON.stringify(invoice));
    logger.info(`Fetched customer invoice: ${invoice.invoice_id}`);
    res.json(invoice);
  } catch (error) {
    logger.error(`Error fetching customer invoice ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Invoice not found' ? 404 : 500).json({ error: error.message, code: error.message === 'Invoice not found' ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
});

router.put('/:id', authenticateToken, checkPermission('CustomerInvoices', 'can_write'), async (req, res) => {
  try {
    const { customer_id, order_id, invoice_number, issue_date, link_pdf } = req.body;

    const invoice = await CustomerInvoice.update(req.params.id, {
      customer_id,
      order_id,
      invoice_number,
      issue_date,
      link_pdf
    }, req.io);

    const keys = await redis.keys('invoice_*');
    if (keys.length > 0) await redis.del(keys);

    logger.info(`Customer invoice updated: ${invoice.invoice_id} by ${req.user.user_id}`);
    res.json(invoice);
  } catch (error) {
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Invalid customer_id or order_id', code: 'FOREIGN_KEY_VIOLATION' });
    }
    logger.error(`Error updating customer invoice ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Invoice not found' ? 404 : 500).json({ error: error.message, code: error.message === 'Invoice not found' ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
});

router.delete('/:id', authenticateToken, checkPermission('CustomerInvoices', 'can_delete'), async (req, res) => {
  try {
    const invoice = await CustomerInvoice.delete(req.params.id, req.io);

    const keys = await redis.keys('invoice_*');
    if (keys.length > 0) await redis.del(keys);

    logger.info(`Customer invoice deleted: ${invoice.invoice_id} by ${req.user.user_id}`);
    res.json({ message: 'Invoice deleted successfully', invoice });
  } catch (error) {
    logger.error(`Error deleting customer invoice ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Invoice not found' ? 404 : 500).json({ error: error.message, code: error.message === 'Invoice not found' ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
});

module.exports = router;