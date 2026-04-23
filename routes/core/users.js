const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/core/users.controller');

router.get('/customers', authenticateToken, checkPermission('Customers', 'can_read'), controller.getCustomers);
router.get('/employees-hr', authenticateToken, controller.getEmployeesHr);

module.exports = router;
