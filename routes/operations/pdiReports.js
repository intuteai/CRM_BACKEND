const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdiReports.controller');

router.post('/', authenticateToken, controller.createReport);
router.get('/', authenticateToken, controller.listReports);
router.get('/:id', authenticateToken, controller.getReport);
router.patch('/:id', authenticateToken, controller.patchReport);
router.post('/:id/finalize', authenticateToken, controller.finalizeReport);

module.exports = router;
