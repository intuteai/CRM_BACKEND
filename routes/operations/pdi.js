const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const { requirePdiAccess } = require('../../middleware/pdiAccess');
const controller = require('../../controllers/operations/pdi.controller');

router.get('/templates', authenticateToken, requirePdiAccess, controller.getTemplates);
router.get('/templates/:id/definition', authenticateToken, requirePdiAccess, controller.getTemplateDefinition);

module.exports = router;
