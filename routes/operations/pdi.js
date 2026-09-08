const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdi.controller');

router.get('/templates', authenticateToken, controller.getTemplates);
router.get('/templates/:id/definition', authenticateToken, controller.getTemplateDefinition);

module.exports = router;
