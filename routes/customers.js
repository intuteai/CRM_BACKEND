const express = require('express');
const User = require('../models/user');
const Activity = require('../models/activity');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const pool = require('../config/db'); // Added missing import
const router = express.Router();

router.get('/', authenticateToken, checkPermission('Customers', 'can_read'), async (req, res, next) => {
  const { limit = 10, offset = 0 } = req.query;
  try {
    const cacheKey = `customers_${limit}_${offset}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const query = `
      SELECT u.user_id AS id, u.name, u.email, 
             COUNT(DISTINCT o.order_id) AS orders, 
             COUNT(DISTINCT q.query_id) AS queries 
      FROM users u 
      LEFT JOIN orders o ON u.user_id = o.user_id 
      LEFT JOIN queries q ON u.user_id = q.user_id 
      WHERE u.role_id = 2 
      GROUP BY u.user_id, u.name, u.email 
      LIMIT $1 OFFSET $2
    `;
    const { rows } = await pool.query(query, [parseInt(limit), parseInt(offset)]);
    await redis.setEx(cacheKey, 3600, JSON.stringify(rows));
    logger.info(`Customers fetched successfully: ${rows.length} items`);
    res.json(rows);
  } catch (error) {
    logger.error(`Error in GET /api/customers: ${error.message}`, error.stack);
    next(error);
  }
});

module.exports = router;