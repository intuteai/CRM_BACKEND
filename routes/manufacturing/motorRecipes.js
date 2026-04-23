const express = require('express');
const router = express.Router();
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/manufacturing/motorRecipes.controller');

const validateRecipeInput = (req, res, next) => {
  const { customer_id, product_id, num_turns, num_coils } = req.body;
  if (!customer_id) return res.status(400).json({ error: 'customer_id is required', code: 'VALIDATION_ERROR' });
  if (!product_id) return res.status(400).json({ error: 'product_id is required', code: 'VALIDATION_ERROR' });
  const turns = parseInt(num_turns);
  const coils = parseInt(num_coils);
  if (!Number.isInteger(turns) || turns <= 0) return res.status(400).json({ error: 'num_turns must be a positive integer', code: 'VALIDATION_ERROR' });
  if (!Number.isInteger(coils) || coils <= 0) return res.status(400).json({ error: 'num_coils must be a positive integer', code: 'VALIDATION_ERROR' });
  req.body.num_turns = turns;
  req.body.num_coils = coils;
  next();
};

router.get('/', authenticateToken, checkPermission('MotorRecipes', 'can_read'), controller.getAll);
router.get('/dropdown-data', authenticateToken, checkPermission('MotorRecipes', 'can_read'), controller.getDropdownData);
router.get('/customer/:customerId', authenticateToken, checkPermission('MotorRecipes', 'can_read'), controller.getByCustomer);
router.get('/:customerId/:productId', authenticateToken, checkPermission('MotorRecipes', 'can_read'), controller.getOne);
router.post('/', authenticateToken, checkPermission('MotorRecipes', 'can_write'), validateRecipeInput, controller.upsert);
router.delete('/:customerId/:productId', authenticateToken, checkPermission('MotorRecipes', 'can_delete'), controller.delete);

module.exports = router;
