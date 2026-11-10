// Motor-test permissions. Testing roles live in mt_user_role, separate from the ERP's single
// users.role_id, so an employee keeps their ERP role and can also be an operator.
// Runs after authenticateToken. Answers 403 TESTING_ROLE_REQUIRED (not AUTH_INVALID_TOKEN),
// so the tablet never mistakes a missing permission for an expired login.
'use strict';
const pool = require('../config/db');

const TESTING_ROLES = Object.freeze(['testing_head', 'operator', 'viewer', 'testing_admin']);

const ERP_ADMIN_ROLE_ID = 1; // ERP Admins are treated as testing_admin, so the first testing roles can be granted from the UI

async function loadTestingRoles(userId, erpRoleId) {
  const { rows } = await pool.query('SELECT testing_role FROM mt_user_role WHERE user_id = $1 ORDER BY testing_role', [userId]);
  const roles = rows.map((r) => r.testing_role);
  if (Number(erpRoleId) === ERP_ADMIN_ROLE_ID && !roles.includes('testing_admin')) roles.push('testing_admin');
  return roles.sort();
}

function requireTestingRole(...allowed) {
  if (!allowed.length || allowed.some((r) => !TESTING_ROLES.includes(r))) {
    throw new Error(`requireTestingRole: invalid role list ${JSON.stringify(allowed)}`);
  }
  return async (req, res, next) => {
    try {
      const roles = req.testingRoles || (req.testingRoles = await loadTestingRoles(req.user.user_id, req.user.role_id));
      if (roles.some((r) => allowed.includes(r))) return next();
      return res.status(403).json({
        error: 'Your account has no testing permission for this action',
        code: 'TESTING_ROLE_REQUIRED',
        required_role: allowed.length === 1 ? allowed[0] : allowed,
      });
    } catch (e) {
      return res.status(503).json({ error: 'The server is temporarily unavailable. Please try again.', code: 'SERVER_UNAVAILABLE' });
    }
  };
}

module.exports = { TESTING_ROLES, loadTestingRoles, requireTestingRole };
