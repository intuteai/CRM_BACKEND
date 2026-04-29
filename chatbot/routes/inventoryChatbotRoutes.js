const express = require('express');
const router = express.Router();
const { InventoryChatbotService } = require('../services/inventoryChatbotService');
const { authenticateToken } = require('../../middleware/auth');

router.post('/inventory/chatbot', authenticateToken, async (req, res) => {
  try {
    const { message } = req.body;
    const result = await InventoryChatbotService.handle(message);
    return res.json(result);
  } catch (err) {
    console.error('Inventory chatbot error:', err);
    return res.status(500).json({ success: false, response: 'Server error' });
  }
});

module.exports = router;
