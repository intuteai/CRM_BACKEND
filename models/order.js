const pool = require('../config/db');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Canonical ordering of non-terminal statuses.  Used to enforce the rule that
// an order can only move forward in its lifecycle.  Cancelled is intentionally
// absent — it is a terminal side-exit and must always go through cancelOrder().
// ---------------------------------------------------------------------------
const STATUS_RANK = {
  Pending:    0,
  Processing: 1,
  Testing:    2,
  Shipped:    3,
  Delivered:  4,
};

class Order {
  static async getAll({ limit = 10, cursor = null, user_id }) {
    const query = user_id
      ? 'SELECT order_id, user_id, TO_CHAR(target_delivery_date, \'YYYY-MM-DD\') AS target_delivery_date, created_at, status, payment_status FROM orders WHERE user_id = $1 AND ($2::timestamp IS NULL OR created_at < $2) ORDER BY created_at DESC LIMIT $3'
      : 'SELECT order_id, user_id, TO_CHAR(target_delivery_date, \'YYYY-MM-DD\') AS target_delivery_date, created_at, status, payment_status FROM orders WHERE $1::timestamp IS NULL OR created_at < $1 ORDER BY created_at DESC LIMIT $2';
    const countQuery = user_id ? 'SELECT COUNT(*) FROM orders WHERE user_id = $1' : 'SELECT COUNT(*) FROM orders';
    const values = user_id ? [user_id, cursor, limit] : [cursor, limit];
    const [result, countResult] = await Promise.all([
      pool.query(query, values),
      pool.query(countQuery, user_id ? [user_id] : []),
    ]);
    console.log('Orders from DB:', result.rows);
    return { 
      data: result.rows, 
      total: parseInt(countResult.rows[0].count, 10), 
      nextCursor: result.rows.length ? result.rows[result.rows.length - 1].created_at : null 
    };
  }

  static async getItemsByOrderIds(orderIds) {
    const { rows } = await pool.query(
      'SELECT oi.order_id, oi.product_id, oi.quantity, oi.price, i.product_name AS "productName" ' +
      'FROM order_items oi JOIN inventory i ON oi.product_id = i.product_id WHERE oi.order_id = ANY($1)',
      [orderIds]
    );
    const itemsByOrder = {};
    rows.forEach(row => {
      if (!itemsByOrder[row.order_id]) itemsByOrder[row.order_id] = [];
      itemsByOrder[row.order_id].push(row);
    });
    return itemsByOrder;
  }

  // ✅ NEW: Create holds for order items
  static async createOrderHolds(client, orderId, items) {
    for (const item of items) {
      await client.query(
        `INSERT INTO inventory_holds
         (product_id, quantity, reason, reference_type, reference_value, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          item.product_id,
          item.quantity,
          'Order fulfillment',
          'ORDER',
          orderId.toString(),
          'ACTIVE'
        ]
      );
    }
  }

  // ✅ NEW: Release holds for an order
  static async releaseOrderHolds(client, orderId) {
    const { rows } = await client.query(
      `UPDATE inventory_holds
       SET status = 'RELEASED', released_at = NOW()
       WHERE reference_type = 'ORDER'
         AND reference_value = $1
         AND status = 'ACTIVE'
       RETURNING hold_id, product_id, quantity`,
      [orderId.toString()]
    );
    return rows;
  }

  // ✅ UPDATED: Check inventory availability (NOW ALLOWS NEGATIVE STOCK)
  // Returns availability info but does NOT throw - just logs warnings
  static async checkInventoryAvailability(client, items) {
    const productIds = items.map(i => i.product_id);
    const { rows } = await client.query(
      `SELECT 
         i.product_id,
         i.stock_quantity,
         COALESCE(SUM(h.quantity), 0) AS reserved_quantity,
         (i.stock_quantity - COALESCE(SUM(h.quantity), 0)) AS available_quantity
       FROM inventory i
       LEFT JOIN inventory_holds h
         ON h.product_id = i.product_id
        AND h.status = 'ACTIVE'
       WHERE i.product_id = ANY($1)
       GROUP BY i.product_id`,
      [productIds]
    );

    const availability = {};
    rows.forEach(row => {
      availability[row.product_id] = {
        stock_quantity: Number(row.stock_quantity),
        reserved_quantity: Number(row.reserved_quantity),
        available_quantity: Number(row.available_quantity)
      };
    });

    // ✅ CHANGED: Log warnings for low/negative stock but DON'T throw
    const warnings = [];
    for (const item of items) {
      const avail = availability[item.product_id];
      if (!avail) {
        warnings.push(`Product ${item.product_id} not found in inventory`);
      } else if (avail.available_quantity < item.quantity) {
        warnings.push(
          `Product ${item.product_id}: need ${item.quantity}, available ${avail.available_quantity} (will go negative)`
        );
      }
    }

    if (warnings.length > 0) {
      logger.warn(`Order inventory warnings: ${warnings.join('; ')}`);
    }

    return { availability, warnings };
  }

  static async create(user_id, role_id, { target_delivery_date, items }, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ✅ CHANGED: Check availability but DON'T fail (just log warnings)
      const { availability, warnings } = await Order.checkInventoryAvailability(client, items);

      // ✅ STEP 1: Create the order
      const { rows: [order] } = await client.query(
        'INSERT INTO orders (user_id, status, target_delivery_date, payment_status) VALUES ($1, $2, $3, $4) RETURNING order_id, user_id, TO_CHAR(target_delivery_date, \'YYYY-MM-DD\') AS target_delivery_date, created_at, status, payment_status',
        [user_id, 'Pending', target_delivery_date || null, 'Pending']
      );

      // ✅ STEP 2: Insert order items
      const orderItemsValues = items.map(item => [
        order.order_id,
        parseInt(item.product_id, 10),
        item.quantity,
        item.price
      ]);

      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, price) SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::numeric[])',
        [
          orderItemsValues.map(v => v[0]),
          orderItemsValues.map(v => v[1]),
          orderItemsValues.map(v => v[2]),
          orderItemsValues.map(v => v[3])
        ]
      );

      // ✅ STEP 3: Create holds to reserve inventory (EVEN IF NEGATIVE)
      // This allows tracking demand vs supply
      await Order.createOrderHolds(client, order.order_id, items);

      // Fetch updated invoice to emit Socket.IO event
      const { rows: [updatedInvoice] } = await client.query(
        'SELECT invoice_id, invoice_number, total_value, issue_date FROM customer_invoices WHERE order_id = $1',
        [order.order_id]
      );
      if (updatedInvoice && io) {
        io.emit('invoiceUpdate', {
          invoice_id: updatedInvoice.invoice_id,
          invoice_number: updatedInvoice.invoice_number,
          total_value: updatedInvoice.total_value,
          issue_date: updatedInvoice.issue_date
        });
      }

      await client.query('COMMIT');

      logger.info(
        `Order ${order.order_id} created with holds for ${items.length} products` +
        (warnings.length ? ` [WARNINGS: ${warnings.join('; ')}]` : '')
      );
      
      return order;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating order for user ${user_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateOrder(orderId, { target_delivery_date, items, status, payment_status }, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ------------------------------------------------------------------
      // 1. Fetch current state — everything we need to validate against.
      // ------------------------------------------------------------------
      const { rows: [existingOrder] } = await client.query(
        'SELECT * FROM orders WHERE order_id = $1',
        [orderId]
      );
      if (!existingOrder) throw new Error('Order not found');

      const oldStatus = existingOrder.status;
      const newStatus = status || oldStatus; // caller may omit status entirely

      // ------------------------------------------------------------------
      // 2. Status-transition guards (pure validation, no writes yet).
      // ------------------------------------------------------------------

      // 2a) Cancellation must go through cancelOrder() so the goods_returned
      //     gate is enforced.  Reject it here unconditionally.
      if (newStatus === 'Cancelled') {
        throw new Error('Use cancelOrder() to cancel an order');
      }

      // 2b) Both old and new must be known, ranked statuses.
      if (STATUS_RANK[oldStatus] === undefined || STATUS_RANK[newStatus] === undefined) {
        throw new Error(`Invalid status transition: ${oldStatus} → ${newStatus}`);
      }

      // 2c) Downgrade block — covers Shipped→Processing, Delivered→Shipped, etc.
      if (STATUS_RANK[newStatus] < STATUS_RANK[oldStatus]) {
        throw new Error(`Status downgrade not allowed: ${oldStatus} → ${newStatus}`);
      }

      // ------------------------------------------------------------------
      // 3. Items-immutability guard.
      //    Once an order is Shipped or Delivered the line items are a
      //    historical record of what was physically dispatched.  Reject any
      //    attempt to change them.
      // ------------------------------------------------------------------
      let itemsChanged = false;
      const orderIsDispatched = STATUS_RANK[oldStatus] >= STATUS_RANK['Shipped'];

      if (items !== undefined) {
        const { rows: existingItems } = await client.query(
          'SELECT product_id, quantity, price FROM order_items WHERE order_id = $1 ORDER BY product_id',
          [orderId]
        );

        const incomingNormalised = [...items]
          .map(i => ({ product_id: parseInt(i.product_id, 10), quantity: Number(i.quantity), price: Number(i.price) }))
          .sort((a, b) => a.product_id - b.product_id);

        const existingNormalised = existingItems
          .map(i => ({ product_id: i.product_id, quantity: Number(i.quantity), price: Number(i.price) }));

        itemsChanged =
          incomingNormalised.length !== existingNormalised.length ||
          incomingNormalised.some((item, idx) => {
            const cur = existingNormalised[idx];
            return item.product_id !== cur.product_id ||
                   item.quantity   !== cur.quantity   ||
                   item.price      !== cur.price;
          });

        if (orderIsDispatched && itemsChanged) {
          throw new Error('Order items cannot be modified after the order has been shipped');
        }

        // ✅ CHANGED: Check availability but don't fail (just log warnings)
        if (itemsChanged && !orderIsDispatched) {
          await Order.checkInventoryAvailability(client, incomingNormalised);
        }
      }

      // ------------------------------------------------------------------
      // 4. UPDATE order-level fields first.
      // ------------------------------------------------------------------
      const updates = [];
      const values = [orderId];

      if (target_delivery_date !== undefined) {
        updates.push(`target_delivery_date = $${values.length + 1}`);
        values.push(target_delivery_date || null);
      }
      if (status) {
        updates.push(`status = $${values.length + 1}`);
        values.push(status);
      }
      if (payment_status) {
        updates.push(`payment_status = $${values.length + 1}`);
        values.push(payment_status);
      }

      if (!updates.length) throw new Error('No fields provided to update');

      const { rows: [updatedOrder] } = await client.query(
        `UPDATE orders SET ${updates.join(', ')} WHERE order_id = $1 RETURNING order_id, user_id, TO_CHAR(target_delivery_date, 'YYYY-MM-DD') AS target_delivery_date, created_at, status, payment_status`,
        values
      );

      // ------------------------------------------------------------------
      // 5. Mutate order_items AND update holds
      // ------------------------------------------------------------------
      if (!orderIsDispatched && itemsChanged) {
        // ✅ STEP A: Release old holds
        await Order.releaseOrderHolds(client, orderId);

        // ✅ STEP B: Delete old items
        await client.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);

        // ✅ STEP C: Insert new items
        const orderItemsValues = items.map(item => [
          orderId,
          parseInt(item.product_id, 10),
          item.quantity,
          item.price
        ]);

        await client.query(
          'INSERT INTO order_items (order_id, product_id, quantity, price) SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::numeric[])',
          [
            orderItemsValues.map(v => v[0]),
            orderItemsValues.map(v => v[1]),
            orderItemsValues.map(v => v[2]),
            orderItemsValues.map(v => v[3])
          ]
        );

        // ✅ STEP D: Create new holds (EVEN IF NEGATIVE)
        await Order.createOrderHolds(client, orderId, items);

        logger.info(`Order ${orderId} items updated and holds refreshed`);
      }

      // ------------------------------------------------------------------
      // 6. Ship hook — CONSUME INVENTORY & RELEASE HOLDS
      //    When transitioning to 'Shipped', we:
      //    1. Deduct physical stock (CAN GO NEGATIVE for build-to-order)
      //    2. Release the holds (they're no longer needed)
      // ------------------------------------------------------------------
      if (STATUS_RANK[oldStatus] < STATUS_RANK['Shipped'] && newStatus === 'Shipped') {
        const { rows: dispatchItems } = await client.query(
          'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
          [orderId]
        );

        if (dispatchItems.length) {
          // ✅ STEP 1: Deduct from stock_quantity (ALLOWS NEGATIVE)
          const { rows: updatedStocks } = await client.query(
            `WITH stock_changes AS (
               SELECT unnest($1::int[]) AS product_id, unnest($2::int[]) AS quantity
             )
             UPDATE inventory i
             SET stock_quantity = i.stock_quantity - sc.quantity
             FROM stock_changes sc
             WHERE i.product_id = sc.product_id
             RETURNING i.product_id, i.stock_quantity`,
            [
              dispatchItems.map(i => i.product_id),
              dispatchItems.map(i => i.quantity)
            ]
          );

          // ✅ STEP 2: Release the holds (inventory is now consumed, not reserved)
          const releasedHolds = await Order.releaseOrderHolds(client, orderId);

          // Log warning if stock went negative
          const negativeStock = updatedStocks.filter(s => s.stock_quantity < 0);
          if (negativeStock.length > 0) {
            logger.warn(
              `Order ${orderId} shipped with negative stock: ${negativeStock.map(s => 
                `Product ${s.product_id} = ${s.stock_quantity}`
              ).join(', ')}`
            );
          }

          logger.info(
            `Order ${orderId} shipped: consumed inventory for ${dispatchItems.length} products, released ${releasedHolds.length} holds`
          );

          if (io) {
            updatedStocks.forEach(({ product_id, stock_quantity }) => {
              io.emit('stockUpdate', { product_id, stock_quantity });
            });
          }
        }
      }

      // ------------------------------------------------------------------
      // 7. Invoice emit
      // ------------------------------------------------------------------
      const { rows: [updatedInvoice] } = await client.query(
        'SELECT invoice_id, invoice_number, total_value, issue_date FROM customer_invoices WHERE order_id = $1',
        [orderId]
      );
      if (updatedInvoice && io) {
        io.emit('invoiceUpdate', {
          invoice_id: updatedInvoice.invoice_id,
          invoice_number: updatedInvoice.invoice_number,
          total_value: updatedInvoice.total_value,
          issue_date: updatedInvoice.issue_date
        });
      }

      await client.query('COMMIT');
      return updatedOrder;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async cancelOrder(orderId, userId, roleId, io, { goods_returned = false } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const { rows: [order] } = await client.query(
        'SELECT * FROM orders WHERE order_id = $1',
        [orderId]
      );
      if (!order) throw new Error('Order not found');
      if (roleId !== 1 && order.user_id !== userId) throw new Error('Unauthorized');
      if (order.status === 'Cancelled') throw new Error('Order already cancelled');

      // A Delivered order has already reached the customer.
      if (order.status === 'Delivered' && !goods_returned) {
        throw new Error('Cannot cancel a Delivered order without confirming goods have been returned');
      }

      // ---------------------------------------------------------------------------
      // ✅ HOLD-BASED CANCELLATION (ALLOWS NEGATIVE STOCK RESTORATION)
      // ---------------------------------------------------------------------------
      const wasShipped = order.status === 'Shipped' || order.status === 'Delivered';

      if (wasShipped && goods_returned) {
        // ✅ CASE 1: Order was shipped/delivered AND goods returned
        // Action: Return stock to inventory (CAN MAKE STOCK LESS NEGATIVE)
        const { rows: items } = await client.query(
          'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
          [orderId]
        );

        if (items.length) {
          const { rows: updatedStocks } = await client.query(
            `UPDATE inventory i
             SET stock_quantity = i.stock_quantity + sc.quantity
             FROM (SELECT unnest($1::int[]) AS product_id, unnest($2::int[]) AS quantity) sc
             WHERE i.product_id = sc.product_id
             RETURNING i.product_id, i.stock_quantity`,
            [items.map(i => i.product_id), items.map(i => i.quantity)]
          );

          if (io) {
            updatedStocks.forEach(({ product_id, stock_quantity }) => {
              io.emit('stockUpdate', { product_id, stock_quantity });
            });
          }

          logger.info(`Order ${orderId} cancelled: returned ${items.length} products to stock`);
        }
      } else if (!wasShipped) {
        // ✅ CASE 2: Order never shipped (Pending/Processing/Testing)
        // Action: Simply release the holds (inventory was never consumed)
        const releasedHolds = await Order.releaseOrderHolds(client, orderId);
        
        logger.info(
          `Order ${orderId} cancelled before shipping: released ${releasedHolds.length} holds`
        );
      }
      // ✅ CASE 3: wasShipped but goods_returned=false
      // No action - holds were already released on ship, stock was consumed
      // Admin should later use accept-return endpoint when goods arrive

      // Update order status to Cancelled
      const { rows: [cancelledOrder] } = await client.query(
        'UPDATE orders SET status = $1 WHERE order_id = $2 RETURNING order_id, user_id, TO_CHAR(target_delivery_date, \'YYYY-MM-DD\') AS target_delivery_date, created_at, status, payment_status',
        ['Cancelled', orderId]
      );

      // Fetch updated invoice to emit Socket.IO event
      const { rows: [updatedInvoice] } = await client.query(
        'SELECT invoice_id, invoice_number, total_value, issue_date FROM customer_invoices WHERE order_id = $1',
        [orderId]
      );
      if (updatedInvoice && io) {
        io.emit('invoiceUpdate', {
          invoice_id: updatedInvoice.invoice_id,
          invoice_number: updatedInvoice.invoice_number,
          total_value: updatedInvoice.total_value,
          issue_date: updatedInvoice.issue_date
        });
      }

      await client.query('COMMIT');
      
      return cancelledOrder;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error cancelling order ${orderId}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { Order };