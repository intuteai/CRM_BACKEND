const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/core/users.controller');

router.get('/customers', authenticateToken, checkPermission('Customers', 'can_read'), controller.getCustomers);
// Team list for the activities pages; the controller returns only the
// caller's own organization.
router.get('/employees-hr', authenticateToken, requireRoles(ROLES.HR, ROLES.IA_EMPLOYEE, ROLES.IA_HR), controller.getEmployeesHr);

module.exports = router;
