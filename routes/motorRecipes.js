const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const MotorRecipe = require('../models/motorRecipe');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');

const validateRecipeInput = (req, res, next) => {
  const { customer_id, product_id, num_turns, num_coils } = req.body;
  if (!customer_id) return res.status(400).json({ error: 'customer_id is required', code: 'VALIDATION_ERROR' });
  if (!product_id)  return res.status(400).json({ error: 'product_id is required',  code: 'VALIDATION_ERROR' });
  const turns = parseInt(num_turns);
  const coils = parseInt(num_coils);
  if (!Number.isInteger(turns) || turns <= 0) return res.status(400).json({ error: 'num_turns must be a positive integer', code: 'VALIDATION_ERROR' });
  if (!Number.isInteger(coils) || coils <= 0) return res.status(400).json({ error: 'num_coils must be a positive integer', code: 'VALIDATION_ERROR' });
  req.body.num_turns = turns;
  req.body.num_coils = coils;
  next();
};

// GET /api/motor-recipes — all recipes (paginated)
router.get('/',
  authenticateToken,
  checkPermission('MotorRecipes', 'can_read'),
  async (req, res, next) => {
    try {
      const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
      const offset = Math.max(parseInt(req.query.offset) || 0,  0);
      const result = await MotorRecipe.getAll({ limit, offset });
      res.json(result);
    } catch (err) {
      logger.error(`GET /motor-recipes: ${err.message}`, err.stack);
      next(err);
    }
  }
);

// GET /api/motor-recipes/dropdown-data — customers + inventory for dropdowns
router.get('/dropdown-data',
  authenticateToken,
  checkPermission('MotorRecipes', 'can_read'),
  async (req, res, next) => {
    try {
      const [customersResult, inventoryResult] = await Promise.all([
        pool.query(`
          SELECT c.customer_id, u.name AS customer_name
          FROM customers c
          JOIN users u ON c.user_id = u.user_id
          ORDER BY u.name ASC
        `),
        pool.query(`
          SELECT product_id, product_name, product_code
          FROM inventory
          ORDER BY product_name ASC
        `),
      ]);
      res.json({
        customers: customersResult.rows,
        inventory: inventoryResult.rows,
      });
    } catch (err) {
      logger.error(`GET /motor-recipes/dropdown-data: ${err.message}`, err.stack);
      next(err);
    }
  }
);

// GET /api/motor-recipes/customer/:customerId — all recipes for a customer
router.get('/customer/:customerId',
  authenticateToken,
  checkPermission('MotorRecipes', 'can_read'),
  async (req, res, next) => {
    try {
      const recipes = await MotorRecipe.getByCustomer(req.params.customerId);
      res.json({ data: recipes, total: recipes.length });
    } catch (err) {
      logger.error(`GET /motor-recipes/customer/${req.params.customerId}: ${err.message}`, err.stack);
      next(err);
    }
  }
);

// GET /api/motor-recipes/:customerId/:productId — single recipe
router.get('/:customerId/:productId',
  authenticateToken,
  checkPermission('MotorRecipes', 'can_read'),
  async (req, res, next) => {
    try {
      const recipe = await MotorRecipe.getOne(req.params.customerId, req.params.productId);
      if (!recipe) return res.status(404).json({ error: 'Recipe not found', code: 'NOT_FOUND' });
      res.json(recipe);
    } catch (err) {
      logger.error(`GET /motor-recipes/${req.params.customerId}/${req.params.productId}: ${err.message}`, err.stack);
      next(err);
    }
  }
);

// POST /api/motor-recipes — create or update (upsert)
router.post('/',
  authenticateToken,
  checkPermission('MotorRecipes', 'can_write'),
  validateRecipeInput,
  async (req, res, next) => {
    try {
      const { customer_id, product_id, num_turns, num_coils, notes } = req.body;
      const recipe = await MotorRecipe.upsert({ customer_id, product_id, num_turns, num_coils, notes });
      logger.info(`Motor recipe upserted: customer=${customer_id} product=${product_id} by user=${req.user.user_id}`);
      res.status(201).json(recipe);
    } catch (err) {
      logger.error(`POST /motor-recipes: ${err.message}`, err.stack);
      next(err);
    }
  }
);

// DELETE /api/motor-recipes/:customerId/:productId
router.delete('/:customerId/:productId',
  authenticateToken,
  checkPermission('MotorRecipes', 'can_delete'),
  async (req, res, next) => {
    try {
      const deleted = await MotorRecipe.delete(req.params.customerId, req.params.productId);
      logger.info(`Motor recipe deleted: customer=${req.params.customerId} product=${req.params.productId} by user=${req.user.user_id}`);
      res.json({ message: 'Recipe deleted successfully', recipe: deleted });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: err.message, code: err.code });
      logger.error(`DELETE /motor-recipes: ${err.message}`, err.stack);
      next(err);
    }
  }
);

module.exports = router;