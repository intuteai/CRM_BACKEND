const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const controller = require('../controllers/auth.controller');

router.post('/login', controller.login);
router.get('/verify-token', authenticateToken, controller.verifyToken);
router.get('/user', authenticateToken, controller.getUser);
router.post('/logout', authenticateToken, controller.logout);
router.put('/update-password', authenticateToken, controller.updatePassword);

module.exports = router;
