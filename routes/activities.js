// routes/activities.js

const express = require('express');
const Activities = require('../models/activities');
const redis = require('../config/redis');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

// ------------------------ Utils --------------------------
const CACHE_TTL_SECONDS = 300;
const ACTIVITIES_PREFIX = 'activities_';

function toInt(v, { def = 10, min = 1, max = 100 } = {}) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return false;
  return v.toLowerCase() === 'true' || v === '1';
}

function listCacheKey({ limit, cursor }) {
  return cursor
    ? `${ACTIVITIES_PREFIX}list_${limit}_${cursor}`
    : `${ACTIVITIES_PREFIX}list_${limit}`;
}

function itemCacheKey(id) {
  return `${ACTIVITIES_PREFIX}${id}`;
}

async function invalidateActivitiesCache() {
  try {
    const keysToDelete = [];
    for await (const key of redis.scanIterator({
      MATCH: `${ACTIVITIES_PREFIX}*`,
      COUNT: 500,
    })) {
      keysToDelete.push(key);
      if (keysToDelete.length >= 500) {
        await redis.del(keysToDelete);
        keysToDelete.length = 0;
      }
    }
    if (keysToDelete.length) {
      await redis.del(keysToDelete);
    }
  } catch (e) {
    logger.warn(`Cache invalidation skipped: ${e.message}`);
  }
}

async function cacheGetJSON(key) {
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    logger.warn(`Redis GET failed: ${e.message}`);
    return null;
  }
}

async function cacheSetJSON(key, value, ttl = CACHE_TTL_SECONDS) {
  try {
    await redis.setEx(key, ttl, JSON.stringify(value));
  } catch (e) {
    logger.warn(`Redis SETEX failed: ${e.message}`);
  }
}

// ------------------------ Middleware -----------------------
router.use(authenticateToken, (req, res, next) => {
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

// ------------------------ Routes ---------------------------

// POST /api/activities
router.post('/', async (req, res) => {
  try {
    const { summary, status, assignee_ids, due_date, priority, comments } = req.body;

    if (!summary || !Array.isArray(assignee_ids) || assignee_ids.length === 0) {
      return res.status(400).json({ error: 'Summary and assignee_ids[] required' });
    }

    const activity = await Activities.create(
      { summary, status, assignee_ids, due_date, priority, comments },
      req.io
    );

    await invalidateActivitiesCache();
    logger.info(`Activity created: ${activity.id} by ${req.user.user_id}`);
    return res.status(201).json(activity);
  } catch (error) {
    logger.error(`Create error: ${error.message}`);
    return res.status(400).json({ error: error.message });
  }
});

// GET /api/activities
router.get('/', async (req, res) => {
  const limit = toInt(req.query.limit, { def: 10, min: 1, max: 100 });
  const cursor = req.query.cursor || null;
  const forceRefresh = toBool(req.query.force_refresh);
  const cacheKey = listCacheKey({ limit, cursor });

  try {
    if (!forceRefresh) {
      const cached = await cacheGetJSON(cacheKey);
      if (cached) return res.json(cached);
    } else {
      try { await redis.del(cacheKey); } catch (e) {
        logger.warn(`Redis DEL failed: ${e.message}`);
      }
    }

    const data = await Activities.getAll({ limit, cursor });
    await cacheSetJSON(cacheKey, data);
    return res.json(data); 
  } catch (error) {
    logger.error(`Get activities error: ${error.message}`);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/activities/:id
router.get('/:id', async (req, res) => {
  const id = req.params.id;
  const cacheKey = itemCacheKey(id);
  const forceRefresh = toBool(req.query.force_refresh);

  try {
    if (!forceRefresh) {
      const cached = await cacheGetJSON(cacheKey);
      if (cached) return res.json(cached);
    } else {
      try { await redis.del(cacheKey); } catch (e) {
        logger.warn(`Redis DEL failed: ${e.message}`);
      }
    }

    const activity = await Activities.getById(id);
    await cacheSetJSON(cacheKey, activity);
    return res.json(activity);
  } catch (error) {
    const status = error.message === 'Activity not found' ? 404 : 500;
    if (status === 500) logger.error(`Get activity ${id} error: ${error.message}`);
    return res.status(status).json({ error: error.message });
  }
});

// PUT /api/activities/:id
router.put('/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const { summary, status, assignee_ids, due_date, priority, comments } = req.body;
    const activity = await Activities.update(
      id,
      { summary, status, assignee_ids, due_date, priority, comments },
      req.io
    );

    await invalidateActivitiesCache();
    logger.info(`Activity updated: ${activity.id}`);
    return res.json(activity);
  } catch (error) {
    const status = error.message === 'Activity not found' ? 404 : 400;
    return res.status(status).json({ error: error.message });
  }
});

// DELETE /api/activities/:id
router.delete('/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const activity = await Activities.delete(id, req.io);
    await invalidateActivitiesCache();
    logger.info(`Activity deleted: ${activity.id}`);
    return res.json({ message: 'Activity deleted', activity });
  } catch (error) {
    const status = error.message === 'Activity not found' ? 404 : 500;
    if (status === 500) logger.error(`Delete error: ${error.message}`);
    return res.status(status).json({ error: error.message });
  }
});

module.exports = router;