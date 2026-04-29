const express = require('express');
const router = express.Router();
const { RawMaterialChatbotService } = require('../services/rawMaterialChatbotService');
const { authenticateToken } = require('../../middleware/auth');

router.post('/stock/chatbot', authenticateToken, async (req, res) => {
  try {
    const { message } = req.body;
    const result = await RawMaterialChatbotService.handle(message);
    return res.json(result);
  } catch (err) {
    console.error('Raw material chatbot error:', err);
    return res.status(500).json({ success: false, response: 'Server error' });
  }
});

module.exports = router;
