const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/hr/payslip.controller');

// Intute AI payslips: the /hr-payslips page is ia_hr only.
router.use(authenticateToken, requireRoles(ROLES.IA_HR));

router.post('/generate', controller.generate);

module.exports = router;