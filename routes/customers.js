const express = require('express');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const Customer = require('../models/customer');
const router = express.Router();

// Pagination validation middleware
const validatePagination = (req, res, next) => {
  const { limit = 10, offset = 0 } = req.query;
  req.safeLimit = Math.min(parseInt(limit) || 10, 100);
  req.safeOffset = Math.max(parseInt(offset) || 0, 0);
  next();
};

// Customer input validation middleware
const validateCustomerInput = (req, res, next) => {
  const { name, contact_person, city, phone, email, gst, shipping_address, billing_address } = req.body;
  if (!name || name.length < 3) return res.status(400).json({ error: 'Name must be at least 3 characters', code: 'VALIDATION_ERROR' });
  if (!contact_person || contact_person.length < 3) return res.status(400).json({ error: 'Contact person is required', code: 'VALIDATION_ERROR' });
  if (!city) return res.status(400).json({ error: 'City is required', code: 'VALIDATION_ERROR' });
  if (!phone || !/^[0-9]{10}$/.test(phone)) return res.status(400).json({ error: 'Phone must be a valid 10-digit number', code: 'VALIDATION_ERROR' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address', code: 'VALIDATION_ERROR' });
  if (gst && !/^[0-9A-Z]{15}$/.test(gst)) return res.status(400).json({ error: 'GST must be a 15-character alphanumeric code', code: 'VALIDATION_ERROR' });
  if (!shipping_address) return res.status(400).json({ error: 'Shipping address is required', code: 'VALIDATION_ERROR' });
  if (!billing_address) return res.status(400).json({ error: 'Billing address is required', code: 'VALIDATION_ERROR' });
  next();
};

// Get customers
router.get('/', 
  authenticateToken, 
  checkPermission('Customers', 'can_read'), 
  validatePagination,
  async (req, res, next) => {
    try {
      const cacheKey = `customers_${req.safeLimit}_${req.safeOffset}`.replace(/[^a-z0-9_]/gi, '');
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info(`Cache hit for ${cacheKey}`, JSON.parse(cached));
        return res.json(JSON.parse(cached));
      }

      const response = await Customer.getCustomers({ limit: req.safeLimit, offset: req.safeOffset });

      await redis.setEx(cacheKey, 3600, JSON.stringify(response));
      logger.info(`Customers fetched successfully: ${response.data.length} items`);
      res.json(response);
    } catch (error) {
      logger.error(`Error in GET /api/customers: ${error.message}`, error.stack);
      res.status(500).json({ error: error.message, code: 'INTERNAL_SERVER_ERROR' });
    }
  }
);

// Add customer
router.post('/', 
  authenticateToken, 
  checkPermission('Customers', 'can_create'),
  validateCustomerInput,
  async (req, res, next) => {
    try {
      const { name, contact_person, city, phone, email, gst, shipping_address, billing_address } = req.body;
      const customer = await Customer.create({
        name,
        email,
        contact_person,
        city,
        phone,
        gst,
        shipping_address,
        billing_address,
      });

      const cacheKeyPattern = `customers_*_*`;
      const keys = await redis.keys(cacheKeyPattern);
      if (keys.length > 0) {
        await redis.del(keys);
        logger.info(`Invalidated caches: ${keys}`);
      }

      req.io.emit('customerUpdate', customer);
      logger.info(`Customer created: ${customer.id}`);
      res.status(201).json(customer);
    } catch (error) {
      logger.error(`Error in POST /api/customers: ${error.message}`, { stack: error.stack, body: req.body });
      if (error.status) {
        res.status(error.status).json({ error: error.message, code: error.code });
      } else {
        res.status(500).json({ error: error.message, code: 'INTERNAL_SERVER_ERROR' });
      }
    }
  }
);

module.exports = router;