const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/invoicing/customerInvoices.controller');

router.post('/', authenticateToken, checkPermission('CustomerInvoices', 'can_write'), controller.create);
router.get('/', authenticateToken, checkPermission('CustomerInvoices', 'can_read'), controller.getAll);
router.get('/:id', authenticateToken, checkPermission('CustomerInvoices', 'can_read'), controller.getOne);
router.put('/:id', authenticateToken, checkPermission('CustomerInvoices', 'can_write'), controller.update);
router.delete('/:id', authenticateToken, checkPermission('CustomerInvoices', 'can_delete'), controller.delete);

module.exports = router;
