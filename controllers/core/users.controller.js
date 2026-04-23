const pool = require('../../config/db');
const logger = require('../../utils/logger');

const IA_ROLES = [11, 12];
const COM_ROLES = [9, 10];

function getOrgRoles(roleId) {
  if (IA_ROLES.includes(roleId)) return IA_ROLES;
  if (COM_ROLES.includes(roleId)) return COM_ROLES;
  return [];
}

exports.getCustomers = async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT user_id, name FROM users WHERE role_id = 2 ORDER BY name ASC');
    res.json(rows);
  } catch (error) {
    logger.error(`Error fetching customers: ${error.message}`, error.stack);
    next(error);
  }
};

exports.getEmployeesHr = async (req, res) => {
  try {
    const orgRoles = getOrgRoles(req.user.role_id);
    if (orgRoles.length === 0) return res.status(403).json({ error: 'Not authorized to fetch team members' });
    const { rows } = await pool.query('SELECT user_id, name FROM users WHERE role_id = ANY($1::int[]) ORDER BY name ASC', [orgRoles]);
    res.json(rows);
  } catch (error) {
    logger.error(`Error fetching employees/hr: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
};
