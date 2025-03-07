// middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const authenticateToken = async (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided', code: 'AUTH_NO_TOKEN' });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (error) {
    res.status(403).json({ error: 'Invalid token', code: 'AUTH_INVALID_TOKEN' });
  }
};

const checkPermission = (module, action) => {
  return async (req, res, next) => {
    const { role_id } = req.user;
    const query = `SELECT ${action} FROM permissions WHERE role_id = $1 AND module = $2`;
    try {
      const result = await pool.query(query, [role_id, module]);
      if (result.rows.length > 0 && result.rows[0][action]) {
        next();
      } else {
        res.status(403).json({ error: 'Permission denied', code: 'PERM_DENIED' });
      }
    } catch (error) {
      next(error);
    }
  };
};

module.exports = { authenticateToken, checkPermission };