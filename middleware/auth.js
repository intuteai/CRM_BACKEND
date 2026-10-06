// middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

/**
 * authenticateToken
 * - verifies JWT
 * - fetches user + role_name from DB and attaches normalized req.user
 * - defends against missing fields in token
 */
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided', code: 'AUTH_NO_TOKEN' });
    }

    // verify token first (throws on invalid/expired)
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload || !payload.user_id) {
      return res.status(403).json({ error: 'Invalid token payload', code: 'AUTH_INVALID_TOKEN' });
    }

    // Fetch user row and role_name from DB to ensure correctness and freshness.
    // A database failure here is not a bad token: answering AUTH_INVALID_TOKEN
    // would make the clients log the user out mid-work.
    let rows;
    try {
      ({ rows } = await pool.query(
        `SELECT u.user_id, u.name, u.role_id, r.role_name
         FROM users u
         LEFT JOIN roles r ON u.role_id = r.role_id
         WHERE u.user_id = $1`,
        [payload.user_id]
      ));
    } catch (dbErr) {
      console.error('authenticateToken database error:', dbErr && dbErr.message ? dbErr.message : dbErr);
      return res.status(503).json({ error: 'The server is temporarily unavailable. Please try again.', code: 'AUTH_UNAVAILABLE' });
    }

    if (rows.length === 0) {
      return res.status(403).json({ error: 'User not found', code: 'AUTH_INVALID_USER' });
    }

    const u = rows[0];
    req.user = {
      user_id: Number(u.user_id),
      role_id: Number(u.role_id),
      // keep role_name as original-case too: routes check using toLowerCase()
      role_name: String(u.role_name || '').toLowerCase(),
      name: u.name || payload.name || null,
    };

    // optional small debug (remove in prod)
    // console.log('Authenticated user:', req.user);

    next();
  } catch (err) {
    console.error('authenticateToken error:', err && err.message ? err.message : err);
    return res.status(403).json({ error: 'Invalid token', code: 'AUTH_INVALID_TOKEN' });
  }
};

// Plain, directly-callable permission lookup -- the same query
// checkPermission (route middleware, below) already ran, just usable from
// anywhere, not only as an Express middleware. Added so a model method
// (PdiReports.patchReport, editing an already-Completed report) can gate one
// specific action without needing blanket route middleware on every PDI
// edit -- see docs/superpowers/specs/2026-09-30-pdi-finalized-report-editing-design.md.
// Does no input validation of its own (unlike checkPermission's req.user
// guard) -- an invalid/missing role_id just matches zero permission rows and
// resolves false (fails closed), it never throws. Callers are expected to
// already have a real, validated numeric role_id before calling this.
async function hasPermission(role_id, module, action) {
  const dbAction = action === 'can_create' ? 'can_write' : action;
  const result = await pool.query(
    `SELECT ${dbAction} FROM permissions WHERE role_id = $1 AND module = $2`,
    [role_id, module]
  );
  return result.rows.length > 0 && !!result.rows[0][dbAction];
}

const checkPermission = (module, action) => {
  return async (req, res, next) => {
    // defensive: ensure req.user exists and contains role_id
    if (!req.user || typeof req.user.role_id === 'undefined') {
      return res.status(403).json({ error: 'Permission denied (no user)', code: 'PERM_DENIED' });
    }

    try {
      const allowed = await hasPermission(req.user.role_id, module, action);
      if (allowed) {
        next();
      } else {
        res.status(403).json({ error: 'Permission denied', code: 'PERM_DENIED' });
      }
    } catch (error) {
      console.error('Permission check failed:', error);
      res.status(500).json({ error: `Permission check failed: ${error.message}`, code: 'PERM_CHECK_FAILED' });
    }
  };
};

module.exports = { authenticateToken, checkPermission, hasPermission };
