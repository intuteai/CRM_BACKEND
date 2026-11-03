const express = require('express');
const router = express.Router();
const { BOMChatbotService } = require('../services/bomChatbotService');
const { authenticateToken } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');

// The chatbot widget is shown to admin only.
const adminOnly = requireRoles(ROLES.ADMIN);

router.post('/bom/chatbot', authenticateToken, adminOnly, async (req, res) => {
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
