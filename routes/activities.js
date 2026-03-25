// routes/activities.js

const express = require('express');
const Activities = require('../models/activities');
const redis = require('../config/redis');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

// ── Role constants (mirrors model) ───────────────────────────
const ALLOWED_ROLES = [9, 10, 11, 12]; // employee, hr, ia_employee, ia_hr
const COM_EMPLOYEE_ROLE = 9;
const COM_HR_ROLE = 10;

// ======================== CONFIGURATION ========================
const CACHE_TTL_SECONDS = 300;
const ACTIVITIES_PREFIX = 'activities_';

// ======================== UTILITY FUNCTIONS ========================

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

function listCacheKey({ limit, cursor, userId, roleId }) {
  const base = cursor
    ? `${ACTIVITIES_PREFIX}list_${limit}_${encodeURIComponent(cursor)}`
    : `${ACTIVITIES_PREFIX}list_${limit}_initial`;
  // Compage employees get a personal cache key since results are user-specific
  return roleId === COM_EMPLOYEE_ROLE ? `${base}_user_${userId}` : `${base}_role_${roleId}`;
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
    if (keysToDelete.length) await redis.del(keysToDelete);
    logger.debug(`Cache invalidated: ${ACTIVITIES_PREFIX}*`);
  } catch (e) {
    logger.warn(`Cache invalidation skipped: ${e.message}`);
  }
}

async function cacheGetJSON(key) {
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    logger.warn(`Redis GET failed for ${key}: ${e.message}`);
    return null;
  }
}

async function cacheSetJSON(key, value, ttl = CACHE_TTL_SECONDS) {
  try {
    await redis.setEx(key, ttl, JSON.stringify(value));
  } catch (e) {
    logger.warn(`Redis SETEX failed for ${key}: ${e.message}`);
  }
}

// ======================== MIDDLEWARE ========================

router.use(authenticateToken, (req, res, next) => {
  // Only allow employee/hr/ia_employee/ia_hr roles
  if (!ALLOWED_ROLES.includes(req.user.role_id)) {
    return res.status(403).json({ error: 'Not authorized to access activities' });
  }
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

// ======================== ROUTES ========================

/**
 * POST /api/activities
 * Create a new activity
 * Compage employee (role 9) cannot create — HR only for Compage
 */
router.post('/', async (req, res) => {
  try {
    // Compage employee cannot create activities
    if (req.user.role_id === COM_EMPLOYEE_ROLE) {
      return res.status(403).json({ error: 'Employees cannot create activities' });
    }

    const { summary, status, assignee_ids, due_date, priority, comments } = req.body;

    if (!summary || !Array.isArray(assignee_ids) || assignee_ids.length === 0) {
      return res.status(400).json({ error: 'Summary and assignee_ids[] required' });
    }

    const activity = await Activities.create(
      { summary, status, assignee_ids, due_date, priority, comments },
      req.io
    );

    setImmediate(() => invalidateActivitiesCache());
    logger.info(`Activity created: ${activity.id} by user ${req.user.user_id} (org: ${activity.org})`);
    return res.status(201).json(activity);
  } catch (error) {
    logger.error(`Create activity error: ${error.message}`);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/activities
 * Get paginated list — filtered by org and role automatically
 */
router.get('/', async (req, res) => {
  const limit = toInt(req.query.limit, { def: 50, min: 1, max: 100 });
  const cursor = req.query.cursor || null;
  const forceRefresh = toBool(req.query.force_refresh);
  const cacheKey = listCacheKey({
    limit,
    cursor,
    userId: req.user.user_id,
    roleId: req.user.role_id,
  });

  try {
    if (!forceRefresh) {
      const cached = await cacheGetJSON(cacheKey);
      if (cached) {
        logger.debug(`Cache hit: ${cacheKey}`);
        return res.json(cached);
      }
    } else {
      try {
        await redis.del(cacheKey);
        logger.debug(`Cache cleared: ${cacheKey}`);
      } catch (e) {
        logger.warn(`Redis DEL failed: ${e.message}`);
      }
    }

    const data = await Activities.getAll({
      limit,
      cursor,
      requestingUser: {
        user_id: req.user.user_id,
        role_id: req.user.role_id,
      },
    });

    setImmediate(() => cacheSetJSON(cacheKey, data));
    logger.debug(`Activities fetched: ${data.data.length} items, total: ${data.total}`);
    return res.json(data);
  } catch (error) {
    logger.error(`Get activities error: ${error.message}`);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/activities/:id
 */
router.get('/:id', async (req, res) => {
  const id = req.params.id;
  const cacheKey = itemCacheKey(id);
  const forceRefresh = toBool(req.query.force_refresh);

  try {
    if (!forceRefresh) {
      const cached = await cacheGetJSON(cacheKey);
      if (cached) {
        logger.debug(`Cache hit: ${cacheKey}`);
        return res.json(cached);
      }
    } else {
      try {
        await redis.del(cacheKey);
      } catch (e) {
        logger.warn(`Redis DEL failed: ${e.message}`);
      }
    }

    const activity = await Activities.getById(id);
    setImmediate(() => cacheSetJSON(cacheKey, activity));
    return res.json(activity);
  } catch (error) {
    const status = error.message === 'Activity not found' ? 404 : 500;
    if (status === 500) logger.error(`Get activity ${id} error: ${error.message}`);
    return res.status(status).json({ error: error.message });
  }
});

/**
 * PUT /api/activities/:id
 * Compage employee: status update only
 * All other roles: full update
 */
router.put('/:id', async (req, res) => {
  const id = req.params.id;

  // Compage employee — status only, everything else stripped
  if (req.user.role_id === COM_EMPLOYEE_ROLE) {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ error: 'Only status updates are allowed' });
    }
    const VALID_STATUSES = ['todo', 'in_progress', 'done'];
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    try {
      const activity = await Activities.update(id, { status }, req.io);
      setImmediate(() => invalidateActivitiesCache());
      logger.info(`Activity ${id} status updated to "${status}" by employee ${req.user.user_id}`);
      return res.json(activity);
    } catch (error) {
      const statusCode = error.message === 'Activity not found' ? 404 : 400;
      logger.error(`Status update activity ${id} error: ${error.message}`);
      return res.status(statusCode).json({ error: error.message });
    }
  }

  try {
    const { summary, status, assignee_ids, due_date, priority, comments } = req.body;

    const activity = await Activities.update(
      id,
      { summary, status, assignee_ids, due_date, priority, comments },
      req.io
    );

    setImmediate(() => invalidateActivitiesCache());
    logger.info(`Activity updated: ${activity.id} by user ${req.user.user_id}`);
    return res.json(activity);
  } catch (error) {
    const status = error.message === 'Activity not found' ? 404 : 400;
    logger.error(`Update activity ${id} error: ${error.message}`);
    return res.status(status).json({ error: error.message });
  }
});

/**
 * DELETE /api/activities/:id
 * Compage employee cannot delete
 */
router.delete('/:id', async (req, res) => {
  if (req.user.role_id === COM_EMPLOYEE_ROLE) {
    return res.status(403).json({ error: 'Employees cannot delete activities' });
  }

  const id = req.params.id;
  try {
    const activity = await Activities.delete(id, req.io);
    setImmediate(() => invalidateActivitiesCache());
    logger.info(`Activity deleted: ${activity.id} by user ${req.user.user_id}`);
    return res.json({ message: 'Activity deleted', activity });
  } catch (error) {
    const status = error.message === 'Activity not found' ? 404 : 500;
    if (status === 500) logger.error(`Delete activity ${id} error: ${error.message}`);
    return res.status(status).json({ error: error.message });
  }
});

module.exports = router;