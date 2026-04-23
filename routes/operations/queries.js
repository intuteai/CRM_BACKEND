const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/queries.controller');

router.get('/', authenticateToken, controller.getAll);
router.post('/', authenticateToken, controller.create);
router.put('/:id/respond', authenticateToken, controller.respond);
router.put('/:id/in-progress', authenticateToken, controller.setInProgress);
router.put('/:id/close', authenticateToken, controller.close);

router.use((error, req, res, next) => {
  const status = error.statusCode || 500;
  res.status(status).json({ error: error.message || 'Internal Server Error' });
});

module.exports = router;
