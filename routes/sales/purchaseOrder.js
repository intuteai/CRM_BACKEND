const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/sales/purchaseOrder.controller');

router.use(authenticateToken, (req, res, next) => {
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

router.post('/generate', controller.generate);

module.exports = router;
