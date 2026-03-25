const express = require('express');
const pool = require('../config/db');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

// ── Org helper ──────────────────────────────────────────────
// role_id 9  = employee (Compage)
// role_id 10 = hr (Compage)
// role_id 11 = IA_employee (Intute)
// role_id 12 = IA_HR (Intute)

const IA_ROLES = [11, 12];
const COM_ROLES = [9, 10];

function getOrgRoles(roleId) {
  if (IA_ROLES.includes(roleId)) return IA_ROLES;
  if (COM_ROLES.includes(roleId)) return COM_ROLES;
  return [];
}

// GET /api/users/customers → For customer dropdowns
router.get(
  '/customers',
  authenticateToken,
  checkPermission('Customers', 'can_read'),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT user_id, name FROM users WHERE role_id = 2 ORDER BY name ASC`
      );
      res.json(rows);
    } catch (error) {
      logger.error(`Error fetching customers: ${error.message}`, error.stack);
      next(error);
    }
  }
);

// GET /api/users/employees-hr → Assignee dropdown for Activities
// IA requester  → returns IA_employee + IA_HR users
// COM requester → returns employee + HR users
router.get('/employees-hr', authenticateToken, async (req, res) => {
  try {
    const orgRoles = getOrgRoles(req.user.role_id);

    if (orgRoles.length === 0) {
      return res.status(403).json({ error: 'Not authorized to fetch team members' });
    }

    const { rows } = await pool.query(
      `SELECT user_id, name
       FROM users
       WHERE role_id = ANY($1::int[])
       ORDER BY name ASC`,
      [orgRoles]
    );

    res.json(rows);
  } catch (error) {
    logger.error(`Error fetching employees/hr: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

module.exports = router;