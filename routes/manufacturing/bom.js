const express = require('express');
const router = express.Router({ mergeParams: true });
const { body, param, query, validationResult } = require('express-validator');
const { authenticateToken } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/manufacturing/bom.controller');

// Matches the /bom page (CRM routeConfig): admin and design get the full page
// with delete; store and production get their own create/edit pages.
const canUse = requireRoles(ROLES.ADMIN, ROLES.DESIGN, ROLES.STORE, ROLES.PRODUCTION);
const canDelete = requireRoles(ROLES.ADMIN, ROLES.DESIGN);

const validateBOM = [
  body('productId').isInt({ min: 1 }).withMessage('Product ID must be a positive integer'),
  body('materials').isArray({ min: 1 }).withMessage('Materials must be a non-empty array'),
  body('materials.*.materialId').isInt({ min: 1 }).withMessage('Material ID must be a positive integer'),
  body('materials.*.quantityPerUnit').isFloat({ gt: 0 }).withMessage('Quantity per unit must be a positive number'),
];
const validateId = [param('id').isInt({ min: 1 }).withMessage('BOM ID must be a positive integer')];
const validateQuery = [query('limit').optional().isInt({ min: 1, max: 100 }), query('offset').optional().isInt({ min: 0 })];

router.get('/', authenticateToken, canUse, validateQuery, controller.getAll);
router.get('/:id', authenticateToken, canUse, validateId, controller.getOne);
router.post('/', authenticateToken, canUse, validateBOM, controller.create);
router.put('/:id', authenticateToken, canUse, validateId, validateBOM, controller.update);
router.delete('/:id', authenticateToken, canDelete, validateId, controller.delete);

module.exports = router;
