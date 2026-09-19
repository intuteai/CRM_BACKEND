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

exports.adminStats = async (req, res) => {
  try {
    if (req.user.role_id !== 1) {
      logger.warn(`Unauthorized access to admin-stats: role_id=${req.user.role_id}`);
      return res.status(403).json({ error: 'Access denied', code: 'PERM_DENIED' });
    }

    // NULL status/stock rows are counted the way the UI treats them (missing order status
    // = Pending, missing query status = Open, missing stock = 0) instead of being skipped
    // by `!=` / `NOT IN` / `<`. "Today" is IST, not the DB server's timezone.
    const [openOrders, pendingQueries, lowStock, dispatchesToday] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM orders WHERE COALESCE(status, 'Pending') NOT IN ('Delivered', 'Cancelled')"),
      pool.query("SELECT COUNT(*) FROM queries WHERE COALESCE(query_status, 'Open') <> 'Closed'"),
      pool.query('SELECT COUNT(*) FROM inventory WHERE COALESCE(stock_quantity, 0) < 10'),
      pool.query("SELECT COUNT(*) FROM dispatch_tracking_details WHERE dispatch_date::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date"),
    ]);

    res.json({
      openOrders: parseInt(openOrders.rows[0].count, 10),
      pendingQueries: parseInt(pendingQueries.rows[0].count, 10),
      lowStockItems: parseInt(lowStock.rows[0].count, 10),
      dispatchesToday: parseInt(dispatchesToday.rows[0].count, 10),
    });
  } catch (error) {
    logger.error(`Admin stats error: ${error.message}`, error.stack);
    res.status(500).json({ error: `Server error: ${error.message}`, code: 'SERVER_ERROR' });
  }
};

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
