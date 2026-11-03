const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/dispatch/deliveryChallan.controller');

// Delivery challan form: admin only. It also changes returnable stock.
router.use(authenticateToken, requireRoles(ROLES.ADMIN));

router.post('/generate', controller.generate);

module.exports = router;