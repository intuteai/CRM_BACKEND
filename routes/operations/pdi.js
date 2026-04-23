const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdi.controller');

router.post('/', authenticateToken, controller.create);
router.get('/', authenticateToken, controller.getAll);
router.get('/:id', authenticateToken, controller.getOne);
router.put('/:id', authenticateToken, controller.update);
router.delete('/:id', authenticateToken, controller.delete);

module.exports = router;
