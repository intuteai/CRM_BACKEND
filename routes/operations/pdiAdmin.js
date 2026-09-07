const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdi.admin.controller');

router.get('/', authenticateToken, controller.listTemplates);
router.get('/:id', authenticateToken, controller.getTemplate);
router.post('/', authenticateToken, controller.createTemplate);
router.put('/:id', authenticateToken, controller.saveTemplate);
router.post('/:id/publish', authenticateToken, controller.publishTemplate);
router.post('/:id/archive', authenticateToken, controller.archiveTemplate);
router.post('/:id/preview', authenticateToken, controller.previewTemplate);

module.exports = router;
