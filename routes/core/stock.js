const express = require('express');
const router = express.Router({ mergeParams: true });
const multer = require('multer');
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/core/stock.controller');

// Body and :productId validation happens in the controller (stock.validation.js),
// so every route answers a bad request with the same error shape.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// multer's "file too large" would otherwise surface as a 500.
const uploadPhoto = (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res.status(400).json({
      error: tooLarge ? 'Photo is too large (max 8 MB)' : `Upload failed: ${err.message}`,
      code: 'INVALID_INPUT',
    });
  });
};

router.get('/check-part-number', authenticateToken, requireRoles(ROLES.ADMIN, ROLES.SALES, ROLES.PRODUCTION, ROLES.STORE, ROLES.DISPATCH), controller.checkPartNumber);
router.get('/', authenticateToken, checkPermission('Stock', 'can_read'), controller.getAll);
router.post('/', authenticateToken, checkPermission('Stock', 'can_write'), controller.create);
router.get('/:productId/adjustments', authenticateToken, checkPermission('Stock', 'can_read'), controller.getAdjustments);
router.put('/:productId', authenticateToken, checkPermission('Stock', 'can_write'), controller.update);
router.post('/:productId/photo', authenticateToken, checkPermission('Stock', 'can_write'), uploadPhoto, controller.uploadPhoto);
router.delete('/:productId', authenticateToken, checkPermission('Stock', 'can_delete'), controller.delete);
router.post('/:productId/adjust', authenticateToken, checkPermission('Stock', 'can_write'), controller.adjust);
router.post('/:productId/accept-return', authenticateToken, checkPermission('Stock', 'can_write'), controller.acceptReturn);

module.exports = router;
