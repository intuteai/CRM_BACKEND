const express = require('express');
const { EmployeeDetails } = require('../models/employeeDetails');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

const IA_ROLES  = [11, 12];
const COM_ROLES = [9, 10];

function getOrgRoles(roleId) {
  if (IA_ROLES.includes(roleId))  return IA_ROLES;
  if (COM_ROLES.includes(roleId)) return COM_ROLES;
  return [];
}

// ── GET ALL EMPLOYEES ─────────────────────────────────────────
router.get(
  '/',
  authenticateToken,
  checkPermission('employee_details', 'can_read'),
  async (req, res) => {
    const { limit = 20, cursor, search, employee_id, force_refresh = false } = req.query;

    try {
      const parsedLimit = Math.min(parseInt(limit, 10), 100);
      const orgRoles = getOrgRoles(req.user.role_id);

      if (orgRoles.length === 0) {
        return res.status(403).json({ error: 'Not authorized to view employee details' });
      }

      const cacheKey = `employees_${parsedLimit}_${cursor || 'null'}_${search || 'none'}_${employee_id || 'none'}_roles_${orgRoles.join('_')}`;

      if (force_refresh === 'true') await redis.del(cacheKey);

      const cached = await redis.get(cacheKey);
      if (cached && force_refresh !== 'true') {
        logger.info(`Cache hit: ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }

      const { data, total, nextCursor } = await EmployeeDetails.getAll({
        limit: parsedLimit,
        cursor: cursor || null,
        search: search || null,
        employee_id: employee_id || null,
        orgRoles,
      });

      const response = {
        employees: data,
        total,
        nextCursor: nextCursor ? new Date(nextCursor).toISOString() : null,
      };

      await redis.setEx(cacheKey, 60, JSON.stringify(response));
      res.json(response);
    } catch (error) {
      logger.error(`Error fetching employees: ${error.message}`, { stack: error.stack });
      res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
    }
  }
);

// ── GET SINGLE EMPLOYEE ───────────────────────────────────────
router.get(
  '/:employee_id',
  authenticateToken,
  checkPermission('employee_details', 'can_read'),
  async (req, res) => {
    try {
      const orgRoles = getOrgRoles(req.user.role_id);
      if (orgRoles.length === 0) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const employee = await EmployeeDetails.getOne({
        employee_id: req.params.employee_id,
        orgRoles,
      });

      if (!employee) {
        return res.status(404).json({ error: 'Employee not found', code: 'EMPLOYEE_NOT_FOUND' });
      }

      res.json({ employee });
    } catch (error) {
      logger.error(`Error fetching employee ${req.params.employee_id}: ${error.message}`);
      res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
    }
  }
);

// ── UPDATE EMPLOYEE DETAIL ────────────────────────────────────
router.patch(
  '/:employee_id',
  authenticateToken,
  checkPermission('employee_details', 'can_write'),
  async (req, res) => {
    try {
      const { phone_number, date_of_joining, address } = req.body;
      const orgRoles = getOrgRoles(req.user.role_id);

      if (orgRoles.length === 0) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const updated = await EmployeeDetails.update({
        employee_id: req.params.employee_id,
        phone_number,
        date_of_joining,
        address,
        orgRoles,
      });

      if (!updated) {
        return res.status(404).json({ error: 'Employee not found or outside your org', code: 'EMPLOYEE_NOT_FOUND' });
      }

      setImmediate(async () => {
        try {
          const keys = await redis.keys('employees_*');
          if (keys.length > 0) await redis.del(keys);
        } catch (err) {
          logger.error('Cache invalidation failed', err);
        }
      });

      res.json({ employee: updated });
    } catch (error) {
      logger.error(`Error updating employee ${req.params.employee_id}: ${error.message}`, { stack: error.stack });
      res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
    }
  }
);

module.exports = router;