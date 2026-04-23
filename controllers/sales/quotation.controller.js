const Quotation = require('../../models/sales/quotation');
const logger = require('../../utils/logger');

exports.generate = async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.quotation_no) return res.status(400).json({ error: 'quotation_no required' });
    const safeName = String(data.quotation_no).replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `QUOTATION_${safeName}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const pdfStream = Quotation.generate(data);
    pdfStream.pipe(res);
    logger.info(`Quotation generated: ${filename} by ${req.user?.user_id}`);
  } catch (err) {
    logger.error('Quotation route error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate quotation' });
  }
};
