const express = require('express');
const router = express.Router();
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/core/dashboard.controller');

router.get('/sales-dashboard', authenticateToken, checkPermission('dashboard', 'can_read'), controller.salesDashboard);
router.get('/customer-dashboard', authenticateToken, checkPermission('dashboard', 'can_read'), controller.customerDashboard);
router.get('/admin-dashboard', authenticateToken, checkPermission('dashboard', 'can_read'), controller.adminDashboard);
router.get('/design-dashboard', authenticateToken, checkPermission('dashboard', 'can_read'), controller.designDashboard);
router.get('/production-dashboard', authenticateToken, checkPermission('dashboard', 'can_read'), controller.productionDashboard);
router.get('/stores-dashboard', authenticateToken, checkPermission('dashboard', 'can_read'), controller.storesDashboard);
router.get('/dispatch-dashboard', authenticateToken, checkPermission('dashboard', 'can_read'), controller.dispatchDashboard);
router.get('/accounts-dashboard', authenticateToken, checkPermission('dashboard', 'can_read'), controller.accountsDashboard);
router.get('/', authenticateToken, controller.main);

module.exports = router;
