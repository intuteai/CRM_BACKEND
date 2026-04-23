const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/core/orders.controller');

router.get('/', authenticateToken, checkPermission('Orders', 'can_read'), controller.getAll);
router.post('/', authenticateToken, checkPermission('Orders', 'can_write'), controller.create);
router.put('/:id/update', authenticateToken, checkPermission('Orders', 'can_write'), controller.update);
router.post('/:id/cancel', authenticateToken, checkPermission('Orders', 'can_write'), controller.cancel);

module.exports = router;
