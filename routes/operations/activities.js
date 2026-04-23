const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/activities.controller');

const ALLOWED_ROLES = [9, 10, 11, 12];

router.use(authenticateToken, (req, res, next) => {
  if (!ALLOWED_ROLES.includes(req.user.role_id)) {
    return res.status(403).json({ error: 'Not authorized to access activities' });
  }
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

router.post('/', controller.create);
router.get('/', controller.getAll);
router.get('/:id', controller.getOne);
router.put('/:id', controller.update);
router.delete('/:id', controller.delete);

module.exports = router;
