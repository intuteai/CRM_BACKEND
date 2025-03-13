const express = require('express');
const pool = require('../config/db');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router();

// Input validation middleware
const validatePagination = (req, res, next) => {
  const { limit = 10, offset = 0 } = req.query;
  req.safeLimit = Math.min(parseInt(limit) || 10, 100); // Max limit 100
  req.safeOffset = Math.max(parseInt(offset) || 0, 0);  // Min offset 0
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

      const query = `
        SELECT u.user_id AS id, u.name, u.email, 
               COUNT(DISTINCT o.order_id)::INTEGER AS orders, 
               COUNT(DISTINCT q.query_id)::INTEGER AS queries 
        FROM users u 
        LEFT JOIN orders o ON u.user_id = o.user_id 
        LEFT JOIN queries q ON u.user_id = q.user_id 
        WHERE u.role_id = 2 
        GROUP BY u.user_id, u.name, u.email 
        LIMIT $1 OFFSET $2
      `;

      const countQuery = 'SELECT COUNT(*) FROM users WHERE role_id = 2';
      
      const [dataResult, countResult] = await Promise.all([
        pool.query(query, [req.safeLimit, req.safeOffset]),
        pool.query(countQuery)
      ]);

      console.log('Query Result:', dataResult.rows); // Log raw data

      const response = {
        data: dataResult.rows,
        total: parseInt(countResult.rows[0].count),
        limit: req.safeLimit,
        offset: req.safeOffset
      };

      await redis.setEx(cacheKey, 3600, JSON.stringify(response));
      logger.info(`Customers fetched successfully: ${response.data.length} items`);
      res.json(response);
    } catch (error) {
      logger.error(`Error in GET /api/customers: ${error.message}`, error.stack);
      next(error);
    }
  }
);

// Add order (new endpoint)
router.post('/orders', 
  authenticateToken, 
  checkPermission('Orders', 'can_create'),
  async (req, res, next) => {
    try {
      const { user_id, target_delivery_date } = req.body;
      const query = `
        INSERT INTO orders (user_id, target_delivery_date, created_at, status, payment_status)
        VALUES ($1, $2, NOW(), 'Pending', 'Pending')
        RETURNING order_id, user_id
      `;
      const result = await pool.query(query, [user_id, target_delivery_date]);

      // Invalidate all customer caches
      const cacheKeyPattern = `customers_*_*`;
      const keys = await redis.keys(cacheKeyPattern);
      if (keys.length > 0) {
        await redis.del(keys);
        logger.info(`Invalidated caches: ${keys}`);
      }

      // Fetch updated customer data
      const updatedCustomerQuery = `
        SELECT u.user_id AS id, u.name, u.email, 
               COUNT(DISTINCT o.order_id)::INTEGER AS orders, 
               COUNT(DISTINCT q.query_id)::INTEGER AS queries 
        FROM users u 
        LEFT JOIN orders o ON u.user_id = o.user_id 
        LEFT JOIN queries q ON u.user_id = q.user_id 
        WHERE u.user_id = $1 
        GROUP BY u.user_id, u.name, u.email
      `;
      const updatedCustomerResult = await pool.query(updatedCustomerQuery, [user_id]);
      const updatedCustomer = updatedCustomerResult.rows[0];

      // Emit Socket.IO update
      const io = req.app.get('socketio') || require('socket.io')(req.app.get('httpServer')); // Fallback
      io.emit('customerUpdate', updatedCustomer);

      res.status(201).json(result.rows[0]);
    } catch (error) {
      logger.error(`Error in POST /api/orders: ${error.message}`, error.stack);
      next(error);
    }
  }
);

module.exports = router;