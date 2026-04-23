const express = require('express');
const router = express.Router();
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/core/customers.controller');

const validatePagination = (req, res, next) => {
  req.safeLimit = Math.min(parseInt(req.query.limit) || 10, 100);
  req.safeOffset = Math.max(parseInt(req.query.offset) || 0, 0);
  next();
};

const validateCustomerInput = (req, res, next) => {
  const { name, contact_person, city, phone, email, gst, shipping_address, billing_address } = req.body;
  if (!name || name.length < 3) return res.status(400).json({ error: 'Name must be at least 3 characters', code: 'VALIDATION_ERROR' });
  if (!contact_person || contact_person.length < 3) return res.status(400).json({ error: 'Contact person is required', code: 'VALIDATION_ERROR' });
  if (!city) return res.status(400).json({ error: 'City is required', code: 'VALIDATION_ERROR' });
  if (!phone || !/^[0-9]{10}$/.test(phone)) return res.status(400).json({ error: 'Phone must be a valid 10-digit number', code: 'VALIDATION_ERROR' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address', code: 'VALIDATION_ERROR' });
  if (gst && !/^[0-9A-Z]{15}$/.test(gst)) return res.status(400).json({ error: 'GST must be a 15-character alphanumeric code', code: 'VALIDATION_ERROR' });
  if (!shipping_address) return res.status(400).json({ error: 'Shipping address is required', code: 'VALIDATION_ERROR' });
  if (!billing_address) return res.status(400).json({ error: 'Billing address is required', code: 'VALIDATION_ERROR' });
  next();
};

router.get('/', authenticateToken, checkPermission('Customers', 'can_read'), validatePagination, controller.getAll);
router.post('/', authenticateToken, checkPermission('Customers', 'can_create'), validateCustomerInput, controller.create);

module.exports = router;
