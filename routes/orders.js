const express = require('express');
const { Order } = require('../models/order');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });
const pool = require('../config/db');

router.get('/', authenticateToken, checkPermission('Orders', 'can_read'), async (req, res, next) => {
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
    const isProduction = req.user.role_id === 5; // Allow Production role to see all orders
    console.log(`Fetching orders for user_id: ${req.user.user_id}, role_id: ${req.user.role_id}, isAdmin: ${isAdmin}, isProduction: ${isProduction}, cursor: ${cursor}, limit: ${parsedLimit}`);
    const { data: orders, total, nextCursor } = await Order.getAll({
      limit: parsedLimit,
      cursor: cursor ? new Date(cursor) : null,
      user_id: (isAdmin || isProduction) ? null : req.user.user_id, // Bypass user_id filter for Production
    });
    console.log('Fetched orders from DB:', orders);

    const orderIds = orders.map((o) => o.order_id);
    const itemsByOrder = orderIds.length ? await Order.getItemsByOrderIds(orderIds) : {};
    console.log('Items by order:', itemsByOrder);

    const processedRows = await Promise.all(orders.map(async (order) => {
      const customer = await pool.query('SELECT name FROM users WHERE user_id = $1', [order.user_id]);
      const items = itemsByOrder[order.order_id] || [];
      const totalAmount = items.reduce((sum, item) => sum + (Number(item.price) * Number(item.quantity)), 0);
      return {
        id: order.order_id,
        status: order.status,
        targetDeliveryDate: order.target_delivery_date,
        paymentStatus: order.payment_status,
        customerName: customer.rows[0]?.name || 'Unknown',
        createdAt: order.created_at.toISOString(),
        items,
        totalAmount,
        timezone: 'Asia/Kolkata',
      };
    }));
    console.log('Processed rows:', processedRows);

    const response = { orders: processedRows, total, nextCursor: nextCursor ? nextCursor.toISOString() : null };
    console.log('Final response to frontend:', response);
    await redis.setEx(cacheKey, 300, JSON.stringify(response));
    res.json(response);
  } catch (error) {
    logger.error(`Error fetching orders for user ${req.user.user_id}`, { message: error.message, stack: error.stack });
    next(error);
  }
});

router.post('/', authenticateToken, checkPermission('Orders', 'can_write'), async (req, res, next) => {
  try {
    const { targetDeliveryDate, items, user_id } = req.body;
    const orderUserId = req.user.role_id === 1 ? user_id : req.user.user_id;

    if (!items?.length || !orderUserId) {
      return res.status(400).json({ error: 'Invalid input: items and user_id required' });
    }

    console.log(`Starting order creation for user_id: ${orderUserId}, role_id: ${req.user.role_id}`);
    const order = await Order.create(orderUserId, req.user.role_id, { target_delivery_date: targetDeliveryDate, items }, req.io);
    const itemsDetails = await Order.getItemsByOrderIds([order.order_id]);
    const customer = await pool.query('SELECT name FROM users WHERE user_id = $1', [orderUserId]);
    const totalAmount = (itemsDetails[order.order_id] || []).reduce((sum, item) => sum + (Number(item.price) * Number(item.quantity)), 0);

    const response = {
      id: order.order_id,
      status: order.status,
      targetDeliveryDate: order.target_delivery_date,
      paymentStatus: order.payment_status,
      customerName: customer.rows[0]?.name || 'Unknown',
      createdAt: order.created_at.toISOString(),
      items: itemsDetails[order.order_id] || [],
      totalAmount,
      timezone: 'Asia/Kolkata',
    };

    setImmediate(async () => {
      try {
        const [orderKeys, inventoryKeys] = await Promise.all([
          redis.keys(`orders_*_${orderUserId}`),
          redis.keys('inventory_*'),
        ]);
        if (orderKeys.length) await redis.del(orderKeys);
        if (inventoryKeys.length) await redis.del(inventoryKeys);
        logger.info(`Cleared caches for orders and inventory after creating order ${order.order_id}`);
      } catch (err) {
        logger.error('Cache invalidation error', err);
      }
    });

    res.status(201).json(response);
  } catch (error) {
    logger.error(`Error in POST /api/orders: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.put('/:id/update', authenticateToken, checkPermission('Orders', 'can_write'), async (req, res, next) => {
  if (req.user.role_id !== 1 && req.user.role_id !== 5) return res.status(403).json({ error: 'Only admins or production can update orders' });

  try {
    const orderId = req.params.id;
    const { items, payment_status, targetDeliveryDate, status } = req.body;

    if (!items?.length) return res.status(400).json({ error: 'Invalid items: must be a non-empty array' });

    const validPaymentStatuses = ['Pending', 'Paid'];
    const validOrderStatuses = ['Pending', 'Processing', 'Shipped', 'Delivered'];
    if (payment_status && !validPaymentStatuses.includes(payment_status)) {
      return res.status(400).json({ error: `Invalid payment_status: must be ${validPaymentStatuses.join(', ')}` });
    }
    if (status && !validOrderStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status: must be ${validOrderStatuses.join(', ')}` });
    }

    const order = await Order.updateOrder(orderId, {
      target_delivery_date: targetDeliveryDate,
      items,
      status,
      payment_status,
    }, req.io);
    const itemsDetails = await Order.getItemsByOrderIds([orderId]);
    const customer = await pool.query('SELECT name FROM users WHERE user_id = $1', [order.user_id]);
    const totalAmount = (itemsDetails[orderId] || []).reduce((sum, item) => sum + (Number(item.price) * Number(item.quantity)), 0);

    const response = {
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

    setImmediate(() =>
      redis.del(`orders_*_${order.user_id}`).catch((err) => logger.error('Cache error', err))
    );
    res.json(response);
  } catch (error) {
    logger.error(`Error in PUT /api/orders/${req.params.id}/update: ${error.message}`, { stack: error.stack });
    res.status(400).json({ error: error.message });
  }
});

router.post('/:id/cancel', authenticateToken, checkPermission('Orders', 'can_write'), async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const order = await Order.cancelOrder(orderId, req.user.user_id, req.user.role_id, req.io);
    const itemsDetails = await Order.getItemsByOrderIds([orderId]);
    const totalAmount = (itemsDetails[orderId] || []).reduce((sum, item) => sum + (Number(item.price) * Number(item.quantity)), 0);

    const response = {
      id: order.order_id,
      status: order.status,
      totalAmount,
      message: 'Order cancelled successfully',
    };

    setImmediate(async () => {
      try {
        const [orderKeys, inventoryKeys] = await Promise.all([
          redis.keys(`orders_*_${order.user_id}`),
          redis.keys('inventory_*'),
        ]);
        if (orderKeys.length) await redis.del(orderKeys);
        if (inventoryKeys.length) await redis.del(inventoryKeys);
      } catch (err) {
        logger.error('Cache invalidation error', err);
      }
    });

    res.json(response);
  } catch (error) {
    logger.error(`Error in POST /api/orders/${req.params.id}/cancel: ${error.message}`, { stack: error.stack });
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;