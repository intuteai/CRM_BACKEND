const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/sales/purchaseOrder.controller');

// Purchase order form: admin and sales.
router.use(authenticateToken, requireRoles(ROLES.ADMIN, ROLES.SALES));

router.post('/generate', controller.generate);

module.exports = router;