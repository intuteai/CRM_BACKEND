const jwt = require('jsonwebtoken');
const pool = require('../config/db');


const authenticateToken = async (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided', code: 'AUTH_NO_TOKEN' });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    console.log('Decoded token:', req.user); // Log token payload
    next();
  } catch (error) {
    res.status(403).json({ error: 'Invalid token', code: 'AUTH_INVALID_TOKEN' });
  }
};

const checkPermission = (module, action) => {
  return async (req, res, next) => {
    const { role_id } = req.user;
    const dbAction = action === 'can_create' ? 'can_write' : action;
    const query = `SELECT ${dbAction} FROM permissions WHERE role_id = $1 AND module = $2`;
    try {
      const result = await pool.query(query, [role_id, module]);
      console.log(`Permission check: role_id=${role_id}, module=${module}, action=${dbAction}, result=`, result.rows); // Add this line
      if (result.rows.length > 0 && result.rows[0][dbAction]) {
        next();
      } else {
        res.status(403).json({ error: 'Permission denied', code: 'PERM_DENIED' });
      }
    } catch (error) {
      res.status(500).json({ error: `Permission check failed: ${error.message}`, code: 'PERM_CHECK_FAILED' });
    }
  };
};

module.exports = { authenticateToken, checkPermission };