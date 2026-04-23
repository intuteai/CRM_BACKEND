const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/invoicing/purchaseInvoices.controller');

const validateInvoiceInput = (req, res, next) => {
  const { supplierCode, supplierName, invoiceNumber, issueDate, description, unitPrice, quantity, linkPdf, productId } = req.body;
  if (!supplierCode || typeof supplierCode !== 'string' || !supplierName || typeof supplierName !== 'string' || !invoiceNumber || typeof invoiceNumber !== 'string' || !issueDate || isNaN(Date.parse(issueDate)) || !description || typeof description !== 'string' || !unitPrice || typeof unitPrice !== 'number' || unitPrice < 0 || !quantity || typeof quantity !== 'number' || quantity < 0 || (linkPdf && typeof linkPdf !== 'string') || !productId || typeof productId !== 'number' || productId < 1) {
    return res.status(400).json({ error: 'Invalid input data' });
  }
  next();
};

router.get('/', authenticateToken, controller.getAll);
router.post('/', authenticateToken, validateInvoiceInput, controller.create);
router.put('/:invoiceId', authenticateToken, validateInvoiceInput, controller.update);
router.delete('/:invoiceId', authenticateToken, controller.delete);

module.exports = router;
