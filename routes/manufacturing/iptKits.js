const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/manufacturing/iptKits.controller');

router.use(authenticateToken, (req, res, next) => {
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

router.post('/', checkPermission('ipt_kits', 'can_write'), controller.create);

module.exports = router;
