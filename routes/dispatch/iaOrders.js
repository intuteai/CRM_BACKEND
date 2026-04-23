const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/dispatch/iaOrders.controller');

router.use(authenticateToken, (req, res, next) => {
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

router.get('/', checkPermission('ia_orders', 'can_read'), controller.getAll);
router.get('/:id', checkPermission('ia_orders', 'can_read'), controller.getOne);
router.post('/', checkPermission('ia_orders', 'can_write'), controller.create);
router.put('/:id', checkPermission('ia_orders', 'can_write'), controller.update);
router.delete('/:id', checkPermission('ia_orders', 'can_delete'), controller.delete);

module.exports = router;
