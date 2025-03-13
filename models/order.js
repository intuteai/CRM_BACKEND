const pool = require('../config/db');
const logger = require('../utils/logger');

class Order {
  static async getAll({ limit = 10, cursor = null, user_id }) {
    const query = user_id
      ? 'SELECT * FROM orders WHERE user_id = $1 AND ($2::timestamp IS NULL OR created_at < $2) ORDER BY created_at DESC LIMIT $3'
      : 'SELECT * FROM orders WHERE $1::timestamp IS NULL OR created_at < $1 ORDER BY created_at DESC LIMIT $2';
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

  static async create(user_id, role_id, { target_delivery_date, items }, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const productIds = items.map(i => parseInt(i.product_id, 10));
      console.log('Product IDs from request:', productIds);
      const { rows: products } = await client.query(
        'SELECT product_id, stock_quantity FROM inventory WHERE product_id = ANY($1)',
        [productIds]
      );
      console.log('Products from DB:', products);
      const productMap = new Map(products.map(p => [p.product_id, p.stock_quantity]));
      for (const item of items) {
        const productId = parseInt(item.product_id, 10);
        const stock = productMap.get(productId);
        if (stock === undefined) {
          console.error(`Product ${productId} not found in DB`);
          throw new Error(`Product ${productId} not found`);
        }
        if (stock < item.quantity) throw new Error(`Insufficient stock for product ${productId}`);
      }

      const { rows: [order] } = await client.query(
        'INSERT INTO orders (user_id, status, target_delivery_date, payment_status) VALUES ($1, $2, $3, $4) RETURNING *',
        [user_id, 'Pending', target_delivery_date || null, 'Pending']
      );

      const orderItemsValues = items.map(item => [order.order_id, parseInt(item.product_id, 10), item.quantity, item.price]);
      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, price) SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::numeric[])',
        [orderItemsValues.map(v => v[0]), orderItemsValues.map(v => v[1]), orderItemsValues.map(v => v[2]), orderItemsValues.map(v => v[3])]
      );

      const { rows: updatedStocks } = await client.query(
        `WITH stock_changes AS (
           SELECT unnest($1::int[]) AS product_id, unnest($2::int[]) AS quantity
         )
         UPDATE inventory i
         SET stock_quantity = i.stock_quantity - sc.quantity
         FROM stock_changes sc
         WHERE i.product_id = sc.product_id
         RETURNING i.product_id, i.stock_quantity`,
        [productIds, items.map(i => i.quantity)]
      );

      await client.query('COMMIT');

      if (io) {
        updatedStocks.forEach(({ product_id, stock_quantity }) => {
          io.emit('stockUpdate', { product_id, stock_quantity });
        });
      }

      return order;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating order for user ${user_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateOrder(orderId, { target_delivery_date, items, status, payment_status }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [existingOrder] } = await client.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
      if (!existingOrder) throw new Error('Order not found');

      const { rows: existingItems } = await client.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [orderId]);
      const oldItemsMap = new Map(existingItems.map(i => [i.product_id, i.quantity]));
      const newItemsMap = new Map(items.map(i => [i.product_id, i.quantity]));

      const productIds = [...new Set([...existingItems.map(i => i.product_id), ...items.map(i => i.product_id)])];
      const { rows: products } = await client.query('SELECT product_id, stock_quantity FROM inventory WHERE product_id = ANY($1)', [productIds]);
      const productMap = new Map(products.map(p => [p.product_id, p.stock_quantity]));

      for (const [productId, newQty] of newItemsMap) {
        const oldQty = oldItemsMap.get(productId) || 0;
        const stock = productMap.get(productId);
        if (stock === undefined) throw new Error(`Product ${productId} not found`);
        const stockChange = oldQty - newQty;
        if (stock + stockChange < 0) throw new Error(`Insufficient stock for product ${productId}`);
      }

      await client.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
      const orderItemsValues = items.map(item => [orderId, parseInt(item.product_id, 10), item.quantity, item.price]);
      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, price) SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::numeric[])',
        [orderItemsValues.map(v => v[0]), orderItemsValues.map(v => v[1]), orderItemsValues.map(v => v[2]), orderItemsValues.map(v => v[3])]
      );

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
      const { rows: [updatedOrder] } = await client.query(
        `UPDATE orders SET ${updates.join(', ')} WHERE order_id = $1 RETURNING *`,
        values
      );

      const stockUpdates = [];
      for (const [productId, newQty] of newItemsMap) {
        const oldQty = oldItemsMap.get(productId) || 0;
        const stockChange = oldQty - newQty;
        if (stockChange !== 0) stockUpdates.push({ productId, quantity: stockChange });
      }
      if (stockUpdates.length) {
        await client.query(
          `WITH stock_changes AS (
             SELECT unnest($1::int[]) AS product_id, unnest($2::int[]) AS quantity
           )
           UPDATE inventory i
           SET stock_quantity = i.stock_quantity + sc.quantity
           FROM stock_changes sc
           WHERE i.product_id = sc.product_id`,
          [stockUpdates.map(s => s.productId), stockUpdates.map(s => s.quantity)]
        );
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

  static async cancelOrder(orderId, userId, roleId) {
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
      if (order.status === 'Delivered') throw new Error('Cannot cancel delivered order');

      const { rows: items } = await client.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
        [orderId]
      );
      
      if (items.length) {
        await client.query(
          `UPDATE inventory i
           SET stock_quantity = i.stock_quantity + sc.quantity
           FROM (SELECT unnest($1::int[]) AS product_id, unnest($2::int[]) AS quantity) sc
           WHERE i.product_id = sc.product_id`,
          [items.map(i => i.product_id), items.map(i => i.quantity)]
        );
      }

      const { rows: [cancelledOrder] } = await client.query(
        'UPDATE orders SET status = $1 WHERE order_id = $2 RETURNING *',
        ['Cancelled', orderId]
      );

      await client.query('COMMIT');
      
      // Note: 'io' is not defined in this scope; it should be passed as an argument if needed
      // if (io) {
      //   io.emit('orderUpdate', { id: orderId, status: 'Cancelled' });
      // }
      
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

module.exports = Order;