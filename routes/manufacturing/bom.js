const express = require('express');
const router = express.Router({ mergeParams: true });
const { body, param, query, validationResult } = require('express-validator');
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/manufacturing/bom.controller');

const validateBOM = [
  body('productId').isInt({ min: 1 }).withMessage('Product ID must be a positive integer'),
  body('materials').isArray({ min: 1 }).withMessage('Materials must be a non-empty array'),
  body('materials.*.materialId').isInt({ min: 1 }).withMessage('Material ID must be a positive integer'),
  body('materials.*.quantityPerUnit').isFloat({ gt: 0 }).withMessage('Quantity per unit must be a positive number'),
];
const validateId = [param('id').isInt({ min: 1 }).withMessage('BOM ID must be a positive integer')];
const validateQuery = [query('limit').optional().isInt({ min: 1, max: 100 }), query('offset').optional().isInt({ min: 0 })];

router.get('/', authenticateToken, validateQuery, controller.getAll);
router.get('/:id', authenticateToken, validateId, controller.getOne);
router.post('/', authenticateToken, validateBOM, controller.create);
router.put('/:id', authenticateToken, validateId, validateBOM, controller.update);
router.delete('/:id', authenticateToken, validateId, controller.delete);

module.exports = router;
