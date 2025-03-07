// routes/auth.js
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const logger = require('../utils/logger');
const router = express.Router();
require('dotenv').config;

// POST /api/auth/login - Authenticate user and set cookie
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required', code: 'AUTH_MISSING_FIELDS' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];

    if (!user) {
      logger.warn(`Failed login attempt for email: ${email} - User not found`);
      return res.status(401).json({ error: 'Invalid credentials', code: 'AUTH_INVALID_CREDENTIALS' });
    }

    if (!user.password_hash) {
      logger.error(`User ${email} has no password set`);
      return res.status(500).json({ error: 'User account incomplete - no password set', code: 'AUTH_NO_PASSWORD' });
    }

    if (!await bcrypt.compare(password, user.password_hash)) {
      logger.warn(`Failed login attempt for email: ${email} - Incorrect password`);
      return res.status(401).json({ error: 'Invalid credentials', code: 'AUTH_INVALID_CREDENTIALS' });
    }

    const token = jwt.sign(
      { user_id: user.user_id, role_id: user.role_id, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 3600000,
    });

    logger.info(`User logged in: ${email}, user_id: ${user.user_id}`);
    res.json({ role: user.role_id === 1 ? 'admin' : 'customer', token, name: user.name });
  } catch (err) {
    logger.error(`Login error: ${err.message}`, err.stack);
    res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
  }
});

// GET /api/auth/user - Fetch user name (optional)
router.get('/user', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided', code: 'AUTH_NO_TOKEN' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query('SELECT name FROM users WHERE user_id = $1', [decoded.user_id]);
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    res.json({ name: user.name });
  } catch (err) {
    logger.error(`User fetch error: ${err.message}`, err.stack);
    res.status(403).json({ error: 'Invalid token', code: 'AUTH_INVALID_TOKEN' });
  }
});

// POST /api/auth/logout - Clear cookie
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  logger.info(`User logged out`);
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;