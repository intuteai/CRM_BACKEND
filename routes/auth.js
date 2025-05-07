const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const logger = require('../utils/logger');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const User = require('../models/user');
require('dotenv').config();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required', code: 'AUTH_MISSING_FIELDS' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT u.*, r.role_name FROM users u JOIN roles r ON u.role_id = r.role_id WHERE u.email = $1',
      [email]
    );
    const user = rows[0];

    if (!user) {
      logger.warn(`Failed login attempt for email: ${email} - User not found`);
      return res.status(401).json({ error: 'Invalid credentials', code: 'AUTH_INVALID_CREDENTIALS' });
    }

    if (!user.password_hash) {
      logger.error(`User ${email} has no password set`);
      return res.status(500).json({ error: 'User account incomplete - no password set', code: 'AUTH_NO_PASSWORD' });
    }

    if (!(await bcrypt.compare(password, user.password_hash))) {
      logger.warn(`Failed login attempt for email: ${email} - Incorrect password`);
      return res.status(401).json({ error: 'Invalid credentials', code: 'AUTH_INVALID_CREDENTIALS' });
    }

    const token = jwt.sign(
      { user_id: user.user_id, role_id: user.role_id, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Explicit role mapping by role_id
    const roleMap = {
      1: 'admin',
      2: 'customer',
      3: 'sales',
      4: 'design',
      5: 'production',
      6: 'store',
      7: 'dispatch',
      8: 'accounts',
    };
    const role = roleMap[user.role_id] || 'unknown';

    logger.info(`User logged in: ${email}, user_id: ${user.user_id}, role_id: ${user.role_id}, role: ${role}`);
    res.json({ role, token, name: user.name });
  } catch (err) {
    logger.error(`Login error: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
  }
});

router.get('/verify-token', authenticateToken, (req, res) => {
  try {
    res.json({ user: req.user });
  } catch (err) {
    logger.error(`Token verification error: ${err.message}`, { stack: err.stack });
    res.status(403).json({ error: 'Invalid token', code: 'AUTH_INVALID_TOKEN' });
  }
});

router.get('/user', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT name FROM users WHERE user_id = $1', [req.user.user_id]);
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    res.json({ name: user.name });
  } catch (err) {
    logger.error(`User fetch error: ${err.message}`, { stack: err.stack });
    res.status(403).json({ error: 'Invalid token', code: 'AUTH_INVALID_TOKEN' });
  }
});

router.post('/logout', authenticateToken, (req, res) => {
  logger.info(`User logged out`);
  res.json({ message: 'Logged out successfully' });
});

router.put('/update-password', authenticateToken, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const userId = req.user.user_id;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Old and new passwords are required', code: 'AUTH_MISSING_FIELDS' });
  }

  try {
    await User.updatePassword(userId, oldPassword, newPassword);
    logger.info(`Password updated successfully for user_id: ${userId}`);
    res.json({ message: 'Password updated successfully!' });
  } catch (err) {
    logger.error(`Password update error for user_id: ${userId}: ${err.message}`, { stack: err.stack });
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'SERVER_ERROR' });
  }
});

module.exports = router;