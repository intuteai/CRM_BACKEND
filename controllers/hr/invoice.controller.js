const Invoice = require('../../models/hr/invoice');
const logger = require('../../utils/logger');

exports.generate = async (req, res) => {
  try {
    const data = req.body;
    if (!data.invoiceNumber?.trim() || !data.billing?.name?.trim()) {
      return res.status(400).json({ error: 'Invoice number and billing name are required' });
    }
    const safeInvoiceNo = data.invoiceNumber.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `INVOICE_${safeInvoiceNo}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const stream = Invoice.generate(data, req.io);
    stream.pipe(res);
    logger.info(`Invoice generated: ${filename} by ${req.user.user_id}`);
  } catch (error) {
    logger.error('Invoice route error:', error.message);
    if (!res.headersSent) res.status(400).json({ error: error.message });
  }
};
