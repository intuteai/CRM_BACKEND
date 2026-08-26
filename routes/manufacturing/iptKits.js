const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/manufacturing/iptKits.controller');

router.use(authenticateToken, (req, res, next) => {
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

router.get('/', checkPermission('ipt_kits', 'can_read'), controller.getAll);
router.get('/next-serial', checkPermission('ipt_kits', 'can_read'), controller.nextSerial);
router.get('/:id', checkPermission('ipt_kits', 'can_read'), controller.getOne);
router.post('/', checkPermission('ipt_kits', 'can_write'), controller.create);
router.put('/:id', checkPermission('ipt_kits', 'can_write'), controller.update);
router.delete('/:id', checkPermission('ipt_kits', 'can_delete'), controller.delete);

module.exports = router;
