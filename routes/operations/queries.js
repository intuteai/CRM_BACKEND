const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/operations/queries.controller');

// Customers raise and close their own queries; Compage staff on the query
// pages (admin, sales, design, production, dispatch) answer them.
const STAFF = [ROLES.ADMIN, ROLES.SALES, ROLES.DESIGN, ROLES.PRODUCTION, ROLES.DISPATCH];
const canRead = requireRoles(ROLES.CUSTOMER, ...STAFF);
const canCreate = requireRoles(ROLES.CUSTOMER);
const canAnswer = requireRoles(...STAFF);
const canClose = requireRoles(ROLES.CUSTOMER, ...STAFF);

router.get('/', authenticateToken, canRead, controller.getAll);
router.post('/', authenticateToken, canCreate, controller.create);
router.put('/:id/respond', authenticateToken, canAnswer, controller.respond);
router.put('/:id/in-progress', authenticateToken, canAnswer, controller.setInProgress);
router.put('/:id/close', authenticateToken, canClose, controller.close);

router.use((error, req, res, next) => {
  const status = error.statusCode || 500;
  res.status(status).json({ error: error.message || 'Internal Server Error' });
});

module.exports = router;
