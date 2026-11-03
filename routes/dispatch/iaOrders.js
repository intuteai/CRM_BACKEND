const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/dispatch/iaOrders.controller');

// Intute AI orders: Intute AI roles only, whatever the permissions table says.
router.use(authenticateToken, requireRoles(ROLES.IA_EMPLOYEE, ROLES.IA_HR));

router.get('/', checkPermission('ia_orders', 'can_read'), controller.getAll);
router.get('/check-serials', checkPermission('ia_orders', 'can_read'), controller.checkSerials);
router.get('/:id', checkPermission('ia_orders', 'can_read'), controller.getOne);
router.post('/', checkPermission('ia_orders', 'can_write'), controller.create);
router.put('/:id', checkPermission('ia_orders', 'can_write'), controller.update);
router.delete('/:id', checkPermission('ia_orders', 'can_delete'), controller.delete);

module.exports = router;
