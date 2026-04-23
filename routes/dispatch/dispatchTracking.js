const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/dispatch/dispatchTracking.controller');

router.get('/', authenticateToken, checkPermission('DispatchTracking', 'can_read'), controller.getAll);
router.put('/:trackingId', authenticateToken, checkPermission('DispatchTracking', 'can_write'), controller.update);
router.delete('/:trackingId', authenticateToken, checkPermission('DispatchTracking', 'can_delete'), controller.delete);

module.exports = router;
