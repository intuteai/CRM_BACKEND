const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/manufacturing/partDrawings.controller');

router.get('/', authenticateToken, controller.getAll);
router.post('/', authenticateToken, controller.create);
router.put('/:srNo', authenticateToken, controller.update);
router.delete('/:srNo', authenticateToken, controller.delete);

module.exports = router;
