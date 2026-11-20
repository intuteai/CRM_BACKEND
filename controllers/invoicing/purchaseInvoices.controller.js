const PurchaseInvoice = require('../../models/invoicing/purchaseInvoice');
const redis = require('../../config/redis');
const logger = require('../../utils/logger');
const pool = require('../../config/db');

// The purchase_invoices trigger changes raw_materials.stock_quantity; tell the
// raw-material pages so their numbers move without a reload.
async function emitRawStock(req, productIds) {
  const ids = [...new Set(productIds.filter((id) => id !== null && id !== undefined).map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0);
  for (const id of ids) {
    try {
      const { rows } = await pool.query(
        'SELECT product_id, stock_quantity, returnable_qty, qty_required, location, image_url FROM raw_materials WHERE product_id = $1',
        [id]
      );
      if (!rows.length) continue;
      const r = rows[0];
      logger.info(`Purchase invoice changed stock for raw material ${id}: now ${r.stock_quantity}`);
      req.io?.emit('stockUpdate', {
        source: 'raw_materials',
        product_id: Number(r.product_id),
        stock_quantity: Number(r.stock_quantity),
        returnable_qty: Number(r.returnable_qty),
        qty_required: Number(r.qty_required ?? 0),
        location: r.location ?? null,
        image_url: r.image_url ?? null,
      });
    } catch (err) {
      logger.warn(`Could not send stock update for raw material ${id}: ${err.message}`);
    }
  }
}

exports.getAll = async (req, res) => {
  const { limit = 10, offset = 0, force_refresh = false } = req.query;
  const cacheKey = `purchase_invoices_${limit}_${offset}`;
  try {
    if (force_refresh === 'true') await redis.del(cacheKey);
    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') { logger.info(`Cache hit for ${cacheKey}`); return res.json(JSON.parse(cached)); }
    const invoices = await PurchaseInvoice.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
    await redis.setEx(cacheKey, 300, JSON.stringify(invoices));
    res.json(invoices);
  } catch (error) {
    logger.error(`Error fetching invoices: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.create = async (req, res) => {
  const { supplierCode, supplierName, invoiceNumber, issueDate, description, unitPrice, quantity, linkPdf, productId } = req.body;
  try {
    const invoice = await PurchaseInvoice.create({ supplierCode, supplierName, invoiceNumber, issueDate, description, unitPrice, quantity, linkPdf, productId });
    logger.info(`Invoice ${invoice.invoiceId} created for product_id ${productId}`);
    await emitRawStock(req, [productId]);
    await redis.del('purchase_invoices_*');
    req.io.emit('invoiceUpdate', invoice);
    res.status(201).json(invoice);
  } catch (error) {
    logger.error(`Error creating invoice: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.update = async (req, res) => {
  const { invoiceId } = req.params;
  const { supplierCode, supplierName, invoiceNumber, issueDate, description, unitPrice, quantity, linkPdf, productId } = req.body;
  try {
    // Remember the old product: if the invoice moves to another material, both change.
    const { rows: before } = await pool.query('SELECT product_id FROM purchase_invoices WHERE invoice_id = $1', [parseInt(invoiceId)]);
    const invoice = await PurchaseInvoice.update(parseInt(invoiceId), { supplierCode, supplierName, invoiceNumber, issueDate, description, unitPrice, quantity, linkPdf, productId });
    logger.info(`Invoice ${invoiceId} updated for product_id ${productId}`);
    await emitRawStock(req, [before[0]?.product_id, invoice?.productId ?? productId]);
    await redis.del('purchase_invoices_*');
    req.io.emit('invoiceUpdate', invoice);
    res.json(invoice);
  } catch (error) {
    if (error.message === 'Purchase invoice not found') return res.status(404).json({ error: 'Purchase invoice not found' });
    logger.error(`Error updating invoice ${invoiceId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.delete = async (req, res) => {
  const { invoiceId } = req.params;
  try {
    const deleted = await PurchaseInvoice.delete(parseInt(invoiceId));
    logger.info(`Invoice ${invoiceId} deleted (product_id ${deleted.productId})`);
    await emitRawStock(req, [deleted.productId]);
    await redis.del('purchase_invoices_*');
    req.io.emit('invoiceUpdate', { invoiceId: parseInt(invoiceId), status: 'Deleted' });
    res.status(204).send();
  } catch (error) {
    if (error.message === 'Purchase invoice not found') return res.status(404).json({ error: 'Purchase invoice not found' });
    logger.error(`Error deleting invoice ${invoiceId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.emitRawStock = emitRawStock;
