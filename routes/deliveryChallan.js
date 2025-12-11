const express = require('express');
const router = express.Router();
const DeliveryChallan = require('../models/deliveryChallan');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const pool = require('../config/db'); // assumes you have a configured pg pool exported here

// attach socket.io like in proforma route (optional)
router.use(authenticateToken, (req, res, next) => {
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

/**
 * POST /api/delivery-challan/generate
 * Body:
 * {
 *   challan_no: string,
 *   date: ISOString,
 *   order_no,
 *   order_date,
 *   vehicle_no,
 *   to_name,
 *   to_address,
 *   to_gst_number,
 *   items: [{ source: 'raw'|'inventory', productId: number, description, qty: number, remarks, returnable: boolean }]
 * }
 *
 * Flow:
 * 1. Validate body
 * 2. Generate PDF buffer via DeliveryChallan.generateBuffer(data)
 * 3. Begin DB transaction; for each item where returnable === true:
 *    - if source === 'inventory' => update inventory.returnable_qty = returnable_qty + qty WHERE product_id = $1
 *    - if source === 'raw' => update raw_materials.returnable_qty = returnable_qty + qty WHERE product_id = $1
 * 4. Commit transaction
 * 5. Emit socket events (stockUpdate) for affected products
 * 6. Send PDF buffer as attachment
 *
 * If any DB step fails, rollback and respond 500 (do not send PDF).
 */
router.post('/generate', async (req, res) => {
  const client = await pool.connect();
  try {
    const data = req.body || {};
    if (!data.challan_no) {
      return res.status(400).json({ error: 'challan_no required' });
    }
    if (!Array.isArray(data.items) || !data.items.length) {
      return res.status(400).json({ error: 'items required (non-empty array)' });
    }

    // basic item validation
    for (const [i, it] of data.items.entries()) {
      if (!it.productId) return res.status(400).json({ error: `items[${i}].productId required` });
      if (it.qty == null || isNaN(Number(it.qty)) || Number(it.qty) <= 0) return res.status(400).json({ error: `items[${i}].qty must be > 0` });
      if (!['raw', 'inventory'].includes((it.source || '').toString())) return res.status(400).json({ error: `items[${i}].source must be 'raw' or 'inventory'` });
    }

    // 1) Generate PDF buffer first
    const pdfBuffer = await DeliveryChallan.generateBuffer(data);

    // 2) Begin DB transaction and update returnable_qty only for items with returnable === true
    try {
      await client.query('BEGIN');

      const updatedProducts = []; // collect updated rows for socket emit

      for (const it of data.items) {
        if (!it.returnable) continue; // only update when marked returnable

        const qtyNum = Number(it.qty);
        if (isNaN(qtyNum) || qtyNum <= 0) continue;

        if (it.source === 'inventory') {
          // inventory.returnable_qty is integer
          const updateRes = await client.query(
            `UPDATE inventory
             SET returnable_qty = COALESCE(returnable_qty, 0) + $1
             WHERE product_id = $2
             RETURNING product_id, returnable_qty`,
            [Math.round(qtyNum), it.productId]
          );
          if (updateRes.rowCount) {
            updatedProducts.push({
              product_id: updateRes.rows[0].product_id,
              returnable_qty: Number(updateRes.rows[0].returnable_qty)
            });
          } else {
            // product not found — rollback and error
            throw new Error(`Inventory product not found: ${it.productId}`);
          }
        } else if (it.source === 'raw') {
          // raw_materials.returnable_qty is numeric(10,2)
          // we allow fractional qty here (use numeric)
          const updateRes = await client.query(
            `UPDATE raw_materials
             SET returnable_qty = COALESCE(returnable_qty, 0) + $1
             WHERE product_id = $2
             RETURNING product_id, returnable_qty`,
            [qtyNum, it.productId]
          );
          if (updateRes.rowCount) {
            updatedProducts.push({
              product_id: updateRes.rows[0].product_id,
              returnable_qty: Number(updateRes.rows[0].returnable_qty)
            });
          } else {
            throw new Error(`Raw material not found: ${it.productId}`);
          }
        }
      }

      await client.query('COMMIT');

      // 3) Emit socket events for updated products (non-blocking)
      try {
        for (const upd of updatedProducts) {
          // emit a standard event name your frontend listens to
          req.io.emit('stockUpdate', {
            product_id: upd.product_id,
            returnable_qty: upd.returnable_qty,
            status: 'updated'
          });
        }
      } catch (emitErr) {
        logger.warn('Failed to emit socket updates for delivery challan:', emitErr);
      }

      // 4) Send the PDF buffer as attachment
      const safeName = String(data.challan_no).replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `DELIVERY_CHALLAN_${safeName}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', Buffer.byteLength(pdfBuffer));
      return res.send(pdfBuffer);

    } catch (dbErr) {
      // rollback and surface error
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        logger.error('Failed to rollback after DB error in delivery challan route:', rbErr);
      }
      logger.error('DB transaction failed for delivery challan:', dbErr);
      return res.status(500).json({ error: 'Failed to update returnable quantities', detail: dbErr.message });
    }
  } catch (err) {
    logger.error('Delivery challan route error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to generate delivery challan', detail: err.message });
    }
    // if headers already sent, just close
    try { res.end(); } catch (e) { /* ignore */ }
  } finally {
    try { client.release(); } catch (e) { /* ignore */ }
  }
});

module.exports = router;
