const pool = require('../../config/db');
const logger = require('../../utils/logger');

const ROLE_DASHBOARDS = {
  1: 'admin-dashboard', 2: 'customer-dashboard', 3: 'sales-dashboard',
  4: 'design-dashboard', 5: 'production-dashboard', 6: 'stores-dashboard',
  7: 'dispatch-dashboard', 8: 'accounts-dashboard',
};

function makeRoleDashboard(allowedRoleId, dashboardName) {
  return async (req, res) => {
    try {
      if (req.user.role_id !== allowedRoleId) {
        logger.warn(`Unauthorized access to ${dashboardName}: role_id=${req.user.role_id}`);
        return res.status(403).json({ error: 'Access denied', code: 'PERM_DENIED' });
      }
      res.json({ dashboard: dashboardName });
    } catch (error) {
      logger.error(`Error accessing ${dashboardName}: ${error.message}`, error.stack);
      res.status(500).json({ error: `Server error: ${error.message}`, code: 'SERVER_ERROR' });
    }
  };
}

exports.salesDashboard      = makeRoleDashboard(3, 'sales-dashboard');
exports.customerDashboard   = makeRoleDashboard(2, 'customer-dashboard');
exports.adminDashboard      = makeRoleDashboard(1, 'admin-dashboard');
exports.designDashboard     = makeRoleDashboard(4, 'design-dashboard');
exports.productionDashboard = makeRoleDashboard(5, 'production-dashboard');
exports.storesDashboard     = makeRoleDashboard(6, 'stores-dashboard');
exports.dispatchDashboard   = makeRoleDashboard(7, 'dispatch-dashboard');
exports.accountsDashboard   = makeRoleDashboard(8, 'accounts-dashboard');

exports.main = async (req, res) => {
  const { role_id } = req.user;
  try {
    const result = await pool.query('SELECT can_read FROM permissions WHERE role_id = $1 AND module = $2', [role_id, 'dashboard']);
    if (result.rows.length === 0 || !result.rows[0].can_read) {
      logger.warn(`No dashboard access for role_id: ${role_id}`);
      return res.status(403).json({ error: 'No dashboard access', code: 'PERM_DENIED' });
    }
    const dashboard = ROLE_DASHBOARDS[role_id];
    if (!dashboard) {
      logger.warn(`Unknown role_id: ${role_id}`);
      return res.status(403).json({ error: 'Unknown role', code: 'INVALID_ROLE' });
    }
    res.json({ dashboard });
  } catch (error) {
    logger.error(`Dashboard error: ${error.message}`, error.stack);
    res.status(500).json({ error: `Server error: ${error.message}`, code: 'SERVER_ERROR' });
  }
};
