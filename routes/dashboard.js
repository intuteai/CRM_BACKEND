const express = require('express');
const router = express.Router();
const { authenticateToken, checkPermission } = require('../middleware/auth');
const pool = require('../config/db');
const logger = require('../utils/logger');

// Role-specific dashboard routes
router.get(
  '/sales-dashboard',
  authenticateToken,
  checkPermission('dashboard', 'can_read'),
  async (req, res) => {
    try {
      if (req.user.role_id !== 3) {
        logger.warn(`Unauthorized access to sales-dashboard: role_id=${req.user.role_id}`);
        return res.status(403).json({ error: 'Access denied', code: 'PERM_DENIED' });
      }
      res.json({ dashboard: 'sales-dashboard' });
    } catch (error) {
      logger.error(`Error accessing sales-dashboard: ${error.message}`, error.stack);
      res.status(500).json({ error: `Server error: ${error.message}`, code: 'SERVER_ERROR' });
    }
  }
);

router.get(
  '/customer-dashboard',
  authenticateToken,
  checkPermission('dashboard', 'can_read'),
  async (req, res) => {
    try {
      if (req.user.role_id !== 2) {
        logger.warn(`Unauthorized access to customer-dashboard: role_id=${req.user.role_id}`);
        return res.status(403).json({ error: 'Access denied', code: 'PERM_DENIED' });
      }
      res.json({ dashboard: 'customer-dashboard' });
    } catch (error) {
      logger.error(`Error accessing customer-dashboard: ${error.message}`, error.stack);
      res.status(500).json({ error: `Server error: ${error.message}`, code: 'SERVER_ERROR' });
    }
  }
);

router.get(
  '/admin-dashboard',
  authenticateToken,
  checkPermission('dashboard', 'can_read'),
  async (req, res) => {
    try {
      if (req.user.role_id !== 1) {
        logger.warn(`Unauthorized access to admin-dashboard: role_id=${req.user.role_id}`);
        return res.status(403).json({ error: 'Access denied', code: 'PERM_DENIED' });
      }
      res.json({ dashboard: 'admin-dashboard' });
    } catch (error) {
      logger.error(`Error accessing admin-dashboard: ${error.message}`, error.stack);
      res.status(500).json({ error: `Server error: ${error.message}`, code: 'SERVER_ERROR' });
    }
  }
);

router.get(
  '/design-dashboard',
  authenticateToken,
  checkPermission('dashboard', 'can_read'),
  async (req, res) => {
    try {
      if (req.user.role_id !== 4) {
        logger.warn(`Unauthorized access to design-dashboard: role_id=${req.user.role_id}`);
        return res.status(403).json({ error: 'Access denied', code: 'PERM_DENIED' });
      }
      res.json({ dashboard: 'design-dashboard' });
    } catch (error) {
      logger.error(`Error accessing design-dashboard: ${error.message}`, error.stack);
      res.status(500).json({ error: `Server error: ${error.message}`, code: 'SERVER_ERROR' });
    }
  }
);

router.get(
  '/production-dashboard',
  authenticateToken,
  checkPermission('dashboard', 'can_read'),
  async (req, res) => {
    try {
      if (req.user.role_id !== 5) {
        logger.warn(`Unauthorized access to production-dashboard: role_id=${req.user.role_id}`);
        return res.status(403).json({ error: 'Access denied', code: 'PERM_DENIED' });
      }
      res.json({ dashboard: 'production-dashboard' });
    } catch (error) {
      logger.error(`Error accessing production-dashboard: ${error.message}`, error.stack);
      res.status(500).json({ error: `Server error: ${error.message}`, code: 'SERVER_ERROR' });
    }
  }
);

router.get(
  '/stores-dashboard',
  authenticateToken,
  checkPermission('dashboard', 'can_read'),
  async (req, res) => {
    try {
      if (req.user.role_id !== 6) {
        logger.warn(`Unauthorized access to stores-dashboard: role_id=${req.user.role_id}`);
        return res.status(403).json({ error: 'Access denied', code: 'PERM_DENIED' });
      }
      res.json({ dashboard: 'stores-dashboard' });
    } catch (error) {
      logger.error(`Error accessing stores-dashboard: ${error.message}`, error.stack);
      res.status(500).json({ error: `Server error: ${error.message}`, code: 'SERVER_ERROR' });
    }
  }
);

router.get(
  '/dispatch-dashboard',
  authenticateToken,
  checkPermission('dashboard', 'can_read'),
  async (req, res) => {
    try {
      if (req.user.role_id !== 7) {
        logger.warn(`Unauthorized access to dispatch-dashboard: role_id=${req.user.role_id}`);
        return res.status(403).json({ error: 'Access denied', code: 'PERM_DENIED' });
      }
      res.json({ dashboard: 'dispatch-dashboard' });
    } catch (error) {
      logger.error(`Error accessing dispatch-dashboard: ${error.message}`, error.stack);
      res.status(500).json({ error: `Server error: ${error.message}`, code: 'SERVER_ERROR' });
    }
  }
);

router.get(
  '/accounts-dashboard',
  authenticateToken,
  checkPermission('dashboard', 'can_read'),
  async (req, res) => {
    try {
      if (req.user.role_id !== 8) {
        logger.warn(`Unauthorized access to accounts-dashboard: role_id=${req.user.role_id}`);
        return res.status(403).json({ error: 'Access denied', code: 'PERM_DENIED' });
      }
      res.json({ dashboard: 'accounts-dashboard' });
    } catch (error) {
      logger.error(`Error accessing accounts-dashboard: ${error.message}`, error.stack);
      res.status(500).json({ error: `Server error: ${error.message}`, code: 'SERVER_ERROR' });
    }
  }
);

// Main dashboard route
router.get('/', authenticateToken, async (req, res) => {
  const { role_id } = req.user;
  try {
    const result = await pool.query(
      'SELECT can_read FROM permissions WHERE role_id = $1 AND module = $2',
      [role_id, 'dashboard']
    );
    console.log(`Dashboard check: role_id=${role_id}, result=`, result.rows);
    if (result.rows.length === 0 || !result.rows[0].can_read) {
      logger.warn(`No dashboard access for role_id: ${role_id}`);
      return res.status(403).json({ error: 'No dashboard access', code: 'PERM_DENIED' });
    }
    switch (role_id) {
      case 1:
        return res.json({ dashboard: 'admin-dashboard' });
      case 2:
        return res.json({ dashboard: 'customer-dashboard' });
      case 3:
        return res.json({ dashboard: 'sales-dashboard' });
      case 4:
        return res.json({ dashboard: 'design-dashboard' });
      case 5:
        return res.json({ dashboard: 'production-dashboard' });
      case 6:
        return res.json({ dashboard: 'stores-dashboard' });
      case 7:
        return res.json({ dashboard: 'dispatch-dashboard' });
      case 8:
        return res.json({ dashboard: 'accounts-dashboard' });
      default:
        logger.warn(`Unknown role_id: ${role_id}`);
        return res.status(403).json({ error: 'Unknown role', code: 'INVALID_ROLE' });
    }
  } catch (error) {
    logger.error(`Dashboard error: ${error.message}`, error.stack);
    res.status(500).json({ error: `Server error: ${error.message}`, code: 'SERVER_ERROR' });
  }
});

module.exports = router;