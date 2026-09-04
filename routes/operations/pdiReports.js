const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdiReports.controller');

router.post('/', authenticateToken, controller.createReport);

module.exports = router;
