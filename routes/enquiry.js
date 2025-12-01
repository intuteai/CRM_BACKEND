// routes/enquiry.js
const express = require('express');
const Enquiry = require('../models/enquiry');
const redis = require('../config/redis');
const pool = require('../config/db'); // needed for watchers/templates/read receipts
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

/**
 * Helper to delete redis keys by pattern safely
 */
async function deleteByPattern(pattern) {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(keys);
  }
}

// ===================================================================
// GET COMMENT TEMPLATES  ✅ MUST BE BEFORE /:id
// ===================================================================
router.get(
  '/templates',
  authenticateToken,
  checkPermission('Enquiries', 'can_read'),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, title, content
         FROM comment_templates
         WHERE is_global = true
         ORDER BY title`
      );
      res.json(result.rows);
    } catch (err) {
      logger.error('Get templates error:', err);
      res.status(500).json({ error: 'Failed to fetch templates' });
    }
  }
);

// ===================================================================
// REFRESH ALL ENQUIRY CACHES (admin-level)
// ===================================================================
router.post(
  '/refresh',
  authenticateToken,
  checkPermission('Enquiries', 'can_read'),
  async (req, res) => {
    try {
      await deleteByPattern('enquiry_*');
      await deleteByPattern('enquiry_list_*');

      logger.info(`Enquiry caches invalidated by ${req.user.user_id}`);
      res.json({ message: 'Enquiry caches invalidated successfully' });
    } catch (error) {
      logger.error(
        `Error invalidating enquiry caches: ${error.message}`,
        error.stack
      );
      res
        .status(500)
        .json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// ===================================================================
// CREATE NEW ENQUIRY (old + new fields, with lead)
// ===================================================================
router.post(
  '/',
  authenticateToken,
  checkPermission('Enquiries', 'can_write'),
  async (req, res) => {
    try {
      const {
        // old fields
        enquiry_id,
        company_name,
        contact_person,
        mail_id,
        phone_no,
        items_required,
        status,
        last_discussion,
        next_interaction,

        // new fields
        source = 'Website',
        lead,
        priority, // legacy support
        tags = [],
        assigned_to,
        due_date,
      } = req.body;

      if (!company_name?.trim()) {
        return res
          .status(400)
          .json({ error: 'Company name is required', code: 'INVALID_INPUT' });
      }

      const enquiry = await Enquiry.create(
        {
          enquiry_id,
          company_name: company_name.trim(),
          contact_person: contact_person?.trim() || null,
          mail_id: mail_id?.trim() || null,
          phone_no: phone_no?.trim() || null,
          items_required: items_required?.trim() || null,
          status,
          last_discussion,
          next_interaction,
          source,
          lead,
          priority,
          tags,
          assigned_to: assigned_to || null,
          due_date: due_date || null,
        },
        req.io,
        req.user
      );

      // Invalidate all enquiry list caches (for all users)
      await deleteByPattern('enquiry_list_*');

      logger.info(
        `Enquiry created: ${enquiry.enquiry_id} by ${req.user.user_id}`
      );
      res.status(201).json(enquiry);
    } catch (error) {
      if (error.code === '23505') {
        return res.status(400).json({
          error: 'Enquiry ID already exists',
          code: 'DUPLICATE_ENQUIRY_ID',
        });
      }
      logger.error(`Error creating enquiry: ${error.message}`, error.stack);
      res
        .status(500)
        .json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// ===================================================================
// GET ALL ENQUIRIES (role-based + per-user cache)
// ===================================================================
router.get(
  '/',
  authenticateToken,
  checkPermission('Enquiries', 'can_read'),
  async (req, res) => {
    const { limit = 10, offset = 0, force_refresh = 'false' } = req.query;
    const parsedLimit = parseInt(limit, 10) || 10;
    const parsedOffset = parseInt(offset, 10) || 0;

    // Cache key includes user_id because visibility is role-based
    const cacheKey = `enquiry_list_${req.user.user_id}_${parsedLimit}_${parsedOffset}`;

    try {
      if (force_refresh === 'true') {
        await redis.del(cacheKey);
      }

      const cached = await redis.get(cacheKey);
      if (cached && force_refresh !== 'true') {
        logger.info(`Cache hit for ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }

      const enquiries = await Enquiry.getAll({
        limit: parsedLimit,
        // NOTE: model currently uses cursor; offset is used only in cache key
        user: req.user,
      });

      await redis.setEx(cacheKey, 300, JSON.stringify(enquiries)); // 5 minutes
      logger.info(`Fetched ${enquiries.data.length} enquiries`);
      res.json(enquiries);
    } catch (error) {
      logger.error(`Error fetching enquiries: ${error.message}`, error.stack);
      res
        .status(500)
        .json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
    }
  }
);

// ===================================================================
// GET SINGLE ENQUIRY + FULL ACTIVITY LOG (with cache)
// ===================================================================
router.get(
  '/:id',
  authenticateToken,
  checkPermission('Enquiries', 'can_read'),
  async (req, res) => {
    // Include user_id in key so one user's view isn't reused for another
    const cacheKey = `enquiry_${req.user.user_id}_${req.params.id}`;

    try {
      if (req.query.force_refresh === 'true') {
        await redis.del(cacheKey);
      }

      const cached = await redis.get(cacheKey);
      if (cached && req.query.force_refresh !== 'true') {
        logger.info(`Cache hit for ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }

      const enquiry = await Enquiry.getById(req.params.id, req.user);
      await redis.setEx(cacheKey, 300, JSON.stringify(enquiry));
      logger.info(`Fetched enquiry: ${enquiry.enquiry_id}`);
      res.json(enquiry);
    } catch (error) {
      logger.error(
        `Error fetching enquiry ${req.params.id}: ${error.message}`,
        error.stack
      );
      if (error.message === 'Forbidden') {
        return res.status(403).json({
          error: 'You do not have access to this enquiry',
          code: 'FORBIDDEN',
        });
      }
      const status = error.message === 'Enquiry not found' ? 404 : 500;
      const code =
        error.message === 'Enquiry not found' ? 'NOT_FOUND' : 'SERVER_ERROR';
      res.status(status).json({ error: error.message, code });
    }
  }
);

// ===================================================================
// UPDATE (includes lead, source, tags, due_date)
// ===================================================================
router.put(
  '/:id',
  authenticateToken,
  checkPermission('Enquiries', 'can_write'),
  async (req, res) => {
    try {
      const {
        company_name,
        contact_person,
        mail_id,
        phone_no,
        items_required,
        status,
        last_discussion,
        next_interaction,

        // NEW FIELDS – pass to model.update
        lead,
        priority, // legacy support
        source,
        tags,
        due_date,
      } = req.body;

      const enquiry = await Enquiry.update(
        req.params.id,
        {
          company_name,
          contact_person,
          mail_id,
          phone_no,
          items_required,
          status,
          last_discussion,
          next_interaction,
          lead,
          priority,
          source,
          tags,
          due_date,
        },
        req.io
      );

      // Invalidate this enquiry for ALL users + all lists
      await deleteByPattern(`enquiry_*_${req.params.id}`);
      await deleteByPattern('enquiry_list_*');

      logger.info(
        `Enquiry updated: ${enquiry.enquiry_id} by ${req.user.user_id}`
      );
      res.json(enquiry);
    } catch (error) {
      logger.error(
        `Error updating enquiry ${req.params.id}: ${error.message}`,
        error.stack
      );
      const status = error.message === 'Enquiry not found' ? 404 : 500;
      const code =
        error.message === 'Enquiry not found' ? 'NOT_FOUND' : 'SERVER_ERROR';
      res.status(status).json({ error: error.message, code });
    }
  }
);

// ===================================================================
// DELETE ENQUIRY (hard delete + clear activities)
// ===================================================================
router.delete(
  '/:id',
  authenticateToken,
  checkPermission('Enquiries', 'can_delete'),
  async (req, res) => {
    try {
      const enquiry = await Enquiry.delete(req.params.id, req.io);

      // Invalidate this enquiry for ALL users + all lists
      await deleteByPattern(`enquiry_*_${req.params.id}`);
      await deleteByPattern('enquiry_list_*');

      logger.info(
        `Enquiry deleted: ${enquiry.enquiry_id} by ${req.user.user_id}`
      );
      res.json({ message: 'Enquiry deleted successfully', enquiry });
    } catch (error) {
      logger.error(
        `Error deleting enquiry ${req.params.id}: ${error.message}`,
        error.stack
      );
      const status = error.message === 'Enquiry not found' ? 404 : 500;
      const code =
        error.message === 'Enquiry not found' ? 'NOT_FOUND' : 'SERVER_ERROR';
      res.status(status).json({ error: error.message, code });
    }
  }
);

// ===================================================================
// ASSIGN / ESCALATE TO SOMEONE
// ===================================================================
router.post(
  '/:id/assign',
  authenticateToken,
  checkPermission('Enquiries', 'can_write'),
  async (req, res) => {
    const { assigned_to, due_date, message } = req.body;

    if (!assigned_to) {
      return res
        .status(400)
        .json({ error: 'assigned_to is required', code: 'INVALID_INPUT' });
    }

    try {
      const enquiry = await Enquiry.assign(
        req.params.id,
        { assigned_to: parseInt(assigned_to, 10), due_date, message },
        req.io,
        req.user
      );

      // Clear detail cache for ALL users for this enquiry + all lists
      await deleteByPattern(`enquiry_*_${req.params.id}`);
      await deleteByPattern('enquiry_list_*');

      res.json(enquiry);
    } catch (err) {
      logger.error('Assign enquiry error:', err);
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ===================================================================
// ADD COMMENT / @MENTION
// ===================================================================
router.post(
  '/:id/comment',
  authenticateToken,
  checkPermission('Enquiries', 'can_write'),
  async (req, res) => {
    const { message, mentions = [], expected_by, is_internal = false } =
      req.body;

    if (!message?.trim()) {
      return res
        .status(400)
        .json({ error: 'Message is required', code: 'INVALID_INPUT' });
    }

    try {
      const activity = await Enquiry.addComment(
        req.params.id,
        {
          message: message.trim(),
          mentions: Array.isArray(mentions) ? mentions : [],
          expected_by,
          is_internal,
        },
        req.io,
        req.user
      );

      res.json(activity);
    } catch (err) {
      logger.error('Add comment error:', err);
      res.status(400).json({ error: err.message });
    }
  }
);

// ===================================================================
// CHANGE STAGE (close won, regret, etc.)
// ===================================================================
router.patch(
  '/:id/stage',
  authenticateToken,
  checkPermission('Enquiries', 'can_write'),
  async (req, res) => {
    const { stage, note } = req.body;

    if (
      ![
        'closed_won',
        'closed_lost',
        'regret',
        'in_discussion',
        'design_review',
        'admin_review',
      ].includes(stage)
    ) {
      return res.status(400).json({ error: 'Invalid stage' });
    }

    try {
      const enquiry = await Enquiry.changeStage(
        req.params.id,
        { stage, note },
        req.io,
        req.user
      );

      // Clear detail cache for ALL users + all list caches
      await deleteByPattern(`enquiry_*_${req.params.id}`);
      await deleteByPattern('enquiry_list_*');

      res.json(enquiry);
    } catch (err) {
      logger.error('Change stage error:', err);
      res.status(400).json({ error: err.message });
    }
  }
);

// ===================================================================
// FOLLOW / UNFOLLOW ENQUIRY
// ===================================================================
router.post(
  '/:id/follow',
  authenticateToken,
  checkPermission('Enquiries', 'can_read'),
  async (req, res) => {
    try {
      await pool.query(
        `INSERT INTO enquiry_watchers (enquiry_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (enquiry_id, user_id) DO NOTHING`,
        [req.params.id, req.user.user_id]
      );
      res.json({ success: true });
    } catch (err) {
      logger.error('Follow enquiry error:', err);
      res.status(500).json({ error: 'Failed' });
    }
  }
);

router.delete(
  '/:id/follow',
  authenticateToken,
  checkPermission('Enquiries', 'can_read'),
  async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM enquiry_watchers
         WHERE enquiry_id = $1 AND user_id = $2`,
        [req.params.id, req.user.user_id]
      );
      res.json({ success: true });
    } catch (err) {
      logger.error('Unfollow enquiry error:', err);
      res.status(500).json({ error: 'Failed' });
    }
  }
);

// ===================================================================
// MARK ACTIVITY AS READ (read receipts)
// ===================================================================
router.post(
  '/:enquiryId/activity/:activityId/read',
  authenticateToken,
  checkPermission('Enquiries', 'can_read'),
  async (req, res) => {
    try {
      await pool.query(
        `INSERT INTO enquiry_read_receipts (activity_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (activity_id, user_id)
         DO UPDATE SET read_at = NOW()`,
        [req.params.activityId, req.user.user_id]
      );
      res.json({ success: true });
    } catch (err) {
      logger.error('Mark activity read error:', err);
      res.status(500).json({ error: 'Failed' });
    }
  }
);

module.exports = router;
