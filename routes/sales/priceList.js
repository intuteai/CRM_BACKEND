const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/sales/priceList.controller');

router.get('/', authenticateToken, checkPermission('PriceList', 'can_read'), controller.getAll);
router.post('/', authenticateToken, checkPermission('PriceList', 'can_write'), controller.create);
router.put('/:priceId', authenticateToken, checkPermission('PriceList', 'can_write'), controller.update);
router.delete('/:priceId', authenticateToken, checkPermission('PriceList', 'can_delete'), controller.delete);

module.exports = router;
