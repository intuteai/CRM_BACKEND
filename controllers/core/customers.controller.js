const Customer = require('../../models/core/customer');
const redis = require('../../config/redis');
const logger = require('../../utils/logger');

exports.getAll = async (req, res) => {
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
};

exports.search = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const { rows } = await require('../../config/db').query(
      `SELECT c.customer_id, u.name
       FROM customers c
       JOIN users u ON c.user_id = u.user_id
       WHERE u.name ILIKE $1
       ORDER BY u.name
       LIMIT 20`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    logger.error(`Customer search error: ${err.message}`);
    res.status(500).json({ error: 'Search failed', code: 'SERVER_ERROR' });
  }
};

exports.create = async (req, res) => {
  try {
    const { name, contact_person, city, phone, email, gst, shipping_address, billing_address } = req.body;
    const customer = await Customer.create({ name, email, contact_person, city, phone, gst, shipping_address, billing_address });
    const keys = await redis.keys('customers_*_*');
    if (keys.length > 0) await redis.del(keys);
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
};
