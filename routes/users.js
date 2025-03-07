// routes/users.js
const express = require('express');
const pool = require('../config/db');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

router.get('/customers', authenticateToken, checkPermission('Customers', 'can_read'), async (req, res, next) => {
  try {
    const query = `
      SELECT user_id, name 
      FROM users 
      WHERE role_id = 2  -- Assuming role_id 2 is for customers
    `;
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (error) {
    logger.error(`Error fetching customers: ${error.message}`, error.stack);
    next(error);
  }
});

module.exports = router;