const express = require('express');
const router = express.Router();
const { CustomerChatbotService } = require('../services/customerChatbotService');
const { authenticateToken } = require('../../middleware/auth');

router.post('/customers/chatbot', authenticateToken, async (req, res) => {
  try {
    const { message } = req.body;
    const result = await CustomerChatbotService.handle(message);
    return res.json(result);
  } catch (err) {
    console.error('Customer chatbot error:', err);
    return res.status(500).json({ success: false, response: 'Server error' });
  }
});

module.exports = router;
