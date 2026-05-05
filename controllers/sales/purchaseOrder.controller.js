const PurchaseOrder = require('../../models/sales/purchaseOrder');
const logger = require('../../utils/logger');

exports.generate = async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.po_no) return res.status(400).json({ error: 'po_no required' });
    const safeName = String(data.po_no).replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `PO_${safeName}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const pdfStream = PurchaseOrder.generate(data);
    pdfStream.pipe(res);
    logger.info(`Purchase Order generated: ${filename} by ${req.user?.user_id}`);
  } catch (err) {
    logger.error('Purchase Order route error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate purchase order' });
  }
};
