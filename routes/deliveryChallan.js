const express = require('express');
const router = express.Router();
const DeliveryChallan = require('../models/deliveryChallan');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

// attach socket.io like in proforma route (optional)
router.use(authenticateToken, (req, res, next) => {
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

router.post('/generate', async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.challan_no) {
      return res.status(400).json({ error: 'challan_no required' });
    }

    const safeName = String(data.challan_no).replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `DELIVERY_CHALLAN_${safeName}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    );

    const pdfStream = DeliveryChallan.generate(data);
    pdfStream.pipe(res);

    pdfStream.on('error', (err) => {
      logger.error('Delivery challan PDF stream error', err);
      if (!res.headersSent) res.status(500).end('PDF generation failed');
    });

    res.on('close', () => {
      try {
        pdfStream.destroy && pdfStream.destroy();
      } catch (e) {}
    });

    logger.info(
      `Delivery challan generated: ${filename} by ${req.user?.user_id}`
    );
  } catch (err) {
    logger.error('Delivery challan route error:', err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ error: 'Failed to generate delivery challan' });
    }
  }
});

module.exports = router;


