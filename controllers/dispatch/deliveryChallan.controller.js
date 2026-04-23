const DeliveryChallan = require('../../models/dispatch/deliveryChallan');
const logger = require('../../utils/logger');
const pool = require('../../config/db');

exports.generate = async (req, res) => {
  const client = await pool.connect();
  try {
    const data = req.body || {};
    if (!data.challan_no) return res.status(400).json({ error: 'challan_no required' });
    if (!Array.isArray(data.items) || !data.items.length) return res.status(400).json({ error: 'items required (non-empty array)' });
    for (const [i, it] of data.items.entries()) {
      if (!it.productId) return res.status(400).json({ error: `items[${i}].productId required` });
      if (it.qty == null || isNaN(Number(it.qty)) || Number(it.qty) <= 0) return res.status(400).json({ error: `items[${i}].qty must be > 0` });
      if (!['raw', 'inventory'].includes((it.source || '').toString())) return res.status(400).json({ error: `items[${i}].source must be 'raw' or 'inventory'` });
    }

    const pdfBuffer = await DeliveryChallan.generateBuffer(data);

    try {
      await client.query('BEGIN');
      const updatedProducts = [];
      for (const it of data.items) {
        if (!it.returnable) continue;
        const qtyNum = Number(it.qty);
        if (isNaN(qtyNum) || qtyNum <= 0) continue;
        const table = it.source === 'inventory' ? 'inventory' : 'raw_materials';
        const updateRes = await client.query(
          `UPDATE ${table} SET returnable_qty = COALESCE(returnable_qty, 0) + $1 WHERE product_id = $2 RETURNING product_id, returnable_qty`,
          [it.source === 'inventory' ? Math.round(qtyNum) : qtyNum, it.productId]
        );
        if (updateRes.rowCount) {
          updatedProducts.push({ product_id: updateRes.rows[0].product_id, returnable_qty: Number(updateRes.rows[0].returnable_qty) });
        } else {
          throw new Error(`${it.source === 'inventory' ? 'Inventory' : 'Raw material'} product not found: ${it.productId}`);
        }
      }
      await client.query('COMMIT');
      try {
        for (const upd of updatedProducts) req.io.emit('stockUpdate', { product_id: upd.product_id, returnable_qty: upd.returnable_qty, status: 'updated' });
      } catch (emitErr) { logger.warn('Failed to emit socket updates for delivery challan:', emitErr); }

      const safeName = String(data.challan_no).replace(/[^a-zA-Z0-9]/g, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="DELIVERY_CHALLAN_${safeName}.pdf"`);
      res.setHeader('Content-Length', Buffer.byteLength(pdfBuffer));
      return res.send(pdfBuffer);
    } catch (dbErr) {
      try { await client.query('ROLLBACK'); } catch (rbErr) { logger.error('Failed to rollback after DB error in delivery challan:', rbErr); }
      logger.error('DB transaction failed for delivery challan:', dbErr);
      return res.status(500).json({ error: 'Failed to update returnable quantities', detail: dbErr.message });
    }
  } catch (err) {
    logger.error('Delivery challan error:', err);
    if (!res.headersSent) return res.status(500).json({ error: 'Failed to generate delivery challan', detail: err.message });
    try { res.end(); } catch (e) {}
  } finally {
    try { client.release(); } catch (e) {}
  }
};
