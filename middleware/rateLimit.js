const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user ? String(req.user.user_id) : req.ip,
  handler: (req, res, next, options) => {
    logger.warn(`Rate limit exceeded — ${req.user ? `user ${req.user.user_id}` : `IP ${req.ip}`} at ${req.method} ${req.url}`);
    res.status(options.statusCode).json(options.message);
  },
  message: { error: 'Too many requests, please wait and try again', code: 'RATE_LIMIT_EXCEEDED' },
});

module.exports = limiter;
