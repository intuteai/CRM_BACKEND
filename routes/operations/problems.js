const express = require('express');
const router = express.Router();
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/operations/problems.controller');

router.get('/', authenticateToken, checkPermission('Problems', 'can_read'), controller.getAll);
router.post('/', authenticateToken, checkPermission('Problems', 'can_write'), controller.create);
router.post('/:id/solutions', authenticateToken, checkPermission('Problems', 'can_write'), controller.addSolution);

module.exports = router;
