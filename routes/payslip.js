// routes/payslip.js
const express = require('express');
const router = express.Router({ mergeParams: true });
const Payslip = require('../models/payslip');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

// Middleware: Attach io + user
router.use(authenticateToken, (req, res, next) => {
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

// POST /api/payslip/generate
router.post('/generate', async (req, res) => {
  try {
    const data = req.body;

    // Basic validation
    if (!data.employee?.name || !data.period) {
      return res.status(400).json({ error: 'Employee name and period required' });
    }

    // Generate filename
    const safeName = data.employee.name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    const safePeriod = data.period.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `PAYSLIP_${safeName}_${safePeriod}.pdf`;

    // Set headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Generate and stream PDF
    const stream = Payslip.generate(data, req.io);
    stream.pipe(res);

    logger.info(`Payslip generated: ${filename} by ${req.user.user_id}`);

  } catch (error) {
    logger.error('Payslip route error:', error.message);
    if (!res.headersSent) {
      res.status(400).json({ error: error.message });
    }
  }
});

module.exports = router;