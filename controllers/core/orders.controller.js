const { Order } = require('../../models/core/order');
const redis = require('../../config/redis');
const pool = require('../../config/db');
const logger = require('../../utils/logger');

async function buildOrderResponse(order, orderId, io) {
  const itemsDetails = await Order.getItemsByOrderIds([orderId]);
  const customer = await pool.query('SELECT name FROM users WHERE user_id = $1', [order.user_id]);
  const totalAmount = (itemsDetails[orderId] || []).reduce(
    (sum, item) => sum + Number(item.price) * Number(item.quantity), 0
  );
  return {
    id: order.order_id,
    status: order.status,
    targetDeliveryDate: order.target_delivery_date,
    paymentStatus: order.payment_status,
    customerName: customer.rows[0]?.name || 'Unknown',
    createdAt: order.created_at.toISOString(),
    items: itemsDetails[orderId] || [],
    totalAmount,
    timezone: 'Asia/Kolkata',
  };
}

async function invalidateOrderCaches() {
  try {
    const [orderKeys, inventoryKeys] = await Promise.all([redis.keys('orders_*'), redis.keys('inventory_*')]);
    if (orderKeys.length) await redis.del(orderKeys);
    if (inventoryKeys.length) await redis.del([...inventoryKeys, 'inventory_stock']);
  } catch (err) {
    logger.error('Cache invalidation error', err);
  }
}

exports.getAll = async (req, res, next) => {
  const { limit = 10, cursor, force_refresh = false } = req.query;
  try {
    const parsedLimit = Math.min(parseInt(limit, 10), 100);
    const cacheKey = `orders_${parsedLimit}_${cursor || 'null'}_${req.user.user_id}`;
    if (force_refresh === 'true') await redis.del(cacheKey);
    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }
    const isAdmin = req.user.role_id === 1;
    const isProduction = req.user.role_id === 5;
    const isSales = req.user.role_id === 3;
    const { data: orders, total, nextCursor } = await Order.getAll({
      limit: parsedLimit,
      cursor: cursor ? new Date(cursor) : null,
      user_id: isAdmin || isProduction || isSales ? null : req.user.user_id,
    });
    const orderIds = orders.map(o => o.order_id);
    const itemsByOrder = orderIds.length ? await Order.getItemsByOrderIds(orderIds) : {};
    const processedRows = await Promise.all(orders.map(async (order) => {
      const customer = await pool.query('SELECT name FROM users WHERE user_id = $1', [order.user_id]);
      const items = itemsByOrder[order.order_id] || [];
      const totalAmount = items.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);
      return {
        id: order.order_id, status: order.status,
        targetDeliveryDate: order.target_delivery_date,
        paymentStatus: order.payment_status,
        customerName: customer.rows[0]?.name || 'Unknown',
        createdAt: order.created_at.toISOString(), items, totalAmount, timezone: 'Asia/Kolkata',
      };
    }));
    const response = { orders: processedRows, total, nextCursor: nextCursor ? nextCursor.toISOString() : null };
    await redis.setEx(cacheKey, 300, JSON.stringify(response));
    res.json(response);
  } catch (error) {
    logger.error(`Error fetching orders for user ${req.user.user_id}`, { message: error.message, stack: error.stack });
    next(error);
  }
};

exports.create = async (req, res) => {
  try {
    const { targetDeliveryDate, items, user_id } = req.body;
    const orderUserId = [1, 3].includes(req.user.role_id) ? user_id : req.user.user_id;
    if (!items?.length || !orderUserId) {
      return res.status(400).json({ error: 'Invalid input: items and user_id required' });
    }
    const order = await Order.create(orderUserId, req.user.role_id, { target_delivery_date: targetDeliveryDate, items }, req.io);
    const response = await buildOrderResponse(order, order.order_id, req.io);
    setImmediate(() => invalidateOrderCaches());
    res.status(201).json(response);
  } catch (error) {
    logger.error(`Error in POST /api/orders: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
};

exports.update = async (req, res) => {
  if (![1, 5, 3].includes(req.user.role_id)) {
    return res.status(403).json({ error: 'Only admins, production, or sales can update orders' });
  }
  try {
    const orderId = req.params.id;
    const { items, payment_status, targetDeliveryDate, status } = req.body;
    if (items !== undefined && !items.length) return res.status(400).json({ error: 'Items cannot be an empty array' });
    if (status === 'Cancelled') return res.status(400).json({ error: 'Use POST /orders/:id/cancel to cancel an order' });
    const validPaymentStatuses = ['Pending', 'Paid'];
    if (payment_status && !validPaymentStatuses.includes(payment_status)) {
      return res.status(400).json({ error: `Invalid payment_status: must be ${validPaymentStatuses.join(', ')}` });
    }
    const order = await Order.updateOrder(orderId, { target_delivery_date: targetDeliveryDate, items, status, payment_status }, req.io);
    const response = await buildOrderResponse(order, orderId, req.io);
    setImmediate(() => invalidateOrderCaches());
    res.json(response);
  } catch (error) {
    logger.error(`Error in PUT /api/orders/${req.params.id}/update: ${error.message}`, { stack: error.stack });
    res.status(400).json({ error: error.message });
  }
};

exports.cancel = async (req, res) => {
  try {
    const orderId = req.params.id;
    const { goods_returned = false } = req.body;
    const order = await Order.cancelOrder(orderId, req.user.user_id, req.user.role_id, req.io, { goods_returned });
    const itemsDetails = await Order.getItemsByOrderIds([orderId]);
    const totalAmount = (itemsDetails[orderId] || []).reduce(
      (sum, item) => sum + Number(item.price) * Number(item.quantity), 0
    );
    setImmediate(() => invalidateOrderCaches());
    res.json({ id: order.order_id, status: order.status, totalAmount, message: 'Order cancelled successfully' });
  } catch (error) {
    logger.error(`Error in POST /api/orders/${req.params.id}/cancel: ${error.message}`, { stack: error.stack });
    res.status(400).json({ error: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/orders/export
// Returns all orders the requester is authorised to see as a CSV download.
// Respects the same role-based visibility rules as getAll.
// ---------------------------------------------------------------------------
exports.exportOrders = async (req, res, next) => {
  try {
    const isAdmin      = req.user.role_id === 1;
    const isProduction = req.user.role_id === 5;
    const isSales      = req.user.role_id === 3;

    // Fetch all orders — no pagination, no Redis cache for exports
    const { data: orders } = await Order.getAll({
      limit: 100000,
      cursor: null,
      user_id: isAdmin || isProduction || isSales ? null : req.user.user_id,
    });

    const orderIds = orders.map(o => o.order_id);
    const itemsByOrder = orderIds.length ? await Order.getItemsByOrderIds(orderIds) : {};

    // Build one flat row per order
    const rows = await Promise.all(
      orders.map(async (order) => {
        const customerResult = await pool.query(
          'SELECT name FROM users WHERE user_id = $1',
          [order.user_id]
        );
        const items = itemsByOrder[order.order_id] || [];
        const totalAmount = items
          .reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0)
          .toFixed(2);
        const itemsSummary = items
          .map(i => `${i.productName} (Qty: ${i.quantity})`)
          .join('; ');

        return [
          order.order_id,
          customerResult.rows[0]?.name || 'Unknown',
          itemsSummary,
          totalAmount,
          order.status,
          order.target_delivery_date || 'Not Set',
          order.payment_status,
          new Date(order.created_at).toISOString(),
        ];
      })
    );

    // Assemble CSV
    const headers = [
      'Order ID',
      'Customer Name',
      'Items',
      'Total Amount (INR)',
      'Status',
      'Target Delivery',
      'Payment Status',
      'Created At',
    ];

    const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

    const csvLines = [
      headers.map(escape).join(','),
      ...rows.map(row => row.map(escape).join(',')),
    ].join('\n');

    const filename = `orders_export_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Total-Exported', rows.length.toString());

    logger.info(`Orders export: ${rows.length} rows sent to user ${req.user.user_id}`);
    res.send(csvLines);
  } catch (error) {
    logger.error(`Error in GET /api/orders/export: ${error.message}`, { stack: error.stack });
    next(error);
  }
};