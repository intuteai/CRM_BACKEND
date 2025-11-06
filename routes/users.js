// routes/users.js

const express = require('express');
const pool = require('../config/db');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

// GET /api/users/customers → For customer dropdowns
router.get('/customers', authenticateToken, checkPermission('Customers', 'can_read'), async (req, res, next) => {
  try {
    const query = `
      SELECT user_id, name 
      FROM users 
      WHERE role_id = 2  -- Customers
    `;
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (error) {
    logger.error(`Error fetching customers: ${error.message}`, error.stack);
    next(error);
  }
});

// GET /api/users/employees-hr → For Activities assignee dropdown
// RESTRICTED TO SPECIFIC USERS ONLY: 45, 69, 70, 71, 72, 73
router.get('/employees-hr', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT user_id, name 
      FROM users 
      WHERE user_id IN (45, 69, 70, 71, 72, 73)
      ORDER BY name ASC
    `;
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (error) {
    logger.error(`Error fetching employees/hr: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

module.exports = router;
