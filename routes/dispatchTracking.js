const express = require('express');
const DispatchTracking = require('../models/dispatchTracking');
const redis = require('../config/redis');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

const ensureAdmin = (req, res, next) => {
  if (req.user.role_id !== 1) {
    return res.status(403).json({ error: 'Access restricted to admin only' });
  }
  next();
};

// GET all dispatch tracking details
router.get('/', authenticateToken, ensureAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PUT update an existing dispatch tracking entry
router.put('/:trackingId', authenticateToken, ensureAdmin, async (req, res) => {
  const { trackingId } = req.params;
  const { order_id, docket_number, dispatch_date, delivery_date, status } = req.body;

  // Basic validation
  if (!trackingId) {
    return res.status(400).json({ error: 'Tracking ID is required' });
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
      return res.status(404).json({ error: 'Dispatch tracking entry not found' });
    }

    await redis.del(`dispatch_tracking_*`); // Invalidate cache
    req.io.emit('dispatchUpdate'); // Emit event for real-time updates
    res.json(updatedDispatch);
  } catch (error) {
    logger.error(`Error updating dispatch tracking: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message });
  }
});

// DELETE a dispatch tracking entry
router.delete('/:trackingId', authenticateToken, ensureAdmin, async (req, res) => {
  const { trackingId } = req.params;
  try {
    const deleted = await DispatchTracking.delete(trackingId);
    if (!deleted) {
      return res.status(404).json({ error: 'Dispatch tracking entry not found' });
    }
    await redis.del(`dispatch_tracking_*`); // Invalidate cache
    req.io.emit('dispatchUpdate'); // Emit event for real-time updates
    res.status(204).send();
  } catch (error) {
    logger.error(`Error deleting dispatch tracking: ${error.message}`, error.stack);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;