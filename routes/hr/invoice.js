const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/hr/invoice.controller');

// Intute AI invoice (Intute AI is the seller): Intute AI roles only.
router.use(authenticateToken, requireRoles(ROLES.IA_EMPLOYEE, ROLES.IA_HR));

router.post('/generate', controller.generate);

module.exports = router;