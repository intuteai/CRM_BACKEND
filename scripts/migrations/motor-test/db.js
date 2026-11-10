// Shared connection settings for the motor-test migration tools.
// TLS is verified against the public AWS RDS CA bundle (rds-global-bundle.pem, from
// https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem). DB_SSL_CA overrides the path.
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const env = (k) => (process.env[k] || '').trim();

function connectionConfig(database) {
  const caPath = env('DB_SSL_CA') || path.join(__dirname, 'rds-global-bundle.pem');
  return {
    host: env('DB_HOST'), port: Number(env('DB_PORT')), user: env('DB_USER'), password: env('DB_PASSWORD'),
    database, ssl: { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') },
  };
}

module.exports = { connectionConfig };
