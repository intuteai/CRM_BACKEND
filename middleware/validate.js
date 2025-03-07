const { check, validationResult } = require('express-validator');

const validateUser = [
  check('name').notEmpty().withMessage('Name is required'),
  check('email').isEmail().withMessage('Valid email is required'),
  check('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array(), code: 'VALIDATION_ERROR' });
    }
    next();
  },
];

module.exports = { validateUser };