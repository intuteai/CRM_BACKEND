const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/hr/employeeDetails.controller');

router.get('/', authenticateToken, checkPermission('employee_details', 'can_read'), controller.getAll);
router.get('/:employee_id', authenticateToken, checkPermission('employee_details', 'can_read'), controller.getOne);
router.patch('/:employee_id', authenticateToken, checkPermission('employee_details', 'can_write'), controller.update);

module.exports = router;
