const InvoiceRecords = require('../../models/hr/invoiceRecords');
const Invoice = require('../../models/hr/invoice');
const { streamFileToDrive } = require('../../services/googleDrive');
const logger = require('../../utils/logger');

exports.create = async (req, res) => {
  try {
    const record = await InvoiceRecords.create(req.body, req.io);
    logger.info(`invoice record created: ${record.invoiceId} by user ${req.user.user_id}`);
    return res.status(201).json(record);
  } catch (err) {
    logger.error(`POST invoice-records error: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
};

exports.uploadOld = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'A PDF file is required' });
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF files are accepted' });
    }

    const { invoiceNumber, date, customerName, grandTotal } = req.body;
    const record = await InvoiceRecords.createUploaded(
      { invoiceNumber, date, customerName, grandTotal },
      req.file.buffer,
      req.io
    );
    logger.info(`invoice record uploaded: ${record.invoiceId} by user ${req.user.user_id}`);
    return res.status(201).json(record);
  } catch (err) {
    logger.error(`POST invoice-records/upload error: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
};

exports.getAll = async (req, res) => {
  try {
    const { limit, cursor, search } = req.query;
    const data = await InvoiceRecords.getAll({ limit, cursor, search });
    return res.json(data);
  } catch (err) {
    logger.error(`GET invoice-records error: ${err.message}`);
    return res.status(500).json({ error: 'Server error' });
  }
};

exports.getOne = async (req, res) => {
  try {
    const record = await InvoiceRecords.getById(req.params.id);
    return res.json(record);
  } catch (err) {
    return res.status(err.message === 'Invoice not found' ? 404 : 500).json({ error: err.message });
  }
};

exports.delete = async (req, res) => {
  try {
    const result = await InvoiceRecords.delete(req.params.id, req.io);
    logger.info(`invoice record deleted: ${result.invoiceId} by user ${req.user.user_id}`);
    return res.json({ message: 'Invoice deleted', invoiceId: result.invoiceId });
  } catch (err) {
    return res.status(err.message === 'Invoice not found' ? 404 : 500).json({ error: err.message });
  }
};

// Serves the PDF for a saved invoice — regenerated on the fly for
// system-generated invoices (fast, no Drive dependency), or streamed from
// the private Drive copy for uploaded ones (the only copy that exists).
// This single authenticated endpoint backs both "view" and "download" on the
// frontend — they hit the same route and just differ in how the returned
// blob is handled client-side (open in a tab vs. force a save).
exports.downloadPdf = async (req, res) => {
  try {
    const record = await InvoiceRecords.getById(req.params.id);
    const safeInvoiceNo = record.invoiceNumber.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="INVOICE_${safeInvoiceNo}.pdf"`);

    if (record.source === 'uploaded') {
      if (!record.driveFileId) return res.status(404).json({ error: 'Stored file not found' });
      return await streamFileToDrive(record.driveFileId, res);
    }

    res.setHeader('Content-Type', 'application/pdf');
    const stream = Invoice.generate(record, req.io);
    stream.pipe(res);
  } catch (err) {
    logger.error(`GET invoice-records/:id/pdf error: ${err.message}`);
    const status = err.message === 'Invoice not found' ? 404 : 400;
    if (!res.headersSent) res.status(status).json({ error: err.message });
  }
};
