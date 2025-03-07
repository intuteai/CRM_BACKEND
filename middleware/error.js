const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  logger.error(`${err.message} - ${req.method} ${req.url}`, err.stack);
  res.status(status).json({ error: err.message || 'Server Error', code });
};

module.exports = errorHandler;