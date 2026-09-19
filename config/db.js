require('dotenv').config();
const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  // 2s was too tight for a fresh TLS connection to RDS under load; a slow
  // connect surfaced as "timeout exceeded when trying to connect" -> HTTP 500.
  connectionTimeoutMillis: 10000,
});

pool.on('connect', () => logger.info('Connected to PostgreSQL'));
pool.on('error', (err) => logger.error('PostgreSQL pool error:', err.stack));

module.exports = pool;
