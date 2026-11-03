const express = require('express');
const router = express.Router({ mergeParams: true });
const rateLimit = require('express-rate-limit');
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/core/inventory.controller');

router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: 'Too many requests from this IP, please try again later.' }));

router.post('/', authenticateToken, checkPermission('Inventory', 'can_write'), controller.create);
// Product list for inventory and order forms (customers place orders from it).
router.get('/available', authenticateToken, requireRoles(ROLES.ADMIN, ROLES.CUSTOMER, ROLES.SALES, ROLES.DESIGN, ROLES.PRODUCTION, ROLES.STORE, ROLES.ACCOUNTS), controller.getAvailable);
router.get('/check-part-number', authenticateToken, requireRoles(ROLES.ADMIN, ROLES.SALES, ROLES.PRODUCTION, ROLES.STORE), controller.checkPartNumber);
router.get('/', authenticateToken, checkPermission('Inventory', 'can_read'), controller.getAll);
router.put('/:id', authenticateToken, checkPermission('Inventory', 'can_write'), controller.update);
router.delete('/:id', authenticateToken, checkPermission('Inventory', 'can_write'), controller.delete);
router.post('/:id/hold', authenticateToken, checkPermission('Inventory', 'can_write'), controller.createHold);
router.post('/hold/:hold_id/release', authenticateToken, checkPermission('Inventory', 'can_write'), controller.releaseHold);
router.get('/:id/holds', authenticateToken, checkPermission('Inventory', 'can_read'), controller.getHolds);
router.post('/:id/accept-return', authenticateToken, checkPermission('Inventory', 'can_write'), controller.acceptReturn);

module.exports = router;
