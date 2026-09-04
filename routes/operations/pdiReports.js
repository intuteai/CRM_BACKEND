const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdiReports.controller');

router.post('/', authenticateToken, controller.createReport);
router.get('/:id', authenticateToken, controller.getReport);

module.exports = router;
