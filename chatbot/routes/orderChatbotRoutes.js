const express = require('express');
const router = express.Router();

const { OrderChatbotService } = require('../services/orderChatbotService');
const { authenticateToken } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');

// The chatbot widget is shown to admin only.
const adminOnly = requireRoles(ROLES.ADMIN);

router.post(
  '/orders/chatbot',
  authenticateToken, adminOnly,
  async (req, res) => {
    try {
      const { message } = req.body;

      const user = {
        user_id: req.user.user_id,
        role_id: req.user.role_id,
        role_name: req.user.role_name,
        name: req.user.name,
      };

      const result = await OrderChatbotService.handle(message, user);
      return res.json(result);
    } catch (err) {
      console.error('Chatbot error:', err);
      return res.status(500).json({
        success: false,
        response: 'Server error',
      });
    }
  }
);

module.exports = router;
