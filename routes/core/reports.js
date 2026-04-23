const express = require('express');
const router = express.Router();
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/core/reports.controller');

router.get('/order-summary', authenticateToken, checkPermission('Reports', 'can_read'), controller.orderSummary);
router.get('/inventory-status', authenticateToken, checkPermission('Reports', 'can_read'), controller.inventoryStatus);

module.exports = router;
