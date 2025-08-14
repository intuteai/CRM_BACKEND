const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5000, // Increased to 5000 requests
  message: { error: 'Too many requests, please wait and try again', code: 'RATE_LIMIT_EXCEEDED' },
  keyGenerator: (req) => {
    // Use user_id for authenticated users, fallback to IP
    return req.user ? req.user.user_id : req.ip;
  },
  onLimitReached: (req, res, options) => {
    logger.warn(`Rate limit hit by ${req.user ? `user ${req.user.user_id}` : `IP ${req.ip}`} at ${req.url}`);
  }
});

module.exports = limiter;