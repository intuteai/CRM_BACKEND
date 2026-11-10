require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const logger = require('../utils/logger');

// TLS to RDS: the server certificate is verified against the public AWS RDS CA bundle
// (config/rds-global-bundle.pem, from https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem).
// DB_SSL_CA can point to another bundle. Emergency only: DB_SSL_VERIFY=false turns verification off
// (the connection stays encrypted but the server is not authenticated) - fix the cause and remove it.
function sslConfig() {
  if (String(process.env.DB_SSL_VERIFY || '').trim().toLowerCase() === 'false') {
    logger.warn('DB_SSL_VERIFY=false: the database server certificate is NOT verified');
    return { rejectUnauthorized: false };
  }
  const caPath = (process.env.DB_SSL_CA || '').trim() || path.join(__dirname, 'rds-global-bundle.pem');
  return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: sslConfig(),
  max: 20,
  idleTimeoutMillis: 30000,
  // 2s was too tight for a fresh TLS connection to RDS under load; a slow
  // connect surfaced as "timeout exceeded when trying to connect" -> HTTP 500.
  connectionTimeoutMillis: 10000,
});

pool.on('connect', () => logger.info('Connected to PostgreSQL'));
pool.on('error', (err) => logger.error('PostgreSQL pool error:', err.stack));

module.exports = pool;
