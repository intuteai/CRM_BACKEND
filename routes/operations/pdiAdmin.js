const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdi.admin.controller');

router.use(authenticateToken, (req, res, next) => {
  if (req.user.role_id !== 1) return res.status(403).json({ error: 'Admin only' });
  next();
});

router.get('/', controller.listTemplates);
router.get('/:id', controller.getTemplate);
router.post('/', controller.createTemplate);
router.put('/:id', controller.saveTemplate);
router.post('/:id/publish', controller.publishTemplate);
router.post('/:id/archive', controller.archiveTemplate);
router.post('/:id/preview', controller.previewTemplate);
router.delete('/:id', controller.deleteTemplate);

module.exports = router;
