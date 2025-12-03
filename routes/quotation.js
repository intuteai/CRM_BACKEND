// routes/quotation.js
const express = require('express');
const router = express.Router();
const Quotation = require('../models/quotation');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

router.use(authenticateToken, (req, res, next) => {
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

router.post('/generate', async (req, res) => {
  try {
    const data = req.body || {};

    if (!data.quotation_no) {
      return res.status(400).json({ error: 'quotation_no required' });
    }

    // sanitize filename
    const safeName = String(data.quotation_no).replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `QUOTATION_${safeName}.pdf`;

    // streaming headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Generate PDF and pipe directly
    const pdfStream = Quotation.generate(data);
    pdfStream.pipe(res);

    logger.info(`Quotation generated: ${filename} by ${req.user?.user_id}`);

  } catch (err) {
    logger.error('Quotation route error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate quotation' });
    }
  }
});

module.exports = router;
