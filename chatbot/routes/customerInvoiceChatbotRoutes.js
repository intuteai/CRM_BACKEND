const express = require('express');
const router = express.Router();
const { CustomerInvoiceChatbotService } = require('../services/customerInvoiceChatbotService');
const { authenticateToken } = require('../../middleware/auth');

router.post('/customer-invoices/chatbot', authenticateToken, async (req, res) => {
  try {
    const { message } = req.body;
    const result = await CustomerInvoiceChatbotService.handle(message);
    return res.json(result);
  } catch (err) {
    console.error('Customer invoice chatbot error:', err);
    return res.status(500).json({ success: false, response: 'Server error' });
  }
});

module.exports = router;
