const express = require('express');
const DispatchTracking = require('../models/dispatchTracking');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

router.get('/', authenticateToken, checkPermission('DispatchTracking', 'can_read'), async (req, res) => {
  const { limit = 10, offset = 0, force_refresh = false } = req.query;
  const cacheKey = `dispatch_tracking_${limit}_${offset}`;

  try {
    if (force_refresh === 'true') await redis.del(cacheKey);

    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const dispatchTracking = await DispatchTracking.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
    await redis.setEx(cacheKey, 300, JSON.stringify(dispatchTracking));
    res.json(dispatchTracking);
  } catch (error) {
    logger.error(`Error fetching dispatch tracking details: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
});

router.put('/:trackingId', authenticateToken, checkPermission('DispatchTracking', 'can_write'), async (req, res) => {
  const { trackingId } = req.params;
  const { order_id, docket_number, dispatch_date, delivery_date, status } = req.body;

  if (!trackingId) {
    return res.status(400).json({ error: 'Tracking ID is required', code: 'INVALID_INPUT' });
  }

  try {
    const updatedDispatch = await DispatchTracking.update(trackingId, {
      order_id,
      docket_number,
      dispatch_date,
      delivery_date,
      status,
    });

    if (!updatedDispatch) {
      return res.status(404).json({ error: 'Dispatch tracking entry not found', code: 'NOT_FOUND' });
    }

    await redis.del(`dispatch_tracking_*`);
    req.io.emit('dispatchUpdate');
    res.json(updatedDispatch);
  } catch (error) {
    logger.error(`Error updating dispatch tracking: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message, code: 'INVALID_INPUT' });
  }
});

router.delete('/:trackingId', authenticateToken, checkPermission('DispatchTracking', 'can_delete'), async (req, res) => {
  const { trackingId } = req.params;
  try {
    const deleted = await DispatchTracking.delete(trackingId);
    if (!deleted) {
      return res.status(404).json({ error: 'Dispatch tracking entry not found', code: 'NOT_FOUND' });
    }
    await redis.del(`dispatch_tracking_*`);
    req.io.emit('dispatchUpdate');
    res.status(204).send();
  } catch (error) {
    logger.error(`Error deleting dispatch tracking: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message, code: 'INVALID_INPUT' });
  }
});

module.exports = router;