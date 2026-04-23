const express = require('express');
const router = express.Router({ mergeParams: true });
const multer = require('multer');
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/core/stock.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const validateStockInput = (req, res, next) => {
  const { productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl } = req.body;
  if (!productName || typeof productName !== 'string' || (description && typeof description !== 'string') || !productCode || typeof productCode !== 'string' || (price === undefined || typeof price !== 'number' || price < 0) || (stockQuantity !== undefined && (typeof stockQuantity !== 'number' || stockQuantity < 0)) || (qtyRequired !== undefined && (typeof qtyRequired !== 'number' || qtyRequired < 0)) || (location !== undefined && typeof location !== 'string') || (imageUrl !== undefined && imageUrl !== null && typeof imageUrl !== 'string')) {
    return res.status(400).json({ error: 'Invalid input data', code: 'INVALID_INPUT' });
  }
  next();
};

const validateAdjustInput = (req, res, next) => {
  const { quantity, reason } = req.body;
  if (quantity === undefined || typeof quantity !== 'number' || (reason && typeof reason !== 'string')) {
    return res.status(400).json({ error: 'Invalid adjustment data', code: 'INVALID_INPUT' });
  }
  next();
};

router.get('/', authenticateToken, checkPermission('Stock', 'can_read'), controller.getAll);
router.post('/', authenticateToken, checkPermission('Stock', 'can_write'), validateStockInput, controller.create);
router.put('/:productId', authenticateToken, checkPermission('Stock', 'can_write'), validateStockInput, controller.update);
router.post('/:productId/photo', authenticateToken, checkPermission('Stock', 'can_write'), upload.single('photo'), controller.uploadPhoto);
router.delete('/:productId', authenticateToken, checkPermission('Stock', 'can_delete'), controller.delete);
router.post('/:productId/adjust', authenticateToken, checkPermission('Stock', 'can_write'), validateAdjustInput, controller.adjust);

module.exports = router;
