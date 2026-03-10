// routes/iaOrders.js
const express = require('express');
const IAOrders = require('../models/iaOrders');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

const CACHE_TTL = 120;
const PREFIX = 'ia_orders_';

// ── Helpers ──────────────────────────────────────────────────
function toInt(v, { def = 20, min = 1, max = 100 } = {}) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}

function listKey({ limit, cursor }) {
  return cursor
    ? `${PREFIX}list_${limit}_${encodeURIComponent(cursor)}`
    : `${PREFIX}list_${limit}_initial`;
}

async function invalidate() {
  try {
    const keys = [];
    for await (const k of redis.scanIterator({ MATCH: `${PREFIX}*`, COUNT: 500 })) {
      keys.push(k);
      if (keys.length >= 500) { await redis.del(keys); keys.length = 0; }
    }
    if (keys.length) await redis.del(keys);
  } catch (e) {
    logger.warn(`ia_orders cache invalidation skipped: ${e.message}`);
  }
}

async function cacheGet(key) {
  try { const r = await redis.get(key); return r ? JSON.parse(r) : null; }
  catch { return null; }
}

async function cacheSet(key, value) {
  try { await redis.setEx(key, CACHE_TTL, JSON.stringify(value)); }
  catch (e) { logger.warn(`ia_orders cache set failed: ${e.message}`); }
}

// ── Middleware ────────────────────────────────────────────────
router.use(authenticateToken, (req, res, next) => {
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

// ── GET / ─────────────────────────────────────────────────────
router.get('/', checkPermission('ia_orders', 'can_read'), async (req, res) => {
  const limit = toInt(req.query.limit, { def: 20 });
  const cursor = req.query.cursor || null;
  const forceRefresh = req.query.force_refresh === 'true';
  const key = listKey({ limit, cursor });

  try {
    if (!forceRefresh) {
      const cached = await cacheGet(key);
      if (cached) return res.json(cached);
    }
    const data = await IAOrders.getAll({ limit, cursor });
    setImmediate(() => cacheSet(key, data));
    return res.json(data);
  } catch (err) {
    logger.error(`GET ia_orders error: ${err.message}`);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /:id ──────────────────────────────────────────────────
router.get('/:id', checkPermission('ia_orders', 'can_read'), async (req, res) => {
  try {
    const order = await IAOrders.getById(req.params.id);
    return res.json(order);
  } catch (err) {
    const status = err.message === 'Order not found' ? 404 : 500;
    return res.status(status).json({ error: err.message });
  }
});

// ── POST / ────────────────────────────────────────────────────
router.post('/', checkPermission('ia_orders', 'can_write'), async (req, res) => {
  try {
    const { customer_name, invoice_number, dispatch_date, notes, items } = req.body;
    const order = await IAOrders.create(
      { customer_name, invoice_number, dispatch_date, notes, items },
      req.io
    );
    setImmediate(() => invalidate());
    logger.info(`ia_order created: ${order.order_id} by user ${req.user.user_id}`);
    return res.status(201).json(order);
  } catch (err) {
    logger.error(`POST ia_orders error: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
});

// ── PUT /:id ──────────────────────────────────────────────────
router.put('/:id', checkPermission('ia_orders', 'can_write'), async (req, res) => {
  try {
    const { customer_name, invoice_number, dispatch_date, notes, items } = req.body;
    const order = await IAOrders.update(
      req.params.id,
      { customer_name, invoice_number, dispatch_date, notes, items },
      req.io
    );
    setImmediate(() => invalidate());
    logger.info(`ia_order updated: ${order.order_id} by user ${req.user.user_id}`);
    return res.json(order);
  } catch (err) {
    const status = err.message === 'Order not found' ? 404 : 400;
    logger.error(`PUT ia_orders/${req.params.id} error: ${err.message}`);
    return res.status(status).json({ error: err.message });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────
router.delete('/:id', checkPermission('ia_orders', 'can_delete'), async (req, res) => {
  try {
    const result = await IAOrders.delete(req.params.id, req.io);
    setImmediate(() => invalidate());
    logger.info(`ia_order deleted: ${result.order_id} by user ${req.user.user_id}`);
    return res.json({ message: 'Order deleted', order_id: result.order_id });
  } catch (err) {
    const status = err.message === 'Order not found' ? 404 : 500;
    return res.status(status).json({ error: err.message });
  }
});

module.exports = router;