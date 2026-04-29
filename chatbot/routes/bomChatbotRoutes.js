const express = require('express');
const router = express.Router();
const { BOMChatbotService } = require('../services/bomChatbotService');
const { authenticateToken } = require('../../middleware/auth');

router.post('/bom/chatbot', authenticateToken, async (req, res) => {
  try {
    const { message } = req.body;
    const result = await BOMChatbotService.handle(message);
    return res.json(result);
  } catch (err) {
    console.error('BOM chatbot error:', err);
    return res.status(500).json({ success: false, response: 'Server error' });
  }
});

module.exports = router;
