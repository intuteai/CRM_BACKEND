const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/manufacturing/parts.controller');

const validateCreateOrUpdate = (req, res, next) => {
  const { partTypeId, name, description, drawingNo, customerPartNo, supplierPartNo } = req.body;
  if (req.method === 'POST' && (!partTypeId || typeof partTypeId !== 'number')) return res.status(400).json({ error: 'Invalid or missing partTypeId', code: 'INVALID_INPUT' });
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Invalid or missing name', code: 'INVALID_INPUT' });
  if (!description || typeof description !== 'string') return res.status(400).json({ error: 'Invalid or missing description', code: 'INVALID_INPUT' });
  if (!drawingNo || typeof drawingNo !== 'string') return res.status(400).json({ error: 'Invalid or missing drawingNo', code: 'INVALID_INPUT' });
  if (customerPartNo && typeof customerPartNo !== 'string') return res.status(400).json({ error: 'Invalid customerPartNo', code: 'INVALID_INPUT' });
  if (supplierPartNo && typeof supplierPartNo !== 'string') return res.status(400).json({ error: 'Invalid supplierPartNo', code: 'INVALID_INPUT' });
  next();
};

router.get('/', authenticateToken, checkPermission('Parts', 'can_read'), controller.getAll);
router.get('/types', authenticateToken, checkPermission('Parts', 'can_read'), controller.getPartTypes);
router.get('/next-code', authenticateToken, checkPermission('Parts', 'can_write'), controller.previewNextCode);
router.post('/', authenticateToken, checkPermission('Parts', 'can_write'), validateCreateOrUpdate, controller.create);
router.put('/:id', authenticateToken, checkPermission('Parts', 'can_write'), validateCreateOrUpdate, controller.update);
router.delete('/:id', authenticateToken, checkPermission('Parts', 'can_delete'), controller.delete);

module.exports = router;
