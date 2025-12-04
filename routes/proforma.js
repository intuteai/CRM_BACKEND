// routes/proforma.js
const express = require('express');
const router = express.Router();
const Proforma = require('../models/proforma');
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
    if (!data.proforma_no) return res.status(400).json({ error: 'proforma_no required' });

    const safeName = String(data.proforma_no).replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `PROFORMA_${safeName}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const pdfStream = Proforma.generate(data);
    pdfStream.pipe(res);

    pdfStream.on('error', (err) => {
      logger.error('PDF stream error', err);
      if (!res.headersSent) res.status(500).end('PDF generation failed');
    });
    res.on('close', () => {
      try { pdfStream.destroy && pdfStream.destroy(); } catch (e) {}
    });

    logger.info(`Proforma generated: ${filename} by ${req.user?.user_id}`);
  } catch (err) {
    logger.error('Proforma route error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate proforma' });
  }
});

module.exports = router;
